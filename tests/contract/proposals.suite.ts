// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  createEvent,
  type EventAccess,
  type EventFieldsInput,
  editEvent,
  findEventForParticipant,
  listHistory,
  setCancelled,
} from "../../src/events/event.js";
import {
  decideProposal,
  listProposals,
  PROPOSAL_CEILING,
  proposeChange,
  withdrawChange,
} from "../../src/events/proposal.js";
import { acknowledge, listRequests } from "../../src/events/response.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite, type EditTier } from "../../src/people/invite.js";
import { findOrCreatePerson, guestName } from "../../src/people/person.js";

// Change proposals — the propose tier (DESIGN §10 rc13, MVP-2 slice 2E-2) — on BOTH
// drivers. Accepting chains changes() through the edit, its log row, the proposal's own
// status and the reack, and supersedes on a moved revision in the same batch: exactly
// what must behave the same on D1 and libsql. Residue-tolerant: every test uses its own
// people.

const T0 = "2101-11-01T10:00:00.000Z";
const T1 = "2101-11-01T11:00:00.000Z";
const T2 = "2101-11-01T12:00:00.000Z";

const DINNER: EventFieldsInput = {
  title: "Sunday dinner",
  description: null,
  location: "Mara's",
  allDay: false,
  startLocal: "2101-11-20T18:00",
  endLocal: "2101-11-20T20:00",
  tzid: "Europe/Prague",
};
const LATER: EventFieldsInput = {
  ...DINNER,
  startLocal: "2101-11-20T19:00",
  endLocal: "2101-11-20T21:00",
};

/** Mara creates; David may only propose; Ann edits too; Petra views. */
async function family(port: StoragePort, tag: string) {
  const mara = await findOrCreatePerson(port, `prop-mara-${tag}@example.org`, { now: T0 });
  const group = await createGroup(port, { name: "Family", creatorId: mara.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, mara.id);
  if (membership === null) throw new Error("expected membership");
  const join = async (who: string, editTier: EditTier) => {
    const invite = await createInvite(port, membership, {
      email: `prop-${who}-${tag}@example.org`,
      invitedBy: mara.id,
      editTier,
      visibility: "FULL",
      now: T0,
    });
    if (!invite.ok) throw new Error(invite.reason);
    const accepted = await acceptInvite(port, invite.token, T0);
    if (accepted === null) throw new Error("expected accept");
    return accepted.personId;
  };
  const people = {
    mara: mara.id,
    david: await join("david", "propose"),
    ann: await join("ann", "edit"),
    petra: await join("petra", "view"),
  };
  return { ...people, membership };
}

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("expected access");
  return a;
}

/** A scheduled dinner; Petra may be asked to acknowledge it. */
async function dinner(port: StoragePort, tag: string, petraAcks = false) {
  const f = await family(port, tag);
  const requests = new Map<string, "accept" | "ack">(petraAcks ? [[f.petra, "ack"]] : []);
  const event = await createEvent(port, {
    creatorId: f.mara,
    group: f.membership,
    fields: DINNER,
    now: T0,
    requests,
  });
  return { ...f, eventId: event.id };
}

async function proposed(port: StoragePort, eventId: string, who: string, fields = LATER) {
  const result = await proposeChange(port, await access(port, eventId, who), {
    fields,
    now: T1,
  });
  if (result.kind !== "proposed") throw new Error(`expected proposed, got ${result.kind}`);
  return result.id;
}

