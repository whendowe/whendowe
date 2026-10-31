// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  type EventAccess,
  editEvent,
  findEventForParticipant,
  listHistory,
} from "../../src/events/event.js";
import {
  type Answer,
  type CandidateTimeInput,
  confirmCandidate,
  createPoll,
  pollResults,
  vote,
} from "../../src/events/poll.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";

// Time polls on BOTH drivers. The vote statement leans on json_each, an upsert over
// INSERT … SELECT and RETURNING — exactly the SQLite surface where D1 and libsql
// could differ, so it is proven on each. Residue-tolerant: every test uses its own people.

const T0 = "2101-10-01T10:00:00.000Z";
const T1 = "2101-10-01T11:00:00.000Z";

const BASE = {
  title: "Session 13",
  description: null,
  location: null,
  allDay: false,
  tzid: "Europe/Prague",
};
const SAT: CandidateTimeInput = { startLocal: "2101-10-22T18:00", endLocal: "2101-10-22T22:00" };
const THU: CandidateTimeInput = { startLocal: "2101-10-20T19:00", endLocal: "2101-10-20T23:00" };
const SUN: CandidateTimeInput = { startLocal: "2101-10-23T14:00", endLocal: "2101-10-23T18:00" };

async function table(port: StoragePort, tag: string, playerVisibility: "FULL" | "HIDDEN" = "FULL") {
  const dm = await findOrCreatePerson(port, `poll-dm-${tag}@example.org`, { now: T0 });
  const group = await createGroup(port, { name: "Table", creatorId: dm.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, dm.id);
  if (membership === null) throw new Error("expected membership");
  const invite = await createInvite(port, membership, {
    email: `poll-player-${tag}@example.org`,
    invitedBy: dm.id,
    editTier: "view",
    visibility: playerVisibility,
    now: T0,
  });
  if (!invite.ok) throw new Error(invite.reason);
  const accepted = await acceptInvite(port, invite.token, T0);
  if (accepted === null) throw new Error("expected accept");
  const poll = await createPoll(port, {
    creatorId: dm.id,
    group: membership,
    fields: BASE,
    candidates: [SAT, THU, SUN],
    now: T0,
  });
  return { dm, membership, playerId: accepted.personId, poll };
}

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("expected access");
  return a;
}

const answers = (...pairs: [number, Answer][]) => new Map(pairs);

