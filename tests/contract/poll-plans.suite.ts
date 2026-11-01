// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { findEventForParticipant } from "../../src/events/event.js";
import { PollInputError } from "../../src/events/poll.js";
import { createGroup, findGroupForMember, leaveGroup } from "../../src/people/group.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import {
  acceptPlan,
  castVote,
  createPollThread,
  findDraft,
  listPlans,
  startDraft,
} from "../../src/plans/plan.js";
import { findThreadForMember, ThreadInputError } from "../../src/plans/thread.js";

// Polls as one-event plans (DESIGN §10 rc26–27) on BOTH drivers: the poll is one batch,
// accepting writes the place, notes and group, and the group's BUSY members get the
// result through an INSERT … SELECT that D1 and libsql must agree on. Residue-tolerant:
// every test uses its own people.

const T0 = "2101-10-01T10:00:00.000Z";
const T1 = "2101-10-01T11:00:00.000Z";
const T2 = "2101-10-01T12:00:00.000Z";

const FIELDS = {
  title: "Birthday party",
  description: "Bring a cake",
  location: "The park",
  allDay: true,
  tzid: null,
};
const TIMES = [
  { startLocal: "2101-11-21", endLocal: "2101-11-22" },
  { startLocal: "2101-11-14", endLocal: "2101-11-15" },
  { startLocal: "2101-11-15", endLocal: "2101-11-16" },
];

async function person(port: StoragePort, name: string, tag: string) {
  return findOrCreatePerson(port, `poll-${name}-${tag}@example.org`, { now: T0 });
}

async function gate(port: StoragePort, threadId: string, personId: string) {
  const access = await findThreadForMember(port, threadId, personId);
  if (access === null) throw new Error("expected membership");
  return access;
}

/** Mara's family group: one member at each usual visibility, joined at `joined`. */
async function family(port: StoragePort, tag: string) {
  const mara = await person(port, "mara", tag);
  const group = await createGroup(port, { name: `Family ${tag}`, creatorId: mara.id, now: T0 });
  const join = async (name: string, visibility: string, joined = T0) => {
    const p = await person(port, name, tag);
    await port.batch([
      {
        sql: `INSERT INTO group_member (group_id, person_id, role, joined_at, default_edit_tier, default_visibility)
              VALUES (?, ?, 'member', ?, 'view', ?)`,
        params: [group.id, p.id, joined, visibility],
      },
    ]);
    return p;
  };
  const david = await join("david", "FULL");
  const petra = await join("petra", "DETAILS");
  const grandma = await join("grandma", "BUSY");
  const hidden = await join("hidden", "HIDDEN");
  const membership = await findGroupForMember(port, group.id, mara.id);
  if (membership === null) throw new Error("expected membership");
  return { mara, david, petra, grandma, hidden, group, membership, join };
}

