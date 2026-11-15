// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { type SqlStatement, type StoragePort, stmt } from "../../src/db/port.js";
import {
  FAILED_OUTCOME,
  type HeldRunners,
  HOLD_MS,
  heldOn,
  holdAction,
  PASS_LIMIT,
  runDueHeld,
  undoHeld,
} from "../../src/held.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { createThread, findThreadForMember, leaveThread } from "../../src/plans/thread.js";
import { eraseAccount } from "../../src/privacy/erasure.js";
import { exportPerson } from "../../src/privacy/export.js";
import { purge, retentionPass } from "../../src/privacy/purge.js";

// A minute to take it back (DESIGN §10 *Asking when*, rc46) on BOTH drivers: an action waits
// its minute, Undo works exactly until a pass takes it, a pass runs each one at most once, and
// what happened is shown for a day and then goes — with its thread, its actor, or its day.

const T0 = "2101-12-01T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** Counts writes, so the empty pass is checked to write nothing (§6). */
function counting(port: StoragePort): StoragePort & { writes: number } {
  const counted = {
    writes: 0,
    query: (s: SqlStatement) => {
      if (!/^\s*SELECT/i.test(s.sql)) counted.writes += 1;
      return port.query(s);
    },
    batch: (s: readonly SqlStatement[]) => {
      counted.writes += s.length;
      return port.batch(s);
    },
  };
  return counted;
}

async function setUp(makePort: () => Promise<StoragePort>, tag: string) {
  const port = counting(await makePort());
  const ann = await findOrCreatePerson(port, `held-ann-${tag}@example.org`, { now: T0 });
  const bob = await findOrCreatePerson(port, `held-bob-${tag}@example.org`, { now: T0 });
  const thread = await createThread(port, {
    name: `Picnic ${tag}`,
    tzid: "Europe/Prague",
    creatorId: ann.id,
    memberIds: [bob.id],
    now: T0,
  });
  const ran: string[] = [];
  const runners: HeldRunners = {
    vote_links: (a) => {
      ran.push(a.id);
      return Promise.resolve(`ran ${a.id} at ${a.now}`);
    },
  };
  const hold = (actorId = ann.id) =>
    holdAction(port, { actorId, threadId: thread.id, kind: "vote_links", now: T0 });
  const count = async () =>
    (
      await port.query(stmt("SELECT count(*) AS n FROM held_action WHERE thread_id = ?", thread.id))
    )[0]?.n;
  return { port, ann: ann.id, bob: bob.id, thread: thread.id, ran, runners, hold, count };
}

