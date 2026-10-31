// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { findEventForParticipant, listEventsFor } from "../../src/events/event.js";
import { listParticipants } from "../../src/events/participation.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { diffPlans } from "../../src/plans/diff.js";
import {
  acceptPlan,
  addDraftEvent,
  agreedEvents,
  castVote,
  clipDraft,
  discardDraft,
  findDraft,
  listPlans,
  type Plan,
  sendDraft,
  startDraft,
  updateDraftEvent,
  withdrawPlan,
} from "../../src/plans/plan.js";
import { createThread, findThreadForMember, type ThreadAccess } from "../../src/plans/thread.js";

// Plans on BOTH drivers (DESIGN §10 rc19). The accept batch leans on INSERT … SELECT …
// WHERE EXISTS guards, json_each and a partial unique index — SQLite surface where D1
// and libsql could differ, so it is proven on each. Residue-tolerant: every test uses
// its own people.

const T0 = "2101-10-01T10:00:00.000Z";
const T1 = "2101-10-01T11:00:00.000Z";
const T2 = "2101-10-01T12:00:00.000Z";

async function people(port: StoragePort, tag: string, names: readonly string[]) {
  return Promise.all(
    names.map((n) => findOrCreatePerson(port, `plan-${n}-${tag}@example.org`, { now: T0 })),
  );
}

async function gate(port: StoragePort, threadId: string, personId: string) {
  const access = await findThreadForMember(port, threadId, personId);
  if (access === null) throw new Error("expected membership");
  return access;
}

function week(title: string, monday: string, nextMonday: string, who: string[]) {
  return { title, allDay: true, startLocal: monday, endLocal: nextMonday, who, now: T0 };
}

async function sentPlan(port: StoragePort, access: ThreadAccess, id: string): Promise<Plan> {
  const plan = (await listPlans(port, access)).find((p) => p.id === id);
  if (plan === undefined) throw new Error("expected the plan");
  return plan;
}