export function runPollPlansContract(makePort: () => Promise<StoragePort>): void {
  describe("polls as one-event plans (rc26)", () => {
    it("a poll is a thread: one plan per time, in one question, with the creator's yes", async () => {
      const port = await makePort();
      const f = await family(port, "a");
      const ana = await person(port, "ana", "a");
      const { threadId, planIds } = await createPollThread(port, {
        creatorId: f.mara.id,
        group: f.membership,
        fields: FIELDS,
        candidates: TIMES,
        people: [ana.id],
        now: T0,
      });
      const access = await gate(port, threadId, f.mara.id);
      expect(access.thread.name).toBe("Birthday party");
      expect(access.thread.groupId).toBe(f.group.id);
      // Who sees title, time and place votes; busy-only and hidden members don't.
      expect(access.members.map((m) => m.personId).sort()).toEqual(
        [f.mara.id, f.david.id, f.petra.id, ana.id].sort(),
      );
      expect(await findThreadForMember(port, threadId, f.grandma.id)).toBeNull();
      const plans = await listPlans(port, access);
      expect(plans.map((p) => p.id)).toEqual(planIds);
      expect(plans.every((p) => p.status === "on_table" && p.questionId === planIds[0])).toBe(true);
      // In time order, A B C, each with the poll's place and notes, and Mara's yes.
      expect(plans.map((p) => [p.letter, p.events[0]?.startLocal])).toEqual([
        ["A", "2101-11-14"],
        ["B", "2101-11-15"],
        ["C", "2101-11-21"],
      ]);
      for (const p of plans) {
        expect(p.events).toHaveLength(1);
        expect(p.events[0]?.location).toBe("The park");
        expect(p.events[0]?.description).toBe("Bring a cake");
        expect(p.votes).toEqual([{ personId: f.mara.id, answer: "yes", respondedAt: T0 }]);
      }
      // "Suggest changes…" from one keeps its place and notes.
      const david = await gate(port, threadId, f.david.id);
      await startDraft(port, david, {
        fromId: planIds[1] ?? "",
        rest: false,
        replace: false,
        now: T1,
      });
      expect((await findDraft(port, david))?.events[0]?.location).toBe("The park");
    });

    it("between two, the second yes agrees a time; 'if need be' never does", async () => {
      const port = await makePort();
      const mara = await person(port, "mara", "b");
      const david = await person(port, "david", "b");
      const { threadId, planIds } = await createPollThread(port, {
        creatorId: mara.id,
        group: null,
        fields: FIELDS,
        candidates: TIMES,
        people: [david.id],
        now: T0,
      });
      const access = await gate(port, threadId, david.id);
      const [a, b, c] = planIds;
      expect(
        (await castVote(port, access, { planId: a ?? "", answer: "ifneedbe", now: T1 })).kind,
      ).toBe("recorded");
      const agreed = await castVote(port, access, { planId: b ?? "", answer: "yes", now: T2 });
      expect(agreed).toEqual({ kind: "accepted", replaced: [a, c] });
      const plans = await listPlans(port, access);
      expect(plans.map((p) => p.status)).toEqual(["replaced", "accepted", "replaced"]);
      // The event carries the poll's place and notes; with no group, no provenance.
      const eventId = plans[1]?.events[0]?.canonicalEventId ?? "";
      const event = await findEventForParticipant(port, eventId, david.id);
      expect(event?.event).toMatchObject({
        title: "Birthday party",
        location: "The park",
        description: "Bring a cake",
        startLocal: "2101-11-15",
        groupId: null,
        status: "scheduled",
      });
      // …and so does its history: the first change says what it was created with.
      const [log] = await port.query({
        sql: "SELECT diff FROM change_log WHERE canonical_event_id = ?",
        params: [eventId],
      });
      expect(String(log?.diff)).toContain("Bring a cake");
      expect(String(log?.diff)).toContain("The park");
      // A vote after it's decided lands nowhere.
      expect((await castVote(port, access, { planId: c ?? "", answer: "yes", now: T2 })).kind).toBe(
        "closed",
      );
    });

    it("in a group, the organizer accepts; busy-only members who were there get the result", async () => {
      const port = await makePort();
      const f = await family(port, "c");
      const late = await f.join("late", "BUSY", T1); // joined after the poll was made
      const { threadId, planIds } = await createPollThread(port, {
        creatorId: f.mara.id,
        group: f.membership,
        fields: FIELDS,
        candidates: TIMES,
        now: T0,
      });
      await port.batch([
        { sql: "UPDATE person_group SET retain_days = 90 WHERE id = ?", params: [f.group.id] },
      ]);
      const mara = await gate(port, threadId, f.mara.id);
      const accepted = await acceptPlan(port, mara, { planId: planIds[2] ?? "", now: T2 });
      expect(accepted.kind).toBe("accepted");
      const eventId = (await listPlans(port, mara))[2]?.events[0]?.canonicalEventId ?? "";
      const tiers = await port.query({
        sql: "SELECT person_id, edit_tier, visibility FROM event_participation WHERE canonical_event_id = ? ORDER BY person_id",
        params: [eventId],
      });
      expect(tiers).toEqual(
        [
          { person_id: f.mara.id, edit_tier: "edit", visibility: "FULL" },
          { person_id: f.david.id, edit_tier: "view", visibility: "FULL" },
          { person_id: f.petra.id, edit_tier: "view", visibility: "FULL" },
          { person_id: f.grandma.id, edit_tier: "view", visibility: "BUSY" },
        ].sort((x, y) => (x.person_id < y.person_id ? -1 : 1)),
      );
      expect(tiers.some((t) => t.person_id === late.id || t.person_id === f.hidden.id)).toBe(false);
      // The group is its provenance, and gives its period.
      const [row] = await port.query({
        sql: "SELECT group_id, retain_days FROM canonical_event WHERE id = ?",
        params: [eventId],
      });
      expect(row).toEqual({ group_id: f.group.id, retain_days: 90 });
    });

    it("a refused poll writes nothing", async () => {
      const port = await makePort();
      const mara = await person(port, "mara", "d");
      const david = await person(port, "david", "d");
      const count = async () =>
        (
          await port.query({
            sql: "SELECT count(*) AS n FROM plan_thread WHERE organizer_id = ?",
            params: [mara.id],
          })
        )[0]?.n;
      const poll = (candidates: typeof TIMES, people: string[]) =>
        createPollThread(port, {
          creatorId: mara.id,
          group: null,
          fields: FIELDS,
          candidates,
          people,
          now: T0,
        });
      await expect(poll(TIMES.slice(0, 1), [david.id])).rejects.toBeInstanceOf(PollInputError);
      await expect(poll(TIMES, [])).rejects.toBeInstanceOf(ThreadInputError);
      expect(await count()).toBe(0);
    });

    it("a thread outlives its group, which it then no longer names", async () => {
      const port = await makePort();
      const f = await family(port, "e");
      const { threadId } = await createPollThread(port, {
        creatorId: f.mara.id,
        group: f.membership,
        fields: FIELDS,
        candidates: TIMES,
        now: T0,
      });
      for (const p of [f.david, f.petra, f.grandma, f.hidden, f.mara]) {
        const m = await findGroupForMember(port, f.group.id, p.id);
        if (m !== null) await leaveGroup(port, m, p.id, T1);
      }
      expect(await findGroupForMember(port, f.group.id, f.david.id)).toBeNull();
      expect((await gate(port, threadId, f.mara.id)).thread.groupId).toBeNull();
    });
  });
}
