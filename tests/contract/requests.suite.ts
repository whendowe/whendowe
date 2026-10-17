// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  createEvent,
  type EventAccess,
  editEvent,
  findEventForParticipant,
  listGroupEvents,
  listHistory,
  setCancelled,
  withdrawProposal,
} from "../../src/events/event.js";
import {
  acknowledge,
  answerProposal,
  issueResponseLinks,
  listRequests,
  needsAcknowledgment,
} from "../../src/events/response.js";
import { createGroup, findGroupForMember, type GroupMembership } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";

// Agreement & acknowledgment requests, and the lifecycle transitions they drive (DESIGN
// §10 rc13, WORKFLOWS US-3/US-4/US-7/US-9), on BOTH drivers. The transitions chain
// changes() across statements of one batch — exactly what must behave the same on D1
// and libsql. Residue-tolerant: every test uses its own people.

const T0 = "2101-10-01T10:00:00.000Z";
const T1 = "2101-10-01T11:00:00.000Z";

const NIGHT = {
  title: "Kids with David — extra night",
  description: null,
  location: "David's",
  allDay: false,
  startLocal: "2101-10-20T17:00",
  endLocal: "2101-10-21T08:00",
  tzid: "Europe/Prague",
};

/** A household: Mara (creator), David and Ann (co-parents), Petra (a viewer). */
async function household(port: StoragePort, tag: string) {
  const mara = await findOrCreatePerson(port, `req-mara-${tag}@example.org`, { now: T0 });
  const group = await createGroup(port, { name: "Household", creatorId: mara.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, mara.id);
  if (membership === null) throw new Error("expected membership");
  const join = async (who: string) => {
    const invite = await createInvite(port, membership, {
      email: `req-${who}-${tag}@example.org`,
      invitedBy: mara.id,
      editTier: "view",
      visibility: "FULL",
      now: T0,
    });
    if (!invite.ok) throw new Error(invite.reason);
    const accepted = await acceptInvite(port, invite.token, T0);
    if (accepted === null) throw new Error("expected accept");
    return accepted.personId;
  };
  return {
    mara: mara.id,
    membership,
    david: await join("david"),
    ann: await join("ann"),
    petra: await join("petra"),
  };
}

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("expected access");
  return a;
}

/** person id → their request state; independent of listing order. */
async function statesOf(port: StoragePort, eventId: string, viewer: string) {
  const requests = await listRequests(port, await access(port, eventId, viewer));
  return Object.fromEntries(requests.map((r) => [r.personId, r.state]));
}

async function propose(
  port: StoragePort,
  mara: string,
  membership: GroupMembership,
  requests: [string, "accept" | "ack"][],
) {
  return createEvent(port, {
    creatorId: mara,
    group: membership,
    fields: NIGHT,
    now: T0,
    requests: new Map(requests),
  });
}