export function runHeldContract(makePort: () => Promise<StoragePort>): void {
  describe("a minute to take it back (rc46)", () => {
    it("an action waits its minute; pressing again while it waits holds nothing new", async () => {
      const t = await setUp(makePort, "wait");
      const first = await t.hold();
      expect(first).toMatchObject({
        kind: "vote_links",
        threadId: t.thread,
        dueAt: at(HOLD_MS),
        takenAt: null,
        outcome: null,
      });
      expect((await t.hold()).id).toBe(first.id); // a double press can't mail twice
      expect((await t.hold(t.bob)).id).not.toBe(first.id); // someone else's is their own
      expect(await t.count()).toBe(2);

      expect(await runDueHeld(t.port, t.runners, at(HOLD_MS - 1))).toBe(0); // not yet
      expect(t.ran).toEqual([]);
      // D1 shares one database across a file's tests: leave nothing due for the next one.
      expect(await undoHeld(t.port, { id: first.id, actorId: t.ann })).toBe("undone");
      await t.port.batch([
        stmt("DELETE FROM held_action WHERE thread_id = ? AND taken_at IS NULL", t.thread),
      ]);
    });

    it("Undo works until a pass takes it, then says too late; only its actor's", async () => {
      const t = await setUp(makePort, "undo");
      const a = await t.hold();
      expect(await undoHeld(t.port, { id: a.id, actorId: t.bob })).toBe("absent");
      expect(await undoHeld(t.port, { id: a.id, actorId: t.ann })).toBe("undone");
      expect(await undoHeld(t.port, { id: a.id, actorId: t.ann })).toBe("absent");
      expect(await runDueHeld(t.port, t.runners, at(HOLD_MS))).toBe(0);
      expect(t.ran).toEqual([]); // undone, never run

      const b = await t.hold();
      expect(await runDueHeld(t.port, t.runners, at(HOLD_MS))).toBe(1);
      expect(await undoHeld(t.port, { id: b.id, actorId: t.ann })).toBe("too_late");
      expect(
        await heldOn(t.port, { actorId: t.ann, threadId: t.thread, now: at(HOLD_MS) }),
      ).toEqual([{ ...b, takenAt: at(HOLD_MS), outcome: `ran ${b.id} at ${at(HOLD_MS)}` }]);
    });

    it("a pass runs each at most once, oldest first, at most PASS_LIMIT; with nothing due it writes nothing", async () => {
      const t = await setUp(makePort, "once");
      const writes = t.port.writes;
      expect(await runDueHeld(t.port, t.runners, at(HOLD_MS))).toBe(0);
      expect(t.port.writes).toBe(writes); // §6: one read, no write

      const people = [t.ann];
      for (let i = 0; i < PASS_LIMIT; i++)
        people.push((await findOrCreatePerson(t.port, `held-p${i}@example.org`, { now: T0 })).id);
      const held = [];
      for (const [i, p] of people.entries())
        held.push(
          await holdAction(t.port, {
            actorId: p,
            threadId: t.thread,
            kind: "vote_links",
            now: at(i),
          }),
        );
      // Two passes at once, as overlapping crons would be: each action runs exactly once.
      const [x, y] = await Promise.all([
        runDueHeld(t.port, t.runners, at(HOLD_MS + PASS_LIMIT)),
        runDueHeld(t.port, t.runners, at(HOLD_MS + PASS_LIMIT)),
      ]);
      expect((x ?? 0) + (y ?? 0)).toBe(PASS_LIMIT);
      expect(new Set(t.ran).size).toBe(PASS_LIMIT);
      expect(t.ran).toEqual(expect.arrayContaining(held.slice(0, PASS_LIMIT).map((h) => h.id)));
      expect(await runDueHeld(t.port, t.runners, at(HOLD_MS + PASS_LIMIT))).toBe(1); // the rest
      expect(t.ran.at(-1)).toBe(held.at(-1)?.id);
    });

    it("a runner that throws is reported in the pass's own words, never its error's", async () => {
      const t = await setUp(makePort, "throws");
      const a = await t.hold();
      const failing: HeldRunners = {
        vote_links: () => Promise.reject(new Error("Dinner at Ann's, token abc")),
      };
      expect(await runDueHeld(t.port, failing, at(HOLD_MS))).toBe(1);
      const [shown] = await heldOn(t.port, {
        actorId: t.ann,
        threadId: t.thread,
        now: at(HOLD_MS),
      });
      expect(shown).toMatchObject({ id: a.id, outcome: FAILED_OUTCOME });
      expect(await runDueHeld(t.port, t.runners, at(2 * HOLD_MS))).toBe(0); // not tried again
    });

    it("what happened shows for a day, then the purge pass removes it", async () => {
      const t = await setUp(makePort, "day");
      await t.hold();
      await runDueHeld(t.port, t.runners, at(HOLD_MS));
      const shownAt = (ms: number) =>
        heldOn(t.port, { actorId: t.ann, threadId: t.thread, now: at(ms) });
      expect(await shownAt(HOLD_MS + DAY)).toHaveLength(1); // exactly a day still shows
      expect(await shownAt(HOLD_MS + DAY + 1)).toEqual([]);
      await retentionPass(t.port, at(HOLD_MS + DAY));
      expect(await t.count()).toBe(1); // kept while it may still be shown
      await retentionPass(t.port, at(HOLD_MS + DAY + 1));
      expect(await t.count()).toBe(0);
    });

    it("leaving the thread, deleting the account, or the thread going takes them along", async () => {
      const t = await setUp(makePort, "gone");
      await t.hold(t.bob);
      await t.hold(t.ann);
      const bobs = await findThreadForMember(t.port, t.thread, t.bob);
      if (bobs === null) throw new Error("member");
      await leaveThread(t.port, bobs, at(1));
      expect(await t.count()).toBe(1); // only Ann's is left

      const exported = await exportPerson(t.port, t.ann, at(1));
      expect(exported.held_actions).toEqual([
        {
          action: "email vote links",
          plan: "Picnic gone",
          due_at: at(HOLD_MS),
          ran_at: null,
          what_happened: null,
        },
      ]);
      await eraseAccount(t.port, t.ann, { now: at(2) });
      expect(await t.count()).toBe(0);

      const u = await setUp(makePort, "purged");
      await u.hold();
      expect((await purge(u.port, "thread", u.thread, at(1))).kind).toBe("purged");
      expect(await u.count()).toBe(0);
    });
  });
}