export function runPlansContract(makePort: () => Promise<StoragePort>): void {
  describe("plans contract", () => {
    it("only members reach a thread, and a draft only its author", async () => {
      const port = await makePort();
      const [adam, mara, stranger] = await people(port, "gate", ["adam", "mara", "stranger"]);
      if (adam === undefined || mara === undefined || stranger === undefined) throw new Error();
      const thread = await createThread(port, {
        name: "Kiddo's weeks",
        tzid: "Europe/Prague",
        creatorId: adam.id,
        memberIds: [mara.id],
        now: T0,
      });
      expect(await findThreadForMember(port, thread.id, stranger.id)).toBeNull();
      const a = await gate(port, thread.id, adam.id);
      expect(a.members.map((m) => m.personId).sort()).toEqual([adam.id, mara.id].sort());

      expect(
        (await startDraft(port, a, { fromId: null, rest: false, replace: false, now: T0 })).kind,
      ).toBe("started");
      await addDraftEvent(port, a, week("With Adam", "2101-11-07", "2101-11-14", [adam.id]));
      const m = await gate(port, thread.id, mara.id);
      expect(await listPlans(port, m)).toEqual([]);
      expect(await findDraft(port, a)).not.toBeNull();
    });

    it("two people: a suggested change, then both yeses accept it and replace the first", async () => {
      const port = await makePort();
      const [adam, mara] = await people(port, "pair", ["adam", "mara"]);
      if (adam === undefined || mara === undefined) throw new Error();
      const thread = await createThread(port, {
        name: "Kiddo's weeks",
        tzid: "Europe/Prague",
        creatorId: adam.id,
        memberIds: [mara.id],
        now: T0,
      });
      const a = await gate(port, thread.id, adam.id);
      const m = await gate(port, thread.id, mara.id);

      await startDraft(port, a, { fromId: null, rest: false, replace: false, now: T0 });
      await addDraftEvent(port, a, week("With Adam", "2101-11-07", "2101-11-14", [adam.id]));
      await addDraftEvent(port, a, week("With Mara", "2101-11-14", "2101-11-21", [mara.id]));
      const sentA = await sendDraft(port, a, { now: T0 });
      if (sentA.kind !== "sent") throw new Error(sentA.kind);
      const planA = await sentPlan(port, m, sentA.planId);
      expect(planA.letter).toBe("A");
      expect(planA.name).toBe("Plan A");
      expect(planA.votes).toEqual([{ personId: adam.id, answer: "yes", respondedAt: T0 }]);

      // Mara answers: the same events, sids and all, with the second week now Adam's.
      expect(
        (await startDraft(port, m, { fromId: planA.id, rest: false, replace: false, now: T1 }))
          .kind,
      ).toBe("started");
      const draft = await findDraft(port, m);
      expect(draft?.events.map((e) => e.sid)).toEqual(planA.events.map((e) => e.sid));
      const second = planA.events[1];
      if (second === undefined) throw new Error();
      await updateDraftEvent(port, m, {
        ...week("With Adam", "2101-11-14", "2101-11-21", [adam.id]),
        sid: second.sid,
        now: T1,
      });
      const sentB = await sendDraft(port, m, { now: T1 });
      if (sentB.kind !== "sent") throw new Error(sentB.kind);
      const planB = await sentPlan(port, a, sentB.planId);
      expect(planB.answersId).toBe(planA.id);
      expect(planB.questionId).toBe(planA.questionId);
      expect(planB.name).toMatch(/'s changes to A$/);

      const d = diffPlans(planA.events, planB.events);
      expect(d.same.length).toBe(1);
      expect(d.changed.map((c) => [c.moved, c.renamed, c.whoChanged])).toEqual([
        [false, true, true],
      ]);

      // Only one yes so far on B: still on the table. Adam's yes is the second.
      expect((await sentPlan(port, a, planB.id)).status).toBe("on_table");
      const voted = await castVote(port, a, { planId: planB.id, answer: "yes", now: T2 });
      expect(voted).toEqual({ kind: "accepted", replaced: [planA.id] });

      const after = await listPlans(port, a);
      expect(after.map((p) => [p.letter, p.status])).toEqual([
        ["A", "replaced"],
        ["B", "accepted"],
      ]);
      expect(after[0]?.replacedBy).toBe(planB.id);
      expect(after[1]?.decidedBy).toBeNull();

      // The weeks are ordinary scheduled events now, for both, and both may edit them.
      const agreed = await agreedEvents(port, a);
      expect(agreed.map((e) => [e.title, e.startLocal, e.who])).toEqual([
        ["With Adam", "2101-11-07", [adam.id]],
        ["With Adam", "2101-11-14", [adam.id]],
      ]);
      const first = agreed[0];
      if (first === undefined) throw new Error();
      const access = await findEventForParticipant(port, first.eventId, mara.id);
      expect(access?.event.status).toBe("scheduled");
      expect(access?.event.allDay).toBe(true);
      expect((await listParticipants(port, first.eventId)).map((p) => p.editTier)).toEqual([
        "edit",
        "edit",
      ]);
      expect((await listEventsFor(port, mara.id)).length).toBe(2);

      // Decided means decided: no more votes, no second accept.
      expect((await castVote(port, m, { planId: planB.id, answer: "no", now: T2 })).kind).toBe(
        "closed",
      );
      expect((await castVote(port, m, { planId: planA.id, answer: "yes", now: T2 })).kind).toBe(
        "closed",
      );
    });

    it("a group: only the organizer accepts; alternatives go, other weeks stay", async () => {
      const port = await makePort();
      const [ann, bob, cat] = await people(port, "table", ["ann", "bob", "cat"]);
      if (ann === undefined || bob === undefined || cat === undefined) throw new Error();
      const thread = await createThread(port, {
        name: "Thursday Table",
        tzid: "Europe/Prague",
        creatorId: ann.id,
        memberIds: [bob.id, cat.id],
        now: T0,
      });
      const a = await gate(port, thread.id, ann.id);
      const b = await gate(port, thread.id, bob.id);
      const c = await gate(port, thread.id, cat.id);
      const session = (title: string, d: string) => ({
        title,
        allDay: false,
        startLocal: `${d}T19:00`,
        endLocal: `${d}T23:00`,
        who: [],
        now: T0,
      });

      await startDraft(port, a, { fromId: null, rest: false, replace: false, now: T0 });
      await addDraftEvent(port, a, session("Session 15", "2101-11-05"));
      await addDraftEvent(port, a, session("Session 16", "2101-11-19"));
      const pa = await sendDraft(port, a, { now: T0 });
      if (pa.kind !== "sent") throw new Error();
      // Cat answers A; Bob puts up January, which answers nothing and overlaps nothing.
      await startDraft(port, c, { fromId: pa.planId, rest: false, replace: false, now: T1 });
      const pc = await sendDraft(port, c, { now: T1 });
      await startDraft(port, b, { fromId: null, rest: false, replace: false, now: T1 });
      await addDraftEvent(port, b, session("Session 17", "2102-01-14"));
      const pb = await sendDraft(port, b, { now: T2 });
      if (pc.kind !== "sent" || pb.kind !== "sent") throw new Error();

      // Everyone's yes doesn't accept in a group; Bob can't accept; Ann can.
      await castVote(port, b, { planId: pc.planId, answer: "yes", now: T1 });
      expect((await castVote(port, a, { planId: pc.planId, answer: "yes", now: T1 })).kind).toBe(
        "recorded",
      );
      expect((await acceptPlan(port, b, { planId: pc.planId, now: T2 })).kind).toBe("forbidden");
      expect(await acceptPlan(port, a, { planId: pc.planId, now: T2 })).toEqual({
        kind: "accepted",
        replaced: [pa.planId],
      });
      // A second accept, racing or late, writes nothing.
      expect((await acceptPlan(port, a, { planId: pc.planId, now: T2 })).kind).toBe("closed");
      expect((await agreedEvents(port, a)).length).toBe(2);

      const plans = await listPlans(port, b);
      expect(plans.map((p) => [p.letter, p.status])).toEqual([
        ["A", "replaced"],
        ["B", "accepted"],
        ["C", "on_table"],
      ]);
      expect(plans[1]?.decidedBy).toBe(ann.id);
      // Only the organizer may edit what the group agreed; the others see it.
      const ev = (await agreedEvents(port, b))[0];
      if (ev === undefined) throw new Error();
      const tiers = (await listParticipants(port, ev.eventId)).map((p) => [p.personId, p.editTier]);
      expect(tiers.sort()).toEqual(
        [
          [ann.id, "edit"],
          [bob.id, "view"],
          [cat.id, "view"],
        ].sort(),
      );
      expect((await withdrawPlan(port, a, { planId: pb.planId, now: T2 })).kind).toBe("closed");
      expect((await withdrawPlan(port, b, { planId: pb.planId, now: T2 })).kind).toBe("withdrawn");
    });

    it("plan the rest: a replaced plan's events that overlap nothing agreed", async () => {
      const port = await makePort();
      const [adam, mara] = await people(port, "rest", ["adam", "mara"]);
      if (adam === undefined || mara === undefined) throw new Error();
      const thread = await createThread(port, {
        name: "Weeks",
        tzid: "Europe/Prague",
        creatorId: adam.id,
        memberIds: [mara.id],
        now: T0,
      });
      const a = await gate(port, thread.id, adam.id);
      const m = await gate(port, thread.id, mara.id);
      await startDraft(port, a, { fromId: null, rest: false, replace: false, now: T0 });
      await addDraftEvent(port, a, week("With Adam", "2101-11-07", "2101-11-14", [adam.id]));
      await addDraftEvent(port, a, week("With Mara", "2101-11-14", "2101-11-21", [mara.id]));
      const pa = await sendDraft(port, a, { now: T0 });
      if (pa.kind !== "sent") throw new Error();
      // Mara answers with the first week only, and it is accepted.
      await startDraft(port, m, { fromId: pa.planId, rest: false, replace: false, now: T1 });
      await clipDraft(port, m, { first: "2101-11-07", last: "2101-11-13", keep: true, now: T1 });
      const pm = await sendDraft(port, m, { now: T1 });
      if (pm.kind !== "sent") throw new Error();
      expect((await castVote(port, a, { planId: pm.planId, answer: "yes", now: T1 })).kind).toBe(
        "accepted",
      );

      // Adam's replaced plan: the rest is the second week.
      expect(
        (await startDraft(port, a, { fromId: pa.planId, rest: true, replace: false, now: T2 }))
          .kind,
      ).toBe("started");
      const rest = await findDraft(port, a);
      expect(rest?.restOf).toBe(true);
      expect(rest?.name).toBe("Plan A (the rest)");
      expect(rest?.events.map((e) => e.startLocal)).toEqual(["2101-11-14"]);
      // Rest is only for replaced plans, and a draft with events isn't silently replaced.
      expect(
        (await startDraft(port, a, { fromId: pm.planId, rest: true, replace: false, now: T2 }))
          .kind,
      ).toBe("invalid");
      expect(
        (await startDraft(port, a, { fromId: null, rest: false, replace: false, now: T2 })).kind,
      ).toBe("has_draft");
      await discardDraft(port, a);
      expect(await findDraft(port, a)).toBeNull();
    });
  });
}