export function runRequestsContract(makePort: () => Promise<StoragePort>): void {
  describe("agreement & acknowledgment requests", () => {
    it("asking someone to agree makes a proposal only its parties can see", async () => {
      const port = await makePort();
      const { mara, membership, david, petra } = await household(port, "parties");
      const event = await propose(port, mara, membership, [[david, "accept"]]);
      expect(event.status).toBe("proposed");
      expect(await findEventForParticipant(port, event.id, mara)).not.toBeNull();
      expect(await findEventForParticipant(port, event.id, david)).not.toBeNull();
      // Petra is in the group but not a party: she sees scheduled reality only (US-3).
      expect(await findEventForParticipant(port, event.id, petra)).toBeNull();
      expect(await listGroupEvents(port, membership, petra)).toEqual([]);
      expect((await access(port, event.id, david)).participation).toMatchObject({
        responseKind: "accept",
        responseState: "pending",
      });
    });

    it("accepting schedules it for everyone, attributed to the acceptor", async () => {
      const port = await makePort();
      const { mara, membership, david, petra } = await household(port, "accept");
      const event = await propose(port, mara, membership, [[david, "accept"]]);
      expect(
        await answerProposal(port, await access(port, event.id, david), {
          answer: "accept",
          now: T1,
        }),
      ).toEqual({
        kind: "recorded",
        status: "scheduled",
      });
      expect(await findEventForParticipant(port, event.id, petra)).not.toBeNull();
      const history = await listHistory(port, await access(port, event.id, mara));
      expect(history[0]).toMatchObject({
        revision: 2,
        actorId: david,
        change: { status: { before: "proposed", after: "scheduled" } },
      });
    });

    it("with two people to agree, it waits for the second", async () => {
      const port = await makePort();
      const { mara, membership, david, ann } = await household(port, "two");
      const event = await propose(port, mara, membership, [
        [david, "accept"],
        [ann, "accept"],
      ]);
      expect(
        (
          await answerProposal(port, await access(port, event.id, david), {
            answer: "accept",
            now: T1,
          })
        ).kind,
      ).toBe("recorded");
      expect((await access(port, event.id, mara)).event.status).toBe("proposed");
      expect(
        await answerProposal(port, await access(port, event.id, ann), {
          answer: "accept",
          now: T1,
        }),
      ).toMatchObject({ status: "scheduled" });
    });

    it("two last acceptances at once schedule it exactly once", async () => {
      const port = await makePort();
      const { mara, membership, david, ann } = await household(port, "race");
      const event = await propose(port, mara, membership, [
        [david, "accept"],
        [ann, "accept"],
      ]);
      const [d, a] = [await access(port, event.id, david), await access(port, event.id, ann)];
      await Promise.all([
        answerProposal(port, d, { answer: "accept", now: T1 }),
        answerProposal(port, a, { answer: "accept", now: T1 }),
      ]);
      expect((await access(port, event.id, mara)).event.status).toBe("scheduled");
      expect(
        (await listHistory(port, await access(port, event.id, mara))).map((h) => h.revision),
      ).toEqual([2, 1]);
    });

    it("one decline declines it; it stays with its parties and can't be accepted after", async () => {
      const port = await makePort();
      const { mara, membership, david, ann, petra } = await household(port, "decline");
      const event = await propose(port, mara, membership, [
        [david, "accept"],
        [ann, "accept"],
      ]);
      expect(
        await answerProposal(port, await access(port, event.id, david), {
          answer: "decline",
          now: T1,
        }),
      ).toMatchObject({ status: "declined" });
      expect(await findEventForParticipant(port, event.id, petra)).toBeNull();
      const mine = await access(port, event.id, mara); // Mara sees the attributed decline
      expect((await listHistory(port, mine))[0]).toMatchObject({
        actorId: david,
        change: { status: { after: "declined" } },
      });
      expect(
        (
          await answerProposal(port, await access(port, event.id, ann), {
            answer: "accept",
            now: T1,
          })
        ).kind,
      ).toBe("closed");
    });

    it("only someone asked can answer; only the creator can withdraw", async () => {
      const port = await makePort();
      const { mara, membership, david, ann } = await household(port, "who");
      const event = await propose(port, mara, membership, [
        [david, "accept"],
        [ann, "ack"],
      ]);
      // Ann was asked to acknowledge, not agree — and can't see the proposal at all yet.
      expect(await findEventForParticipant(port, event.id, ann)).toBeNull();
      expect(
        (await withdrawProposal(port, await access(port, event.id, david), { now: T1 })).kind,
      ).toBe("forbidden");
      expect(await withdrawProposal(port, await access(port, event.id, mara), { now: T1 })).toEqual(
        { kind: "done", status: "withdrawn" },
      );
      expect(
        (
          await answerProposal(port, await access(port, event.id, david), {
            answer: "accept",
            now: T1,
          })
        ).kind,
      ).toBe("closed");
    });

    it("an acknowledgment request never gates; 'seen' is recorded with its time", async () => {
      const port = await makePort();
      const { mara, membership, david } = await household(port, "ack");
      const event = await propose(port, mara, membership, [[david, "ack"]]);
      expect(event.status).toBe("scheduled");
      const d = await access(port, event.id, david);
      expect(needsAcknowledgment(d)).toBe(true);
      expect((await acknowledge(port, d, { now: T1 })).kind).toBe("recorded");
      expect(await listRequests(port, await access(port, event.id, mara))).toEqual([
        expect.objectContaining({ personId: david, kind: "ack", state: "acknowledged", at: T1 }),
      ]);
      expect((await acknowledge(port, await access(port, event.id, david), { now: T1 })).kind).toBe(
        "invalid",
      );
    });

    it("a material change asks again; a retitle doesn't", async () => {
      const port = await makePort();
      const { mara, membership, david, ann } = await household(port, "reack");
      const event = await propose(port, mara, membership, [
        [david, "accept"],
        [ann, "ack"],
      ]);
      await answerProposal(port, await access(port, event.id, david), {
        answer: "accept",
        now: T1,
      });
      await acknowledge(port, await access(port, event.id, ann), { now: T1 });

      const retitle = await editEvent(port, await access(port, event.id, mara), {
        fields: { ...NIGHT, title: "Extra night" },
        actorId: mara,
        now: T1,
      });
      expect(retitle.kind).toBe("updated");
      expect(await statesOf(port, event.id, mara)).toEqual({
        [david]: "accepted",
        [ann]: "acknowledged",
      });

      const moved = await editEvent(port, await access(port, event.id, mara), {
        fields: { ...NIGHT, title: "Extra night", startLocal: "2101-10-20T18:00" },
        actorId: mara,
        now: T1,
      });
      expect(moved.kind).toBe("updated");
      // The edit applied at once (US-7 MVP) — and both are asked to look again.
      expect(await statesOf(port, event.id, mara)).toEqual({ [david]: "reack", [ann]: "reack" });
      expect((await access(port, event.id, mara)).event.status).toBe("scheduled");
      // David re-confirms: back to accepted, not "acknowledged".
      expect((await acknowledge(port, await access(port, event.id, david), { now: T1 })).kind).toBe(
        "recorded",
      );
      expect((await access(port, event.id, david)).participation.responseState).toBe("accepted");
    });

    it("a material edit that loses the race asks nobody again", async () => {
      // The edit is refused as a conflict, so nothing changed: the reset must not run.
      const port = await makePort();
      const { mara, membership, david } = await household(port, "stale");
      const event = await propose(port, mara, membership, [[david, "ack"]]);
      await acknowledge(port, await access(port, event.id, david), { now: T1 });
      const stale = await access(port, event.id, mara);
      await editEvent(port, await access(port, event.id, mara), {
        fields: { ...NIGHT, title: "Retitled" },
        actorId: mara,
        now: T1,
      });
      const late = await editEvent(port, stale, {
        fields: { ...NIGHT, startLocal: "2101-10-20T19:00" },
        actorId: mara,
        now: T1,
      });
      expect(late.kind).toBe("conflict");
      expect(await statesOf(port, event.id, mara)).toEqual({ [david]: "acknowledged" });
    });

    it("editors cancel and restore, attributed; a viewer can't", async () => {
      const port = await makePort();
      const { mara, membership, petra } = await household(port, "cancel");
      const event = await createEvent(port, {
        creatorId: mara,
        group: membership,
        fields: NIGHT,
        now: T0,
      });
      expect(
        (
          await setCancelled(port, await access(port, event.id, petra), {
            cancelled: true,
            now: T1,
          })
        ).kind,
      ).toBe("forbidden");
      expect(
        await setCancelled(port, await access(port, event.id, mara), { cancelled: true, now: T1 }),
      ).toEqual({ kind: "done", status: "cancelled" });
      expect(
        (await setCancelled(port, await access(port, event.id, mara), { cancelled: true, now: T1 }))
          .kind,
      ).toBe("closed");
      expect(
        await setCancelled(port, await access(port, event.id, mara), { cancelled: false, now: T1 }),
      ).toEqual({ kind: "done", status: "scheduled" });
      const history = await listHistory(port, await access(port, event.id, petra));
      expect(history.slice(0, 2).map((h) => h.change.status?.after)).toEqual([
        "scheduled",
        "cancelled",
      ]);
    });

    it("a proposal's links go only to the people deciding it", async () => {
      const port = await makePort();
      const { mara, membership, david } = await household(port, "links");
      const event = await propose(port, mara, membership, [[david, "accept"]]);
      const issued = await issueResponseLinks(port, await access(port, event.id, mara), {
        now: T0,
      });
      expect(issued).toMatchObject({ kind: "issued", action: "vote" });
      if (issued.kind !== "issued") throw new Error(issued.kind);
      expect(issued.links.map((l) => l.personId)).toEqual([david]);
    });

    it("requests naming the creator or a non-member are ignored", async () => {
      const port = await makePort();
      const { mara, membership } = await household(port, "ignored");
      const stranger = await findOrCreatePerson(port, "req-stranger@example.org", { now: T0 });
      const event = await propose(port, mara, membership, [
        [mara, "accept"],
        [stranger.id, "accept"],
      ]);
      expect(event.status).toBe("scheduled");
      expect(await findEventForParticipant(port, event.id, stranger.id)).toBeNull();
    });
  });
}
