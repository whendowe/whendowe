// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { type StoragePort, stmt } from "../../src/db/port.js";
import { PollInputError } from "../../src/events/poll.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import {
  ASK_DRAFT_KEEP_DAYS,
  type AskBody,
  askDraft,
  discardAskDraft,
  EMPTY_ASK,
  findAskDraft,
  listAskDrafts,
  saveAskDraft,
  startAskDraft,
} from "../../src/plans/ask.js";
import { listPlans } from "../../src/plans/plan.js";
import { findThreadForMember } from "../../src/plans/thread.js";
import { eraseAccount } from "../../src/privacy/erasure.js";
import { exportPerson } from "../../src/privacy/export.js";
import { retentionPass } from "../../src/privacy/purge.js";

// An unsent Ask when question (DESIGN §10 *Asking when*, rc46, A2) on BOTH drivers: only its
// author ever finds it; every save is the whole body, checked; asking makes the thread and its
// options in order — several events and mixed kinds allowed — and the draft goes, once.

const T0 = "2101-12-01T10:00:00.000Z";
const T1 = "2101-12-01T11:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

const BODY: AskBody = {
  title: "Teambuilding",
  location: "Somewhere nice",
  note: null,
  tzid: "Europe/Prague",
  options: [
    [{ allDay: true, startLocal: "2101-12-04", endLocal: "2101-12-07" }], // A: a weekend away
    [{ allDay: false, startLocal: "2101-12-10T19:00", endLocal: "2101-12-10T22:00" }], // B
    [
      { allDay: false, startLocal: "2101-12-11T19:00", endLocal: "2101-12-11T22:00" },
      { allDay: true, startLocal: "2101-12-12", endLocal: "2101-12-13" },
    ], // C: a dinner and a hike
  ],
  emails: [],
};

async function people(port: StoragePort, tag: string) {
  const ann = await findOrCreatePerson(port, `ask-ann-${tag}@example.org`, { now: T0 });
  const bob = await findOrCreatePerson(port, `ask-bob-${tag}@example.org`, { now: T0 });
  return { ann: ann.id, bob: bob.id, bobEmail: `ask-bob-${tag}@example.org` };
}