export function runProposalsContract(makePort: () => Promise<StoragePort>): void {
  describe("change proposals (propose tier)", () => {
    it("a propose-tier edit waits: the event is untouched, editors and the proposer see it", async () => {
      const port = await makePort();
      const f = await dinner(port, "wait");
      const id = await proposed(port, f.eventId, f.david);

      const event = await access(port, f.eventId, f.mara);
      expect(event.event.startLocal).toBe("2101-11-20T18:00:00");
      expect(event.event.revision).toBe(1);

      const forMara = await listProposals(port, event);
      expect(forMara.pending.map((p) => p.id)).toEqual([id]);
      expect(forMara.pending[0]?.change).toEqual({
        startLocal: { before: "2101-11-20T18:00:00", after: "2101-11-20T19:00:00" },
        endLocal: { before: "2101-11-20T20:00:00", after: "2101-11-20T21:00:00" },
      });
      expect(forMara.pending[0]?.proposedBy).toBe(f.david);

      const forDavid = await listProposals(port, await access(port, f.eventId, f.david));
      expect(forDavid.pending).toEqual([]);
      expect(forDavid.mine?.status).toBe("pending");

      const forPetra = await listProposals(port, await access(port, f.eventId, f.petra));
      expect(forPetra).toEqual({ pending: [], mine: null });
    });

    it("only the propose tier proposes; only the edit tier decides", async () => {
      const port = await makePort();
      const f = await dinner(port, "tiers");
      for (const who of [f.mara, f.petra]) {
        const r = await proposeChange(port, await access(port, f.eventId, who), {
          fields: LATER,
          now: T1,
        });
        expect(r.kind).toBe("forbidden");
      }
      const id = await proposed(port, f.eventId, f.david);
      for (const who of [f.david, f.petra]) {
        const r = await decideProposal(port, await access(port, f.eventId, who), {
          proposalId: id,
          decision: "accept",
          now: T2,
        });
        expect(r.kind).toBe("forbidden");
      }
      expect((await access(port, f.eventId, f.mara)).event.revision).toBe(1);
    });

    it("proposing what is already there changes nothing", async () => {
      const port = await makePort();
      const f = await dinner(port, "same");
      const r = await proposeChange(port, await access(port, f.eventId, f.david), {
        fields: DINNER,
        now: T1,
      });
      expect(r.kind).toBe("unchanged");
      expect((await listProposals(port, await access(port, f.eventId, f.david))).mine).toBeNull();
    });

    it("accepting applies it, attributed to the decider and naming the proposer", async () => {
      const port = await makePort();
      const f = await dinner(port, "accept");
      const id = await proposed(port, f.eventId, f.david);
      const r = await decideProposal(port, await access(port, f.eventId, f.ann), {
        proposalId: id,
        decision: "accept",
        now: T2,
      });
      expect(r.kind).toBe("accepted");

      const after = await access(port, f.eventId, f.mara);
      expect(after.event.startLocal).toBe("2101-11-20T19:00:00");
      expect(after.event.revision).toBe(2);
      const [latest] = await listHistory(port, after);
      expect(latest?.actorId).toBe(f.ann);
      expect(latest?.proposedBy?.name).toBe(guestName(f.eventId, f.david));
      expect(Object.keys(latest?.change ?? {})).toEqual(["startLocal", "endLocal"]);

      const mine = (await listProposals(port, await access(port, f.eventId, f.david))).mine;
      expect(mine?.status).toBe("accepted");
      expect(mine?.decidedBy?.name).toBe(guestName(f.eventId, f.ann));
      expect((await listProposals(port, after)).pending).toEqual([]);

      // A later plain edit is Mara's alone; the accepted revision keeps its proposer.
      await editEvent(port, after, { fields: DINNER, actorId: f.mara, now: T2 });
      const history = await listHistory(port, await access(port, f.eventId, f.mara));
      expect(history.map((h) => [h.revision, h.proposedBy?.name ?? null])).toEqual([
        [3, null],
        [2, guestName(f.eventId, f.david)],
        [1, null],
      ]);
    });

    it("an ordinary edit names no proposer, even after a rejected proposal", async () => {
      const port = await makePort();
      const f = await dinner(port, "plain");
      const id = await proposed(port, f.eventId, f.david);
      await decideProposal(port, await access(port, f.eventId, f.ann), {
        proposalId: id,
        decision: "reject",
        now: T1,
      });
      await editEvent(port, await access(port, f.eventId, f.mara), {
        fields: LATER,
        actorId: f.mara,
        now: T1,
      });
      const [latest] = await listHistory(port, await access(port, f.eventId, f.mara));
      expect(latest?.proposedBy).toBeNull();
    });

    it("an accepted material change asks for acknowledgment again", async () => {
      const port = await makePort();
      const f = await dinner(port, "reack", true);
      await acknowledge(port, await access(port, f.eventId, f.petra), { now: T1 });
      const id = await proposed(port, f.eventId, f.david);
      await decideProposal(port, await access(port, f.eventId, f.mara), {
        proposalId: id,
        decision: "accept",
        now: T2,
      });
      const requests = await listRequests(port, await access(port, f.eventId, f.mara));
      expect(requests.find((r) => r.personId === f.petra)?.state).toBe("reack");
    });

    it("a rejected proposal leaves the event alone and can't be accepted after", async () => {
      const port = await makePort();
      const f = await dinner(port, "reject");
      const id = await proposed(port, f.eventId, f.david);
      const mara = await access(port, f.eventId, f.mara);
      expect(
        (await decideProposal(port, mara, { proposalId: id, decision: "reject", now: T2 })).kind,
      ).toBe("rejected");
      expect(
        (await decideProposal(port, mara, { proposalId: id, decision: "accept", now: T2 })).kind,
      ).toBe("closed");
      expect((await access(port, f.eventId, f.mara)).event.revision).toBe(1);
      const mine = (await listProposals(port, await access(port, f.eventId, f.david))).mine;
      expect(mine?.status).toBe("rejected");
    });

    it("if the event moved on, the proposal is superseded — never merged", async () => {
      const port = await makePort();
      const f = await dinner(port, "moved");
      const id = await proposed(port, f.eventId, f.david);
      await editEvent(port, await access(port, f.eventId, f.mara), {
        fields: { ...DINNER, location: "Ann's" },
        actorId: f.mara,
        now: T1,
      });
      const mara = await access(port, f.eventId, f.mara);
      expect((await listProposals(port, mara)).pending).toEqual([]);
      expect((await listProposals(port, await access(port, f.eventId, f.david))).mine?.status).toBe(
        "superseded",
      );

      const r = await decideProposal(port, mara, { proposalId: id, decision: "accept", now: T2 });
      expect(r.kind).toBe("superseded");
      const after = await access(port, f.eventId, f.mara);
      expect(after.event.startLocal).toBe("2101-11-20T18:00:00");
      expect(after.event.location).toBe("Ann's");
      expect(after.event.revision).toBe(2);
    });

    it("an accept from a stale page still can't apply over a newer revision", async () => {
      const port = await makePort();
      const f = await dinner(port, "stale");
      const id = await proposed(port, f.eventId, f.david);
      const staleMara = await access(port, f.eventId, f.mara);
      await setCancelled(port, await access(port, f.eventId, f.ann), { cancelled: true, now: T1 });
      await setCancelled(port, await access(port, f.eventId, f.ann), { cancelled: false, now: T1 });
      const r = await decideProposal(port, staleMara, {
        proposalId: id,
        decision: "accept",
        now: T2,
      });
      expect(r.kind).toBe("superseded");
      expect((await access(port, f.eventId, f.mara)).event.startLocal).toBe("2101-11-20T18:00:00");
    });

    it("two editors accepting rival proposals at once: exactly one applies", async () => {
      const port = await makePort();
      const f = await dinner(port, "race");
      const one = await proposed(port, f.eventId, f.david);
      // A second proposer, so both stay pending (proposing again replaces your own).
      const f2 = await findOrCreatePerson(port, "prop-zoe-race@example.org", { now: T0 });
      await port.batch([
        {
          sql: `INSERT INTO event_participation (canonical_event_id, person_id, edit_tier, visibility, created_at)
                VALUES (?, ?, 'propose', 'FULL', ?)`,
          params: [f.eventId, f2.id, T0],
        },
      ]);
      const two = await proposed(port, f.eventId, f2.id, { ...DINNER, location: "The park" });

      const [mara, ann] = [
        await access(port, f.eventId, f.mara),
        await access(port, f.eventId, f.ann),
      ];
      const results = await Promise.all([
        decideProposal(port, mara, { proposalId: one, decision: "accept", now: T2 }),
        decideProposal(port, ann, { proposalId: two, decision: "accept", now: T2 }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["accepted", "superseded"]);
      const history = await listHistory(port, await access(port, f.eventId, f.mara));
      expect(history.filter((h) => h.revision === 2)).toHaveLength(1);
    });

    it("proposing again replaces your earlier proposal", async () => {
      const port = await makePort();
      const f = await dinner(port, "again");
      const first = await proposed(port, f.eventId, f.david);
      const second = await proposed(port, f.eventId, f.david, { ...DINNER, location: "Park" });
      const pending = (await listProposals(port, await access(port, f.eventId, f.mara))).pending;
      expect(pending.map((p) => p.id)).toEqual([second]);
      const r = await decideProposal(port, await access(port, f.eventId, f.mara), {
        proposalId: first,
        decision: "accept",
        now: T2,
      });
      expect(r.kind).toBe("closed");
    });

    it("a proposal must start from the revision the person saw, on a scheduled event", async () => {
      const port = await makePort();
      const f = await dinner(port, "base");
      const david = await access(port, f.eventId, f.david);
      expect(
        (await proposeChange(port, david, { fields: LATER, now: T1, expectedRevision: 0 })).kind,
      ).toBe("conflict");

      // Moved on between David reading it and saving: the insert's own check refuses.
      await editEvent(port, await access(port, f.eventId, f.mara), {
        fields: { ...DINNER, title: "Dinner!" },
        actorId: f.mara,
        now: T1,
      });
      expect((await proposeChange(port, david, { fields: LATER, now: T1 })).kind).toBe("conflict");

      await setCancelled(port, await access(port, f.eventId, f.mara), { cancelled: true, now: T1 });
      const cancelled = await proposeChange(port, await access(port, f.eventId, f.david), {
        fields: LATER,
        now: T1,
      });
      expect(cancelled.kind).toBe("closed");
    });

    it("tiers are re-checked at the moment of writing", async () => {
      const port = await makePort();
      const f = await dinner(port, "recheck");
      const david = await access(port, f.eventId, f.david);
      const id = await proposed(port, f.eventId, f.david);
      const mara = await access(port, f.eventId, f.mara);
      const demote = (who: string) =>
        port.batch([
          {
            sql: "UPDATE event_participation SET edit_tier = 'view' WHERE canonical_event_id = ? AND person_id = ?",
            params: [f.eventId, who],
          },
        ]);
      await demote(f.david);
      expect(
        (await proposeChange(port, david, { fields: { ...DINNER, title: "x" }, now: T1 })).kind,
      ).toBe("forbidden");

      await demote(f.mara);
      const decisions: ("accept" | "reject")[] = ["accept", "reject"];
      for (const decision of decisions) {
        const r = await decideProposal(port, mara, { proposalId: id, decision, now: T2 });
        expect(r.kind).toBe(decision === "accept" ? "forbidden" : "closed");
      }
      expect((await access(port, f.eventId, f.ann)).event.revision).toBe(1);
      expect(
        (await listProposals(port, await access(port, f.eventId, f.ann))).pending,
      ).toHaveLength(1);
    });

    it("the proposer can withdraw; nobody else can", async () => {
      const port = await makePort();
      const f = await dinner(port, "withdraw");
      const id = await proposed(port, f.eventId, f.david);
      const byAnn = await withdrawChange(port, await access(port, f.eventId, f.ann), {
        proposalId: id,
        now: T2,
      });
      expect(byAnn.kind).toBe("closed");
      const byDavid = await withdrawChange(port, await access(port, f.eventId, f.david), {
        proposalId: id,
        now: T2,
      });
      expect(byDavid.kind).toBe("withdrawn");
      expect((await listProposals(port, await access(port, f.eventId, f.mara))).pending).toEqual(
        [],
      );
    });

    it(`one person can make at most ${PROPOSAL_CEILING} proposals on an event`, async () => {
      const port = await makePort();
      const f = await dinner(port, "ceiling");
      for (let i = 0; i < PROPOSAL_CEILING; i++) {
        await proposed(port, f.eventId, f.david, { ...DINNER, title: `Dinner ${i}` });
      }
      const over = await proposeChange(port, await access(port, f.eventId, f.david), {
        fields: { ...DINNER, title: "One more" },
        now: T2,
      });
      expect(over.kind).toBe("limit");
      // The refused proposal must not have replaced the last one that was written.
      const mine = (await listProposals(port, await access(port, f.eventId, f.david))).mine;
      expect(mine?.status).toBe("pending");
      expect(mine?.fields.title).toBe(`Dinner ${PROPOSAL_CEILING - 1}`);
    });
  });
}