export function runPollsContract(makePort: () => Promise<StoragePort>): void {
  describe("time polls", () => {
    it("creates a proposed event with its candidates sorted by time", async () => {
      const port = await makePort();
      const { dm, poll } = await table(port, "create");
      expect(poll.status).toBe("proposed");
      const results = await pollResults(port, await access(port, poll.id, dm.id));
      expect(results.candidates.map((c) => c.startLocal)).toEqual([
        "2101-10-20T19:00:00",
        "2101-10-22T18:00:00",
        "2101-10-23T14:00:00",
      ]);
      expect(results.electorate).toBe(2);
    });

    it("refuses too few, too many, duplicate and invalid candidates — and writes nothing", async () => {
      const port = await makePort();
      const dm = await findOrCreatePerson(port, "poll-dm-bad@example.org", { now: T0 });
      const make = (candidates: CandidateTimeInput[]) =>
        createPoll(port, { creatorId: dm.id, group: null, fields: BASE, candidates, now: T0 });
      await expect(make([SAT])).rejects.toThrow(/at least 2/);
      await expect(
        make(
          Array.from({ length: 11 }, (_, i) => ({
            startLocal: `2101-10-${10 + i}T18:00`,
            endLocal: `2101-10-${10 + i}T19:00`,
          })),
        ),
      ).rejects.toThrow(/at most 10/);
      await expect(make([SAT, SAT])).rejects.toThrow(/same/);
      await expect(
        make([SAT, { startLocal: "2101-10-20T19:00", endLocal: "2101-10-20T18:00" }]),
      ).rejects.toThrow(/end after/);
      const rows = await port.query({
        sql: "SELECT count(*) AS n FROM canonical_event WHERE owner_id = ?",
        params: [dm.id],
      });
      expect(rows[0]?.n).toBe(0);
    });

    it("records votes, replaces a changed answer, and tallies them", async () => {
      const port = await makePort();
      const { dm, playerId, poll } = await table(port, "vote");
      expect(
        (
          await vote(port, await access(port, poll.id, playerId), {
            answers: answers([0, "yes"], [1, "no"]),
            now: T0,
          })
        ).kind,
      ).toBe("recorded");
      expect(
        (
          await vote(port, await access(port, poll.id, dm.id), {
            answers: answers([0, "yes"], [1, "ifneedbe"]),
            now: T0,
          })
        ).kind,
      ).toBe("recorded");
      // Changing one's mind replaces, never duplicates.
      expect(
        (
          await vote(port, await access(port, poll.id, playerId), {
            answers: answers([1, "ifneedbe"]),
            now: T1,
          })
        ).kind,
      ).toBe("recorded");

      const results = await pollResults(port, await access(port, poll.id, playerId));
      expect(results.candidates[0]).toMatchObject({ yes: 2, ifNeedBe: 0, no: 0, mine: "yes" });
      expect(results.candidates[1]).toMatchObject({ yes: 0, ifNeedBe: 2, no: 0, mine: "ifneedbe" });
      expect(results.candidates[2]).toMatchObject({ yes: 0, ifNeedBe: 0, no: 0, mine: null });
      expect(results.everyoneYes).toEqual([0]);
    });

    it("rejects votes for a candidate that doesn't exist, writing none of the batch", async () => {
      const port = await makePort();
      const { playerId, poll } = await table(port, "invalid");
      const a = await access(port, poll.id, playerId);
      expect(
        (await vote(port, a, { answers: answers([0, "yes"], [7, "yes"]), now: T0 })).kind,
      ).toBe("invalid");
      expect((await pollResults(port, a)).candidates[0]?.yes).toBe(0);
    });

    it("a HIDDEN participant cannot vote and is not counted", async () => {
      const port = await makePort();
      const { playerId, poll, dm } = await table(port, "hidden", "HIDDEN");
      expect(
        (
          await vote(port, await access(port, poll.id, playerId), {
            answers: answers([0, "yes"]),
            now: T0,
          })
        ).kind,
      ).toBe("forbidden");
      expect((await pollResults(port, await access(port, poll.id, dm.id))).electorate).toBe(1);
    });

    it("confirming writes the winning time, schedules the event and logs it, attributed", async () => {
      const port = await makePort();
      const { dm, poll } = await table(port, "confirm");
      const a = await access(port, poll.id, dm.id);
      const result = await confirmCandidate(port, a, {
        slotIndex: 1,
        expectedRevision: a.event.revision,
        actorId: dm.id,
        now: T1,
      });
      expect(result.kind).toBe("confirmed");
      const after = await access(port, poll.id, dm.id);
      expect(after.event).toMatchObject({
        status: "scheduled",
        startLocal: "2101-10-22T18:00:00",
        endLocal: "2101-10-22T22:00:00",
        revision: 2,
      });
      const history = await listHistory(port, after);
      expect(history[0]).toMatchObject({
        revision: 2,
        actorId: dm.id,
        change: {
          status: { before: "proposed", after: "scheduled" },
          startLocal: { before: "2101-10-20T19:00:00", after: "2101-10-22T18:00:00" },
        },
      });
    });

    it("after confirmation a vote is impossible — even from an access read before it", async () => {
      const port = await makePort();
      const { dm, playerId, poll } = await table(port, "closed");
      const stale = await access(port, poll.id, playerId); // read while still proposed
      const a = await access(port, poll.id, dm.id);
      await confirmCandidate(port, a, {
        slotIndex: 0,
        expectedRevision: 1,
        actorId: dm.id,
        now: T1,
      });
      // The stale access still says "proposed"; the database's status join refuses anyway.
      expect(stale.event.status).toBe("proposed");
      expect((await vote(port, stale, { answers: answers([0, "no"]), now: T1 })).kind).toBe(
        "closed",
      );
      expect((await pollResults(port, await access(port, poll.id, dm.id))).candidates[0]?.no).toBe(
        0,
      );
    });

    it("only an editor confirms; a second or stale confirm is refused and changes nothing", async () => {
      const port = await makePort();
      const { dm, playerId, poll } = await table(port, "who");
      expect(
        (
          await confirmCandidate(port, await access(port, poll.id, playerId), {
            slotIndex: 0,
            expectedRevision: 1,
            actorId: playerId,
            now: T1,
          })
        ).kind,
      ).toBe("forbidden");
      const a = await access(port, poll.id, dm.id);
      expect(
        (
          await confirmCandidate(port, a, {
            slotIndex: 2,
            expectedRevision: 1,
            actorId: dm.id,
            now: T1,
          })
        ).kind,
      ).toBe("confirmed");
      // Same stale access, other slot: the status/revision guard refuses it.
      expect(
        (
          await confirmCandidate(port, a, {
            slotIndex: 0,
            expectedRevision: 1,
            actorId: dm.id,
            now: T1,
          })
        ).kind,
      ).toBe("conflict");
      expect((await access(port, poll.id, dm.id)).event).toMatchObject({
        startLocal: "2101-10-23T14:00:00",
        revision: 2,
      });
      expect(
        (
          await confirmCandidate(port, await access(port, poll.id, dm.id), {
            slotIndex: 0,
            expectedRevision: 2,
            actorId: dm.id,
            now: T1,
          })
        ).kind,
      ).toBe("closed");
    });

    it("concurrent confirms of different slots: exactly one wins, one write", async () => {
      const port = await makePort();
      const { dm, poll } = await table(port, "race");
      const a = await access(port, poll.id, dm.id);
      const results = await Promise.all(
        [0, 1, 2].map((slotIndex) =>
          confirmCandidate(port, a, { slotIndex, expectedRevision: 1, actorId: dm.id, now: T1 }),
        ),
      );
      expect(results.filter((r) => r.kind === "confirmed")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "conflict")).toHaveLength(2);
      expect(
        (await listHistory(port, await access(port, poll.id, dm.id))).map((h) => h.revision),
      ).toEqual([2, 1]);
    });

    it("a double-submitted identical confirm is idempotent: both succeed, one write", async () => {
      // The read-back cannot tell "I wrote revision 2" from "an identical request of
      // mine did" — and need not: the outcome is exactly the one asked for. Same as
      // editEvent. What must hold is that only ONE write happened.
      const port = await makePort();
      const { dm, poll } = await table(port, "double");
      const a = await access(port, poll.id, dm.id);
      const results = await Promise.all(
        [1, 1].map((slotIndex) =>
          confirmCandidate(port, a, { slotIndex, expectedRevision: 1, actorId: dm.id, now: T1 }),
        ),
      );
      expect(results.map((r) => r.kind)).toEqual(["confirmed", "confirmed"]);
      expect(
        (await listHistory(port, await access(port, poll.id, dm.id))).map((h) => h.revision),
      ).toEqual([2, 1]);
    });

    it("confirm checks the status in the database, not just the revision", async () => {
      // Defence in depth: should any path ever change the status WITHOUT bumping the
      // revision (a withdraw, a bulk fix), a confirm from an access read before it must
      // still not resurrect the poll as scheduled.
      const port = await makePort();
      const { dm, poll } = await table(port, "statusguard");
      const stale = await access(port, poll.id, dm.id);
      await port.batch([
        { sql: "UPDATE canonical_event SET status = 'withdrawn' WHERE id = ?", params: [poll.id] },
      ]);
      const result = await confirmCandidate(port, stale, {
        slotIndex: 0,
        expectedRevision: 1,
        actorId: dm.id,
        now: T1,
      });
      expect(result.kind).toBe("conflict");
      expect((await access(port, poll.id, dm.id)).event.status).toBe("withdrawn");
    });

    it("an open poll's placeholder time cannot be edited", async () => {
      const port = await makePort();
      const { dm, poll } = await table(port, "edit");
      const result = await editEvent(port, await access(port, poll.id, dm.id), {
        fields: { ...BASE, ...SUN },
        actorId: dm.id,
        now: T1,
      });
      expect(result.kind).toBe("forbidden");
    });
  });
}