export function runAskContract(makePort: () => Promise<StoragePort>): void {
  describe("an unsent question (rc46, A2)", () => {
    it("only its author finds, saves, lists or discards it", async () => {
      const port = await makePort();
      const p = await people(port, "own");
      const d = await startAskDraft(port, { authorId: p.ann, groupId: null, now: T0 });
      if (d === null) throw new Error("draft");
      expect(d.body).toEqual(EMPTY_ASK);
      expect(await findAskDraft(port, { id: d.id, authorId: p.bob })).toBeNull();
      expect(await saveAskDraft(port, { id: d.id, authorId: p.bob, body: BODY, now: T1 })).toBe(
        false,
      );
      expect(await saveAskDraft(port, { id: d.id, authorId: p.ann, body: BODY, now: T1 })).toBe(
        true,
      );
      expect(await findAskDraft(port, { id: d.id, authorId: p.ann })).toEqual({
        id: d.id,
        groupId: null,
        body: BODY,
        updatedAt: T1,
      });
      const e = await startAskDraft(port, { authorId: p.ann, groupId: null, now: T0 });
      // Most recently touched first; Bob has none.
      expect((await listAskDrafts(port, p.ann)).map((x) => x.id)).toEqual([d.id, e?.id]);
      expect(await listAskDrafts(port, p.bob)).toEqual([]);
      expect(await discardAskDraft(port, { id: d.id, authorId: p.bob })).toBe(false);
      expect(await discardAskDraft(port, { id: d.id, authorId: p.ann })).toBe(true);
      expect(await findAskDraft(port, { id: d.id, authorId: p.ann })).toBeNull();
    });

    it("a body is checked on every save; a group must be the author's", async () => {
      const port = await makePort();
      const p = await people(port, "check");
      const d = await startAskDraft(port, { authorId: p.ann, groupId: null, now: T0 });
      if (d === null) throw new Error("draft");
      const tooMany = { ...BODY, options: Array.from({ length: 11 }, () => BODY.options[1] ?? []) };
      await expect(
        saveAskDraft(port, { id: d.id, authorId: p.ann, body: tooMany, now: T1 }),
      ).rejects.toThrow();
      expect((await findAskDraft(port, { id: d.id, authorId: p.ann }))?.body).toEqual(EMPTY_ASK);
      const g = await createGroup(port, { name: "Bob's", creatorId: p.bob, now: T0 });
      expect(await startAskDraft(port, { authorId: p.ann, groupId: g.id, now: T0 })).toBeNull();
      expect(
        (await startAskDraft(port, { authorId: p.bob, groupId: g.id, now: T0 }))?.groupId,
      ).toBe(g.id);
      expect(await findGroupForMember(port, g.id, p.bob)).not.toBeNull();
    });

    it("asking makes the thread: options in order, several events and mixed kinds, the people; the draft goes", async () => {
      const port = await makePort();
      const p = await people(port, "ask");
      const d = await startAskDraft(port, { authorId: p.ann, groupId: null, now: T0 });
      if (d === null) throw new Error("draft");
      await saveAskDraft(port, {
        id: d.id,
        authorId: p.ann,
        body: { ...BODY, emails: [p.bobEmail] },
        now: T0,
      });
      const asked = await askDraft(port, { id: d.id, authorId: p.ann, now: T1 });
      if (asked === null) throw new Error("asked");
      const access = await findThreadForMember(port, asked.threadId, p.bob);
      if (access === null) throw new Error("Bob is in it");
      expect(access.thread.name).toBe("Teambuilding");
      const plans = await listPlans(port, access);
      expect(plans.map((x) => [x.letter, x.status, x.events.length])).toEqual([
        ["A", "on_table", 1],
        ["B", "on_table", 1],
        ["C", "on_table", 2],
      ]);
      expect(plans[2]?.events.map((e) => [e.allDay, e.startLocal, e.location])).toEqual([
        [false, "2101-12-11T19:00:00", "Somewhere nice"],
        [true, "2101-12-12", "Somewhere nice"],
      ]);
      // The asker's yes to every option, as a poll's creator's.
      expect(
        plans.every((x) => x.votes.some((v) => v.personId === p.ann && v.answer === "yes")),
      ).toBe(true);
      expect(await findAskDraft(port, { id: d.id, authorId: p.ann })).toBeNull();
      expect(await askDraft(port, { id: d.id, authorId: p.ann, now: T1 })).toBeNull(); // once
    });

    it("two asks at once make one thread; a refused one keeps the draft", async () => {
      const port = await makePort();
      const p = await people(port, "race");
      const d = await startAskDraft(port, { authorId: p.ann, groupId: null, now: T0 });
      if (d === null) throw new Error("draft");
      await saveAskDraft(port, { id: d.id, authorId: p.ann, body: BODY, now: T0 });
      const [x, y] = await Promise.all([
        askDraft(port, { id: d.id, authorId: p.ann, now: T1 }),
        askDraft(port, { id: d.id, authorId: p.ann, now: T1 }),
      ]);
      expect([x, y].filter((r) => r !== null)).toHaveLength(1);
      const threads = await port.query(
        stmt("SELECT count(*) AS n FROM plan_thread WHERE organizer_id = ?", p.ann),
      );
      expect(threads[0]?.n).toBe(1);

      const e = await startAskDraft(port, { authorId: p.ann, groupId: null, now: T0 });
      if (e === null) throw new Error("draft");
      await saveAskDraft(port, {
        id: e.id,
        authorId: p.ann,
        body: { ...BODY, options: [BODY.options[1] ?? [], BODY.options[1] ?? []] },
        now: T0,
      });
      await expect(askDraft(port, { id: e.id, authorId: p.ann, now: T1 })).rejects.toThrow(
        PollInputError,
      ); // two options the same
      expect(await findAskDraft(port, { id: e.id, authorId: p.ann })).not.toBeNull();
      await saveAskDraft(port, { id: e.id, authorId: p.ann, body: EMPTY_ASK, now: T0 });
      await expect(askDraft(port, { id: e.id, authorId: p.ann, now: T1 })).rejects.toThrow(
        PollInputError,
      ); // nothing offered
      expect(await findAskDraft(port, { id: e.id, authorId: p.ann })).not.toBeNull();
    });

    it("a group's question takes its people; one whose group is no longer theirs isn't asked", async () => {
      const port = await makePort();
      const p = await people(port, "group");
      const g = await createGroup(port, { name: "Table", creatorId: p.ann, now: T0 });
      const d = await startAskDraft(port, { authorId: p.ann, groupId: g.id, now: T0 });
      if (d === null) throw new Error("draft");
      await saveAskDraft(port, { id: d.id, authorId: p.ann, body: BODY, now: T0 });
      const asked = await askDraft(port, { id: d.id, authorId: p.ann, now: T1 });
      const access = await findThreadForMember(port, asked?.threadId ?? "", p.ann);
      expect(access?.thread.groupId).toBe(g.id);

      const e = await startAskDraft(port, { authorId: p.ann, groupId: g.id, now: T0 });
      if (e === null) throw new Error("draft");
      await saveAskDraft(port, { id: e.id, authorId: p.ann, body: BODY, now: T0 });
      await port.batch([
        stmt("DELETE FROM group_member WHERE group_id = ? AND person_id = ?", g.id, p.ann),
      ]);
      expect(await askDraft(port, { id: e.id, authorId: p.ann, now: T1 })).toBeNull();
      expect(await findAskDraft(port, { id: e.id, authorId: p.ann })).not.toBeNull(); // kept
    });

    it("a row that no longer reads as a question is skipped, not a crash", async () => {
      const port = await makePort();
      const p = await people(port, "corrupt");
      const good = await startAskDraft(port, { authorId: p.ann, groupId: null, now: T0 });
      for (const [id, body] of [
        ["bad-json", "{not json"],
        ["bad-shape", JSON.stringify({ title: 7 })],
      ] as const)
        await port.batch([
          stmt(
            `INSERT INTO ask_draft (id, author_id, group_id, body, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?, ?)`,
            `${id}-${p.ann}`,
            p.ann,
            body,
            T0,
            T0,
          ),
        ]);
      expect((await listAskDrafts(port, p.ann)).map((d) => d.id)).toEqual([good?.id]);
      expect(await findAskDraft(port, { id: `bad-json-${p.ann}`, authorId: p.ann })).toBeNull();
    });

    it("if writing the thread fails, the draft is put back as it was", async () => {
      const inner = await makePort();
      let fail = true;
      const port: StoragePort = {
        query: (s) => inner.query(s),
        batch: (s) =>
          fail && s.some((x) => x.sql.includes("INSERT INTO plan_thread "))
            ? Promise.reject(new Error("disk full"))
            : inner.batch(s),
      };
      const p = await people(port, "restore");
      const d = await startAskDraft(port, { authorId: p.ann, groupId: null, now: T0 });
      if (d === null) throw new Error("draft");
      await saveAskDraft(port, { id: d.id, authorId: p.ann, body: BODY, now: T1 });
      await expect(askDraft(port, { id: d.id, authorId: p.ann, now: T1 })).rejects.toThrow(
        "disk full",
      );
      expect(await findAskDraft(port, { id: d.id, authorId: p.ann })).toEqual({
        id: d.id,
        groupId: null,
        body: BODY,
        updatedAt: T1,
      });
      fail = false;
      expect(await askDraft(port, { id: d.id, authorId: p.ann, now: T1 })).not.toBeNull();
    });

    it(`untouched for ${ASK_DRAFT_KEEP_DAYS} days it goes; the export has it; erasing takes it`, async () => {
      const port = await makePort();
      const p = await people(port, "keep");
      const d = await startAskDraft(port, { authorId: p.ann, groupId: null, now: T0 });
      if (d === null) throw new Error("draft");
      await saveAskDraft(port, { id: d.id, authorId: p.ann, body: BODY, now: T0 });
      const exported = await exportPerson(port, p.ann, T0);
      expect(exported.unsent_questions).toEqual([{ ...BODY, last_changed: T0 }]);
      await retentionPass(port, at(ASK_DRAFT_KEEP_DAYS * DAY));
      expect(await findAskDraft(port, { id: d.id, authorId: p.ann })).not.toBeNull();
      await retentionPass(port, at(ASK_DRAFT_KEEP_DAYS * DAY + 1));
      expect(await findAskDraft(port, { id: d.id, authorId: p.ann })).toBeNull();

      const e = await startAskDraft(port, { authorId: p.bob, groupId: null, now: T0 });
      await eraseAccount(port, p.bob, { now: T1 });
      expect(
        await port.query(stmt("SELECT 1 AS ok FROM ask_draft WHERE id = ?", e?.id ?? "")),
      ).toEqual([]);
    });
  });
}
