// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  answerRequest,
  askEveryone,
  createEvent,
  deleteEvent,
  type EventAccess,
  editEvent,
  eventRetention,
  findEventForParticipant,
  listHistory,
  listVerifiedRequests,
  resolveRequestLink,
  setCancelled,
  setEventRetention,
  setVerified,
  VERIFIED_REQUEST_TTL_MS,
} from "../../src/events/event.js";
import {
  addParticipant,
  leaveEvent,
  listParticipantChanges,
  listParticipants,
  removeParticipant,
} from "../../src/events/participation.js";
import { decideProposal, listProposals, proposeChange } from "../../src/events/proposal.js";
import {
  acknowledge,
  addFeedback,
  answerProposal,
  FEEDBACK_PER_PERSON_PER_EVENT,
  issueResponseLinks,
  listRequests,
  listResponses,
  listUnsentReceipts,
  RESPONSE_RESEND_INTERVAL_MS,
  RESPONSE_TOKEN_TTL_MS,
  recordUnsentReceipt,
  resolveResponseLink,
  revokeUndeliveredLink,
  SIGNED_IN,
  setAttendance,
  setOwnAnswersOnly,
} from "../../src/events/response.js";
import {
  createGroup,
  findGroupForMember,
  setDefaultOwnAnswersOnly,
  setGroupDefaultVerified,
} from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { eraseAccount } from "../../src/privacy/erasure.js";
import { purgeEventStatements } from "../../src/privacy/purge.js";

// Responses and account-less links on BOTH drivers: the upsert-with-guarded-update
// that rotates and throttles links, and the count-guarded feedback insert, are the
// SQLite behaviours that must not differ between D1 and libsql.

const T0 = "2101-10-01T10:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

const SESSION = {
  title: "Session 14",
  description: null,
  location: null,
  allDay: false,
  startLocal: "2101-10-20T19:00",
  endLocal: "2101-10-20T23:00",
  tzid: "Europe/Prague",
};

async function table(port: StoragePort, tag: string) {
  const dm = await findOrCreatePerson(port, `resp-dm-${tag}@example.org`, { now: T0 });
  const group = await createGroup(port, { name: "Table", creatorId: dm.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, dm.id);
  if (membership === null) throw new Error("expected membership");
  const join = async (who: string, visibility: "FULL" | "HIDDEN") => {
    const invite = await createInvite(port, membership, {
      email: `resp-${who}-${tag}@example.org`,
      invitedBy: dm.id,
      editTier: "view",
      visibility,
      now: T0,
    });
    if (!invite.ok) throw new Error(invite.reason);
    const accepted = await acceptInvite(port, invite.token, T0);
    if (accepted === null) throw new Error("expected accept");
    return accepted.personId;
  };
  const ann = await join("ann", "FULL");
  const bob = await join("bob", "FULL");
  const ghost = await join("ghost", "HIDDEN");
  return { dm, membership, ann, bob, ghost };
}

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("expected access");
  return a;
}

export function runResponsesContract(makePort: () => Promise<StoragePort>): void {
  describe("responses", () => {
    it("attendance: stated, changed, attributed with its time; only on a scheduled event", async () => {
      const port = await makePort();
      const { dm, membership, ann, ghost } = await table(port, "attend");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      expect(
        (
          await setAttendance(port, await access(port, event.id, ann), {
            arrival: SIGNED_IN,
            attendance: "going",
            now: T0,
          })
        ).kind,
      ).toBe("recorded");
      expect(
        (
          await setAttendance(port, await access(port, event.id, ann), {
            arrival: SIGNED_IN,
            attendance: "maybe",
            now: later(1000),
          })
        ).kind,
      ).toBe("recorded");
      const listed = (await listResponses(port, await access(port, event.id, dm.id))).attendance;
      expect(listed).toEqual([
        expect.objectContaining({ personId: ann, attendance: "maybe", at: later(1000) }),
      ]);
      expect(
        (
          await setAttendance(port, await access(port, event.id, ghost), {
            arrival: SIGNED_IN,
            attendance: "going",
            now: T0,
          })
        ).kind,
      ).toBe("forbidden");

      // Waiting for agreement (rc13): not scheduled yet, so nobody says if they're coming.
      const poll = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        requests: new Map([[ann, "accept"]]),
        now: T0,
      });
      expect(
        (
          await setAttendance(port, await access(port, poll.id, ann), {
            arrival: SIGNED_IN,
            attendance: "going",
            now: T0,
          })
        ).kind,
      ).toBe("closed");
    });

    it("feedback: attributed notes in order; empty and over-long refused", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "feedback");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      await addFeedback(port, await access(port, event.id, ann), {
        arrival: SIGNED_IN,
        body: "  might be late  ",
        now: T0,
      });
      await addFeedback(port, await access(port, event.id, bob), {
        arrival: SIGNED_IN,
        body: "bringing snacks",
        now: later(1000),
      });
      expect(
        (
          await addFeedback(port, await access(port, event.id, bob), {
            arrival: SIGNED_IN,
            body: "   ",
            now: T0,
          })
        ).kind,
      ).toBe("invalid");
      expect(
        (
          await addFeedback(port, await access(port, event.id, bob), {
            arrival: SIGNED_IN,
            body: "x".repeat(501),
            now: T0,
          })
        ).kind,
      ).toBe("invalid");
      const notes = (await listResponses(port, await access(port, event.id, dm.id))).feedback;
      expect(notes.map((n) => [n.personId, n.body])).toEqual([
        [ann, "might be late"],
        [bob, "bringing snacks"],
      ]);
    });

    it("feedback has a per-person ceiling that parallel requests cannot overshoot", async () => {
      const port = await makePort();
      const { dm, membership, ann } = await table(port, "ceiling");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const a = await access(port, event.id, ann);
      const results = await Promise.all(
        Array.from({ length: FEEDBACK_PER_PERSON_PER_EVENT + 10 }, (_, i) =>
          addFeedback(port, a, { arrival: SIGNED_IN, body: `note ${i}`, now: T0 }),
        ),
      );
      expect(results.filter((r) => r.kind === "recorded")).toHaveLength(
        FEEDBACK_PER_PERSON_PER_EVENT,
      );
      expect((await listResponses(port, a)).feedback).toHaveLength(FEEDBACK_PER_PERSON_PER_EVENT);
    });

    it("copying (rc36): just that person's link, replaced even within the resend hour", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "copy");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const asDm = await access(port, event.id, dm.id);
      const sent = await issueResponseLinks(port, asDm, { now: T0 });
      if (sent.kind !== "issued") throw new Error(sent.kind);
      const before = sent.links.find((l) => l.personId === ann)?.token ?? "";
      expect(await issueResponseLinks(port, asDm, { now: T0, only: ann })).toMatchObject({
        links: [],
        throttled: 1,
      });
      const copied = await issueResponseLinks(port, asDm, { now: T0, only: ann, copy: true });
      if (copied.kind !== "issued") throw new Error(copied.kind);
      expect(copied.links.map((l) => l.personId)).toEqual([ann]);
      expect(await resolveResponseLink(port, before, T0)).toBeNull();
      expect(
        (await resolveResponseLink(port, copied.links[0]?.token ?? "", T0))?.access.participation
          .personId,
      ).toBe(ann);
      const bobs = sent.links.find((l) => l.personId === bob)?.token ?? "";
      expect(await resolveResponseLink(port, bobs, T0)).not.toBeNull();
    });

    it("how an answer arrived (rc42): signed in, the emailed link, or a copied link and who copied it", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "arrival");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const asDm = await access(port, event.id, dm.id);
      const arrivals = async () => {
        const r = await listResponses(port, asDm);
        return {
          attendance: Object.fromEntries(r.attendance.map((a) => [a.personId, a.arrival])),
          notes: r.feedback.map((f) => [f.personId, f.arrival]),
        };
      };
      const mailed = await issueResponseLinks(port, asDm, { now: T0 });
      if (mailed.kind !== "issued") throw new Error(mailed.kind);
      const tokenOf = (links: typeof mailed.links, who: string) =>
        links.find((l) => l.personId === who)?.token ?? "";

      // Ann answers with the link we mailed her: it says so, with nobody to name.
      const annLink = await resolveResponseLink(port, tokenOf(mailed.links, ann), T0);
      if (annLink === null) throw new Error("expected link");
      expect(annLink.arrival).toEqual({ via: "mailed", by: null });
      await setAttendance(port, annLink.access, {
        attendance: "going",
        now: T0,
        arrival: annLink.arrival,
      });
      await addFeedback(port, annLink.access, {
        body: "might be late",
        now: T0,
        arrival: annLink.arrival,
      });

      // Bob's is copied by the DM: the link remembers who, and so does the answer.
      const copied = await issueResponseLinks(port, asDm, { now: T0, only: bob, copy: true });
      if (copied.kind !== "issued") throw new Error(copied.kind);
      const bobLink = await resolveResponseLink(port, tokenOf(copied.links, bob), T0);
      if (bobLink === null) throw new Error("expected link");
      expect(bobLink.arrival).toEqual({ via: "copied", by: dm.id });
      await setAttendance(port, bobLink.access, {
        attendance: "maybe",
        now: T0,
        arrival: bobLink.arrival,
      });
      await addFeedback(port, bobLink.access, { body: "ok", now: T0, arrival: bobLink.arrival });
      expect(await arrivals()).toEqual({
        attendance: {
          [ann]: { via: "mailed", by: null },
          [bob]: { via: "copied", by: dm.id },
        },
        notes: [
          [ann, { via: "mailed", by: null }],
          [bob, { via: "copied", by: dm.id }],
        ],
      });

      // Bob then answers signed in: his label follows his new answer; Ann's hasn't moved,
      // and the note he left by the copied link still says how it came.
      await setAttendance(port, await access(port, event.id, bob), {
        attendance: "going",
        now: T0,
        arrival: SIGNED_IN,
      });
      expect(await arrivals()).toMatchObject({
        attendance: { [ann]: { via: "mailed", by: null }, [bob]: { via: "session", by: null } },
        notes: [
          [ann, { via: "mailed" }],
          [bob, { via: "copied", by: dm.id }],
        ],
      });

      // Mailing Bob a link again makes his link a mailed one: the label is the link's, each time.
      const again = await issueResponseLinks(port, asDm, {
        now: later(RESPONSE_RESEND_INTERVAL_MS + 1),
        only: bob,
      });
      if (again.kind !== "issued") throw new Error(again.kind);
      expect(
        (
          await resolveResponseLink(
            port,
            tokenOf(again.links, bob),
            later(RESPONSE_RESEND_INTERVAL_MS + 1),
          )
        )?.arrival,
      ).toEqual({ via: "mailed", by: null });

      // A link from before rc42 has no origin: what arrives by it is recorded as not recorded.
      await port.batch([
        {
          sql: "UPDATE response_token SET origin = NULL, issued_by = NULL WHERE canonical_event_id = ? AND person_id = ?",
          params: [event.id, ann],
        },
      ]);
      const old = await resolveResponseLink(port, tokenOf(mailed.links, ann), T0);
      if (old === null) throw new Error("expected link");
      expect(old.arrival).toBeNull();
      await setAttendance(port, old.access, {
        attendance: "not_going",
        now: T0,
        arrival: old.arrival,
      });
      await addFeedback(port, old.access, { body: "old link", now: T0, arrival: old.arrival });
      const after = await arrivals();
      expect(after.attendance[ann]).toBeNull();
      expect(after.notes.at(-1)).toEqual([ann, null]);
    });

    it("only my own email (rc42): no copy, copied links dead, set only by the person themselves", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "own");
      // Ann's default for this group is on; Bob's is not.
      await setDefaultOwnAnswersOnly(port, membership, ann, true);
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const asDm = await access(port, event.id, dm.id);
      expect((await access(port, event.id, ann)).participation.ownAnswersOnly).toBe(true);
      expect((await access(port, event.id, bob)).participation.ownAnswersOnly).toBe(false);

      // Nobody copies Ann's link; a mailed one she still gets, and it works.
      const copyAnn = await issueResponseLinks(port, asDm, { now: T0, only: ann, copy: true });
      expect(copyAnn).toMatchObject({ kind: "issued", links: [] });
      const mailed = await issueResponseLinks(port, asDm, { now: T0 });
      if (mailed.kind !== "issued") throw new Error(mailed.kind);
      const tokenOf = (links: typeof mailed.links, who: string) =>
        links.find((l) => l.personId === who)?.token ?? "";
      expect(await resolveResponseLink(port, tokenOf(mailed.links, ann), T0)).not.toBeNull();

      // Bob's link is copied. From it, he can't turn the switch on: that's what it guards.
      const copied = await issueResponseLinks(port, asDm, { now: T0, only: bob, copy: true });
      if (copied.kind !== "issued") throw new Error(copied.kind);
      const bobCopied = await resolveResponseLink(port, tokenOf(copied.links, bob), T0);
      if (bobCopied === null) throw new Error("expected link");
      expect(
        await setOwnAnswersOnly(port, bobCopied.access, { on: true, arrival: bobCopied.arrival }),
      ).toBe("forbidden");
      expect(await setOwnAnswersOnly(port, bobCopied.access, { on: true, arrival: null })).toBe(
        "forbidden",
      );
      expect((await access(port, event.id, bob)).participation.ownAnswersOnly).toBe(false);

      // Signed in, he can. His copied link stops working, and stays dead when he turns it off.
      const asBob = await access(port, event.id, bob);
      expect(await setOwnAnswersOnly(port, asBob, { on: true, arrival: SIGNED_IN })).toBe("saved");
      expect(await resolveResponseLink(port, tokenOf(copied.links, bob), T0)).toBeNull();
      expect(
        await setOwnAnswersOnly(port, await access(port, event.id, bob), {
          on: false,
          arrival: SIGNED_IN,
        }),
      ).toBe("saved");
      expect(await resolveResponseLink(port, tokenOf(copied.links, bob), T0)).toBeNull();

      // From a mailed link Ann turns hers off, and a copy can be made again.
      const annMailed = await resolveResponseLink(port, tokenOf(mailed.links, ann), T0);
      if (annMailed === null) throw new Error("expected link");
      expect(
        await setOwnAnswersOnly(port, annMailed.access, { on: false, arrival: annMailed.arrival }),
      ).toBe("saved");
      const again = await issueResponseLinks(port, asDm, { now: T0, only: ann, copy: true });
      expect(again.kind === "issued" ? again.links.map((l) => l.personId) : []).toEqual([ann]);

      // Back on: a link from before links said how they were made doesn't answer as her either.
      await setOwnAnswersOnly(port, await access(port, event.id, ann), {
        on: true,
        arrival: SIGNED_IN,
      });
      const fresh = await issueResponseLinks(port, asDm, {
        now: later(RESPONSE_RESEND_INTERVAL_MS + 1),
        only: ann,
      });
      if (fresh.kind !== "issued") throw new Error(fresh.kind);
      const t = tokenOf(fresh.links, ann);
      expect(
        await resolveResponseLink(port, t, later(RESPONSE_RESEND_INTERVAL_MS + 1)),
      ).not.toBeNull();
      await port.batch([
        {
          sql: "UPDATE response_token SET origin = NULL WHERE canonical_event_id = ? AND person_id = ?",
          params: [event.id, ann],
        },
      ]);
      expect(await resolveResponseLink(port, t, later(RESPONSE_RESEND_INTERVAL_MS + 1))).toBeNull();
      // Turning it on withdrew that link too: off again, it doesn't come back.
      await setOwnAnswersOnly(port, await access(port, event.id, ann), {
        on: true,
        arrival: SIGNED_IN,
      });
      await setOwnAnswersOnly(port, await access(port, event.id, ann), {
        on: false,
        arrival: SIGNED_IN,
      });
      expect(await resolveResponseLink(port, t, later(RESPONSE_RESEND_INTERVAL_MS + 1))).toBeNull();

      // Her default turned off again, the next event from the group starts with it off.
      await setDefaultOwnAnswersOnly(port, membership, ann, false);
      const next = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      expect((await access(port, next.id, ann)).participation.ownAnswersOnly).toBe(false);
    });

    it("verified (rc42): made so by an editor, once; logged; no copies; copied links dead", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "ver");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      expect(event.verifiedAt).toBeNull();
      const asDm = await access(port, event.id, dm.id);
      const copied = await issueResponseLinks(port, asDm, { now: T0, only: bob, copy: true });
      if (copied.kind !== "issued") throw new Error(copied.kind);
      const mailed = await issueResponseLinks(port, asDm, { now: T0, only: ann });
      if (mailed.kind !== "issued") throw new Error(mailed.kind);

      // A link from before rc42 recorded how links were made (here the DM's own, standing in).
      await port.batch([
        {
          sql: `INSERT INTO response_token (token_hash, canonical_event_id, person_id, action, expires_at, created_at)
                VALUES ('pre-rc42', ?, ?, 'attend', ?, ?)`,
          params: [event.id, dm.id, later(RESPONSE_TOKEN_TTL_MS), T0],
        },
      ]);
      const origins = async () =>
        (
          await port.query({
            sql: "SELECT origin FROM response_token WHERE canonical_event_id = ? ORDER BY origin",
            params: [event.id],
          })
        ).map((r) => r.origin);

      // Only an editor; once.
      expect(await setVerified(port, await access(port, event.id, ann), later(1))).toBe(
        "forbidden",
      );
      expect(await origins()).toEqual([null, "copied", "mailed"]);
      expect((await access(port, event.id, dm.id)).event.verifiedAt).toBeNull();
      expect(await setVerified(port, asDm, later(1))).toBe("verified");
      const after = await access(port, event.id, dm.id);
      expect(after.event.verifiedAt).toBe(later(1));
      expect(after.event.revision).toBe(2);
      expect(await setVerified(port, after, later(2))).toBe("already");
      expect((await access(port, event.id, dm.id)).event).toMatchObject({
        verifiedAt: later(1),
        revision: 2,
      });
      // Every tier's history says so, attributed.
      const history = await listHistory(port, after);
      expect(history.find((h) => h.revision === 2)).toMatchObject({
        revision: 2,
        actorId: dm.id,
        change: { verified: { before: 0, after: 1 } },
      });
      expect(history).toHaveLength(2);

      // Verifying withdrew every link not known to be mailed, so turning it off can't revive one.
      expect(await origins()).toEqual(["mailed"]);
      // Bob's copied link is gone; Ann's mailed one works; nobody's link is copied now.
      expect(await resolveResponseLink(port, copied.links[0]?.token ?? "", later(2))).toBeNull();
      const annLink = await resolveResponseLink(port, mailed.links[0]?.token ?? "", later(2));
      expect(annLink?.arrival).toEqual({ via: "mailed", by: null });
      const again = await issueResponseLinks(port, after, { now: later(2), only: ann, copy: true });
      expect(again).toMatchObject({ kind: "issued", links: [] });
      // A link from before rc42 recorded how it was made doesn't answer here either.
      await port.batch([
        {
          sql: "UPDATE response_token SET origin = NULL WHERE canonical_event_id = ? AND person_id = ?",
          params: [event.id, ann],
        },
      ]);
      expect(await resolveResponseLink(port, mailed.links[0]?.token ?? "", later(2))).toBeNull();
    });

    it("verified (rc42): only a mailed link or signed in counts, for every kind of answer", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "ver-ans");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
        verified: true,
        requests: new Map([[ann, "accept"]]),
      });
      expect(event.verifiedAt).toBe(T0);
      expect(
        (await listHistory(port, await access(port, event.id, dm.id)))[0]?.change,
      ).toMatchObject({
        verified: { before: null, after: 1 },
      });
      const copiedBy = { via: "copied", by: dm.id } as const;
      const asAnn = await access(port, event.id, ann);
      for (const arrival of [copiedBy, null])
        expect(await answerProposal(port, asAnn, { answer: "accept", now: T0, arrival })).toEqual({
          kind: "forbidden",
        });
      expect(
        (await answerProposal(port, asAnn, { answer: "accept", now: T0, arrival: SIGNED_IN })).kind,
      ).toBe("recorded");
      const asBob = await access(port, event.id, bob);
      for (const arrival of [copiedBy, null]) {
        expect(await setAttendance(port, asBob, { attendance: "going", now: T0, arrival })).toEqual(
          {
            kind: "forbidden",
          },
        );
        expect(await addFeedback(port, asBob, { body: "hi", now: T0, arrival })).toEqual({
          kind: "forbidden",
        });
      }
      const mailedBy = { via: "mailed", by: null } as const;
      expect(
        (await setAttendance(port, asBob, { attendance: "going", now: T0, arrival: mailedBy }))
          .kind,
      ).toBe("recorded");
      expect(
        (await addFeedback(port, asBob, { body: "hi", now: T0, arrival: SIGNED_IN })).kind,
      ).toBe("recorded");
      // Acknowledging too, after a material change asks for it.
      const ackd = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
        verified: true,
        requests: new Map([[bob, "ack"]]),
      });
      const bobAck = await access(port, ackd.id, bob);
      expect(await acknowledge(port, bobAck, { now: T0, arrival: copiedBy })).toEqual({
        kind: "forbidden",
      });
      expect((await acknowledge(port, bobAck, { now: T0, arrival: mailedBy })).kind).toBe(
        "recorded",
      );
    });

    it("verified (rc42): equals — nobody removes another, it isn't deleted or shortened, addresses show", async () => {
      const port = await makePort();
      const { dm, membership, ann } = await table(port, "ver-eq");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: { ...SESSION, startLocal: "2101-01-01T19:00", endLocal: "2101-01-01T23:00" },
        now: T0,
      });
      const asDm = () => access(port, event.id, dm.id);
      expect(
        (
          await addParticipant(port, await asDm(), {
            email: "resp-carl-ver-eq@example.org",
            editTier: "edit",
            visibility: "FULL",
            now: T0,
          })
        ).kind,
      ).toBe("added");
      const carl = await findOrCreatePerson(port, "resp-carl-ver-eq@example.org", { now: T0 });
      const emails = async () =>
        (await listParticipants(port, event.id)).map((p) => p.shown.email).sort();
      // Before: addresses are hidden unless their owner shows them (rc21).
      expect(await emails()).toEqual([null, null, null, null, null]);
      await setVerified(port, await asDm(), T0);

      // Every participant's address is shown, in each place a name is: people, answers, history.
      expect(await emails()).toEqual([
        "resp-ann-ver-eq@example.org",
        "resp-bob-ver-eq@example.org",
        "resp-carl-ver-eq@example.org",
        "resp-dm-ver-eq@example.org",
        "resp-ghost-ver-eq@example.org",
      ]);
      await setAttendance(port, await access(port, event.id, ann), {
        attendance: "going",
        now: T0,
        arrival: SIGNED_IN,
      });
      await addFeedback(port, await access(port, event.id, ann), {
        body: "hi",
        now: T0,
        arrival: SIGNED_IN,
      });
      const responses = await listResponses(port, await asDm());
      expect(responses.attendance.map((a) => a.shown.email)).toEqual([
        "resp-ann-ver-eq@example.org",
      ]);
      expect(responses.feedback.map((f) => f.shown.email)).toEqual(["resp-ann-ver-eq@example.org"]);
      expect((await listHistory(port, await asDm()))[0]?.actor?.email).toBe(
        "resp-dm-ver-eq@example.org",
      );

      // A proposal's proposer and decider, and who added whom, show their addresses too.
      expect(
        (
          await addParticipant(port, await asDm(), {
            email: "resp-dora-ver-eq@example.org",
            editTier: "propose",
            visibility: "FULL",
            now: T0,
          })
        ).kind,
      ).toBe("added");
      const dora = await findOrCreatePerson(port, "resp-dora-ver-eq@example.org", { now: T0 });
      const proposed = await proposeChange(port, await access(port, event.id, dora.id), {
        fields: {
          ...SESSION,
          title: "Moved",
          startLocal: "2101-01-01T19:00",
          endLocal: "2101-01-01T23:00",
        },
        now: T0,
      });
      if (proposed.kind !== "proposed") throw new Error(proposed.kind);
      expect(
        (await listProposals(port, await asDm())).pending.map((p) => p.proposer.email),
      ).toEqual(["resp-dora-ver-eq@example.org"]);
      await decideProposal(port, await asDm(), {
        proposalId: proposed.id,
        decision: "accept",
        now: T0,
      });
      expect(
        (await listProposals(port, await access(port, event.id, dora.id))).mine?.decidedBy?.email,
      ).toBe("resp-dm-ver-eq@example.org");
      expect(
        (await listHistory(port, await asDm())).find((h) => h.proposedBy !== null)?.proposedBy
          ?.email,
      ).toBe("resp-dora-ver-eq@example.org");
      expect(
        (await listParticipantChanges(port, await asDm())).map((c) => [
          c.person.email,
          c.actor.email,
        ]),
      ).toContainEqual(["resp-dora-ver-eq@example.org", "resp-dm-ver-eq@example.org"]);

      // Nobody removes anyone else; an editor may still leave by removing themselves.
      expect(await removeParticipant(port, await asDm(), { personId: ann, now: T0 })).toEqual({
        kind: "verified",
      });
      expect(
        (
          await removeParticipant(port, await access(port, event.id, carl.id), {
            personId: carl.id,
            now: T0,
          })
        ).kind,
      ).toBe("removed");

      // Not deleted for good, even cancelled and over; not kept shorter; longer is fine.
      await setCancelled(port, await asDm(), { cancelled: true, now: T0 });
      expect(await deleteEvent(port, await asDm(), later(1))).toEqual({ kind: "verified" });
      expect(await eventRetention(port, await asDm())).toBe(365);
      expect(await setEventRetention(port, await asDm(), 180)).toBe("verified");
      expect(await eventRetention(port, await asDm())).toBe(365);
      expect(await setEventRetention(port, await asDm(), 365)).toBe("saved"); // the same: not shorter
      expect(await setEventRetention(port, await asDm(), 730)).toBe("saved");
      expect(await eventRetention(port, await asDm())).toBe(730);
      expect(await setEventRetention(port, await access(port, event.id, ann), 730)).toBe(
        "forbidden",
      );
    });

    it("unverified, an editor still removes, deletes and shortens as before (rc21, rc23)", async () => {
      const port = await makePort();
      const { dm, membership, ann } = await table(port, "unver");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: { ...SESSION, startLocal: "2101-01-01T19:00", endLocal: "2101-01-01T23:00" },
        now: T0,
      });
      const asDm = () => access(port, event.id, dm.id);
      // A page opened before it was verified can't shorten it after: the statement checks too.
      const stale = await asDm();
      await setVerified(port, stale, T0);
      await setEventRetention(port, stale, 180);
      expect(await eventRetention(port, await asDm())).toBe(365);
      await port.batch([
        { sql: "UPDATE canonical_event SET verified_at = NULL WHERE id = ?", params: [event.id] },
      ]);
      expect(await setEventRetention(port, await asDm(), 180)).toBe("saved");
      expect(await eventRetention(port, await asDm())).toBe(180);
      expect((await removeParticipant(port, await asDm(), { personId: ann, now: T0 })).kind).toBe(
        "removed",
      );
      expect((await deleteEvent(port, await asDm(), later(1))).kind).toBe("deleted");
    });

    it("receipts that didn't go out (rc42): listed for the event, gone with the person or the event", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob, ghost } = await table(port, "unsent");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: { ...SESSION, startLocal: "2101-01-01T19:00", endLocal: "2101-01-01T23:00" },
        now: T0,
        verified: true,
      });
      await recordUnsentReceipt(port, {
        eventId: event.id,
        personId: ann,
        reason: "capped",
        now: T0,
      });
      await recordUnsentReceipt(port, {
        eventId: event.id,
        personId: bob,
        reason: "suppressed",
        now: later(1),
      });
      const listed = await listUnsentReceipts(port, await access(port, event.id, dm.id));
      expect(listed.map((u) => [u.personId, u.reason, u.at, u.shown.email])).toEqual([
        [ann, "capped", T0, "resp-ann-unsent@example.org"],
        [bob, "suppressed", later(1), "resp-bob-unsent@example.org"],
      ]);
      // Someone who can't see the event sees none.
      expect(await listUnsentReceipts(port, await access(port, event.id, ghost))).toEqual([]);
      // Erasing Ann takes hers; the event going takes the rest.
      await eraseAccount(port, ann, { now: later(2) });
      expect(
        (await listUnsentReceipts(port, await access(port, event.id, dm.id))).map(
          (u) => u.personId,
        ),
      ).toEqual([bob]);
      await port.batch(purgeEventStatements(event.id, later(3)));
      expect(
        await port.query({
          sql: "SELECT 1 AS n FROM receipt_unsent WHERE canonical_event_id = ?",
          params: [event.id],
        }),
      ).toEqual([]);
    });

    it("everyone agrees (rc42): all yes stops verifying; the asker's yes is the asking; one at a time", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob, ghost } = await table(port, "agree");
      const plain = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      expect(
        await askEveryone(port, await access(port, plain.id, ann), { kind: "unverify", now: T0 }),
      ).toEqual({
        kind: "not_verified",
      });
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
        verified: true,
      });
      // Someone who can't see it can't ask.
      expect(
        await askEveryone(port, await access(port, event.id, ghost), { kind: "unverify", now: T0 }),
      ).toEqual({
        kind: "forbidden",
      });
      const asked = await askEveryone(port, await access(port, event.id, ann), {
        kind: "unverify",
        now: T0,
      });
      if (asked.kind !== "asked") throw new Error(asked.kind);
      // A link for each other person who sees it — not the asker, not the HIDDEN member.
      expect(asked.links.map((l) => l.personId).sort()).toEqual([bob, dm.id].sort());
      expect(asked.outcome).toBeNull();
      expect(
        await askEveryone(port, await access(port, event.id, bob), { kind: "remove", now: T0 }),
      ).toEqual({
        kind: "open",
      });
      const [open] = await listVerifiedRequests(port, await access(port, event.id, dm.id), T0);
      expect(open).toMatchObject({ kind: "unverify", askedById: ann, outcome: null });
      expect(open?.waitingFor.map((w) => w.personId).sort()).toEqual([bob, dm.id].sort());

      // Someone who can't see it can't answer, and a link stops working when they can't.
      expect(
        await answerRequest(port, await access(port, event.id, ghost), {
          requestId: asked.requestId,
          answer: "yes",
          via: "session",
          now: T0,
        }),
      ).toEqual({ kind: "forbidden" });
      const dmToken = asked.links.find((l) => l.personId === dm.id)?.token ?? "";
      expect(await resolveRequestLink(port, dmToken, later(VERIFIED_REQUEST_TTL_MS))).toBeNull();
      await port.batch([
        {
          sql: "UPDATE event_participation SET visibility = 'HIDDEN' WHERE canonical_event_id = ? AND person_id = ?",
          params: [event.id, dm.id],
        },
      ]);
      expect(await resolveRequestLink(port, dmToken, T0)).toBeNull();
      await port.batch([
        {
          sql: "UPDATE event_participation SET visibility = 'FULL' WHERE canonical_event_id = ? AND person_id = ?",
          params: [event.id, dm.id],
        },
      ]);
      expect(await resolveRequestLink(port, dmToken, T0)).not.toBeNull();

      // Bob, by his mailed link; the DM, signed in. The last yes stops verifying.
      const bobLink = await resolveRequestLink(
        port,
        asked.links.find((l) => l.personId === bob)?.token ?? "",
        T0,
      );
      if (bobLink === null) throw new Error("link");
      expect(bobLink.requestId).toBe(asked.requestId);
      expect(
        await answerRequest(port, bobLink.access, {
          requestId: asked.requestId,
          answer: "yes",
          via: "mailed",
          now: later(1),
        }),
      ).toEqual({ kind: "recorded", outcome: null });
      expect((await access(port, event.id, dm.id)).event.verifiedAt).toBe(T0);
      expect(
        await answerRequest(port, await access(port, event.id, dm.id), {
          requestId: asked.requestId,
          answer: "yes",
          via: "session",
          now: later(2),
        }),
      ).toEqual({ kind: "recorded", outcome: "agreed" });
      const after = await access(port, event.id, dm.id);
      expect(after.event.verifiedAt).toBeNull();
      expect((await listHistory(port, after))[0]?.change).toEqual({
        verified: { before: 1, after: 0 },
      });
      const [done] = await listVerifiedRequests(port, after, later(3));
      expect(done).toMatchObject({ outcome: "agreed", closedAt: later(2), waitingFor: [] });
      expect(done?.answers.map((a) => [a.personId, a.answer, a.via])).toEqual([
        [ann, "yes", "session"],
        [bob, "yes", "mailed"],
        [dm.id, "yes", "session"],
      ]);
      // Decided: no more answers.
      expect(
        await answerRequest(port, after, {
          requestId: asked.requestId,
          answer: "no",
          via: "session",
          now: later(3),
        }),
      ).toEqual({ kind: "closed" });
    });

    it("everyone agrees (rc42): one no ends it; unanswered, it lapses after 14 days; newcomers must agree", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "agree-no");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: { ...SESSION, startLocal: "2101-01-01T19:00", endLocal: "2101-01-01T23:00" },
        now: T0,
        verified: true,
      });
      const ask = async (
        kind: "unverify" | "remove" | "shorten",
        now: string,
        retainDays?: number,
      ) => {
        const r = await askEveryone(port, await access(port, event.id, ann), {
          kind,
          now,
          ...(retainDays === undefined ? {} : { retainDays }),
        });
        if (r.kind !== "asked") throw new Error(r.kind);
        return r.requestId;
      };
      const answer = async (who: string, requestId: string, a: "yes" | "no", now: string) =>
        answerRequest(port, await access(port, event.id, who), {
          requestId,
          answer: a,
          via: "session",
          now,
        });

      // Bob says no: refused at once, nothing changes, and another may be asked.
      const first = await ask("remove", T0);
      expect(await answer(bob, first, "no", later(1))).toEqual({
        kind: "recorded",
        outcome: "refused",
      });
      expect((await access(port, event.id, dm.id)).event.verifiedAt).toBe(T0);

      // Unanswered: lapsed after 14 days, answers refused; asking again closes it as lapsed.
      const second = await ask("unverify", later(2));
      const past = later(2 + VERIFIED_REQUEST_TTL_MS);
      expect(await answer(dm.id, second, "yes", past)).toEqual({ kind: "closed" });
      expect(
        (await listVerifiedRequests(port, await access(port, event.id, dm.id), past)).map(
          (r) => r.outcome,
        ),
      ).toEqual(["refused", "lapsed"]);

      // Shorter only; a newcomer added meanwhile must agree too; agreed, the period changes.
      expect(
        await askEveryone(port, await access(port, event.id, ann), {
          kind: "shorten",
          retainDays: 730,
          now: past,
        }),
      ).toEqual({
        kind: "invalid",
      });
      // The period it has already is not shorter either.
      expect(
        (
          await askEveryone(port, await access(port, event.id, ann), {
            kind: "shorten",
            retainDays: 365,
            now: past,
          })
        ).kind,
      ).toBe("invalid");
      const third = await ask("shorten", past, 90);
      const rows = await port.query({
        sql: "SELECT closed_at, outcome FROM verified_request WHERE id = ?",
        params: [second],
      });
      expect(rows[0]).toEqual({ closed_at: later(2 + VERIFIED_REQUEST_TTL_MS), outcome: "lapsed" });
      expect(
        (
          await addParticipant(port, await access(port, event.id, dm.id), {
            email: "resp-cleo-agree-no@example.org",
            editTier: "view",
            visibility: "FULL",
            now: past,
          })
        ).kind,
      ).toBe("added");
      const cleo = await findOrCreatePerson(port, "resp-cleo-agree-no@example.org", { now: T0 });
      expect((await answer(bob, third, "yes", past)).kind).toBe("recorded");
      expect(await answer(dm.id, third, "yes", past)).toEqual({ kind: "recorded", outcome: null });
      expect(await answer(cleo.id, third, "yes", past)).toEqual({
        kind: "recorded",
        outcome: "agreed",
      });
      expect(await eventRetention(port, await access(port, event.id, dm.id))).toBe(90);
    });

    it("everyone agrees (rc42): removing for good purges it; alone, asking is agreeing", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "agree-rm");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
        verified: true,
      });
      const asked = await askEveryone(port, await access(port, event.id, dm.id), {
        kind: "remove",
        now: T0,
      });
      if (asked.kind !== "asked") throw new Error(asked.kind);
      await answerRequest(port, await access(port, event.id, ann), {
        requestId: asked.requestId,
        answer: "yes",
        via: "session",
        now: T0,
      });
      // Bob leaves instead of answering: he is no longer waited for.
      await leaveEvent(port, await access(port, event.id, bob), { now: T0 });
      expect(await findEventForParticipant(port, event.id, bob)).toBeNull();
      expect(
        await answerRequest(port, await access(port, event.id, ann), {
          requestId: asked.requestId,
          answer: "yes",
          via: "session",
          now: later(1),
        }),
      ).toEqual({ kind: "recorded", outcome: "agreed" });
      expect(await findEventForParticipant(port, event.id, dm.id)).toBeNull();
      expect(
        await port.query({
          sql: "SELECT 1 AS n FROM verified_request WHERE id = ?",
          params: [asked.requestId],
        }),
      ).toEqual([]);

      // Alone on it, the asking decides it.
      const solo = await createEvent(port, {
        creatorId: dm.id,
        group: null,
        fields: SESSION,
        now: T0,
        verified: true,
      });
      const alone = await askEveryone(port, await access(port, solo.id, dm.id), {
        kind: "unverify",
        now: T0,
      });
      expect(alone).toMatchObject({ kind: "asked", links: [], outcome: "agreed" });
      expect((await access(port, solo.id, dm.id)).event.verifiedAt).toBeNull();
    });

    it("a group's organizers make its new events verified; members can't (rc42)", async () => {
      const port = await makePort();
      const { dm, membership, ann } = await table(port, "ver-grp");
      const before = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const annMembership = await findGroupForMember(port, membership.group.id, ann);
      if (annMembership === null) throw new Error("membership");
      expect(await setGroupDefaultVerified(port, annMembership, true)).toBe(false);
      expect(
        (await createEvent(port, { creatorId: dm.id, group: membership, fields: SESSION, now: T0 }))
          .verifiedAt,
      ).toBeNull();
      expect(await setGroupDefaultVerified(port, membership, true)).toBe(true);
      const made = await createEvent(port, {
        creatorId: ann,
        group: annMembership,
        fields: SESSION,
        now: later(1),
        verified: false,
      });
      expect(made.verifiedAt).toBe(later(1));
      expect((await access(port, made.id, ann)).event.verifiedAt).toBe(later(1));
      // What was made before keeps its own; off again, new events aren't.
      expect((await access(port, before.id, dm.id)).event.verifiedAt).toBeNull();
      await setGroupDefaultVerified(port, membership, false);
      expect(
        (await createEvent(port, { creatorId: dm.id, group: membership, fields: SESSION, now: T0 }))
          .verifiedAt,
      ).toBeNull();
    });

    it("someone added later brings their group default for their own answers (rc42)", async () => {
      const port = await makePort();
      const { dm, membership, ann } = await table(port, "own-add");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const asDm = await access(port, event.id, dm.id);
      // Ann was on it from the start, before her default changed: hers stays as it was.
      await setDefaultOwnAnswersOnly(port, membership, ann, true);
      expect((await access(port, event.id, ann)).participation.ownAnswersOnly).toBe(false);
      // Removed and added again by address, she brings her group's default.
      expect((await removeParticipant(port, asDm, { personId: ann, now: T0 })).kind).toBe(
        "removed",
      );
      const readd = async (email: string) =>
        (
          await addParticipant(port, asDm, {
            email,
            editTier: "view",
            visibility: "FULL",
            now: later(1),
          })
        ).kind;
      expect(await readd("resp-ann-own-add@example.org")).toBe("added");
      expect((await access(port, event.id, ann)).participation.ownAnswersOnly).toBe(true);
      // Someone outside the group has no default: off.
      expect(await readd("resp-carl-own-add@example.org")).toBe("added");
      const carl = await findOrCreatePerson(port, "resp-carl-own-add@example.org", { now: T0 });
      expect((await access(port, event.id, carl.id)).participation.ownAnswersOnly).toBe(false);
    });

    it("agreeing and acknowledging record how they arrived too (rc42)", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "arrival-ask");
      const asked = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        requests: new Map([
          [ann, "accept"],
          [bob, "accept"],
        ]),
        now: T0,
      });
      const asDm = await access(port, asked.id, dm.id);
      const copied = await issueResponseLinks(port, asDm, { now: T0, only: ann, copy: true });
      if (copied.kind !== "issued") throw new Error(copied.kind);
      const annLink = await resolveResponseLink(port, copied.links[0]?.token ?? "", T0);
      if (annLink === null) throw new Error("expected link");
      await answerProposal(port, annLink.access, {
        answer: "accept",
        now: T0,
        arrival: annLink.arrival,
      });
      await answerProposal(port, await access(port, asked.id, bob), {
        answer: "accept",
        now: T0,
        arrival: SIGNED_IN,
      });
      const byPerson = async () =>
        Object.fromEntries(
          (await listRequests(port, await access(port, asked.id, dm.id))).map((r) => [
            r.personId,
            [r.state, r.arrival],
          ]),
        );
      expect(await byPerson()).toEqual({
        [ann]: ["accepted", { via: "copied", by: dm.id }],
        [bob]: ["accepted", { via: "session", by: null }],
      });

      // A material change asks both again; Ann looks again with a mailed link.
      const moved = await editEvent(port, await access(port, asked.id, dm.id), {
        fields: { ...SESSION, startLocal: "2101-10-20T20:00" },
        actorId: dm.id,
        now: T0,
      });
      expect(moved.kind).toBe("updated");
      const mailed = await issueResponseLinks(port, await access(port, asked.id, dm.id), {
        now: later(1),
        only: ann,
        copy: false,
      });
      if (mailed.kind !== "issued") throw new Error(mailed.kind);
      const second = await resolveResponseLink(port, mailed.links[0]?.token ?? "", later(1));
      if (second === null) throw new Error("expected link");
      expect(
        (await acknowledge(port, second.access, { now: later(1), arrival: second.arrival })).kind,
      ).toBe("recorded");
      expect((await byPerson())[ann]).toEqual(["accepted", { via: "mailed", by: null }]);

      // Bob looks again with a link the DM copied: who copied it is kept here too.
      const forBob = await issueResponseLinks(port, await access(port, asked.id, dm.id), {
        now: later(1),
        only: bob,
        copy: true,
      });
      if (forBob.kind !== "issued") throw new Error(forBob.kind);
      const bobLink = await resolveResponseLink(port, forBob.links[0]?.token ?? "", later(1));
      if (bobLink === null) throw new Error("expected link");
      await acknowledge(port, bobLink.access, { now: later(1), arrival: bobLink.arrival });
      expect((await byPerson())[bob]).toEqual(["accepted", { via: "copied", by: dm.id }]);

      // With nothing recorded (a link from before rc42), each stores that, over what was there.
      await editEvent(port, await access(port, asked.id, dm.id), {
        fields: { ...SESSION, startLocal: "2101-10-20T21:00" },
        actorId: dm.id,
        now: T0,
      });
      expect(
        (
          await acknowledge(port, await access(port, asked.id, bob), {
            now: later(2),
            arrival: null,
          })
        ).kind,
      ).toBe("recorded");
      expect((await byPerson())[bob]).toEqual(["accepted", null]);
      const fresh = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        requests: new Map([[ann, "accept"]]),
        now: T0,
      });
      expect(
        (
          await answerProposal(port, await access(port, fresh.id, ann), {
            answer: "accept",
            now: T0,
            arrival: null,
          })
        ).kind,
      ).toBe("recorded");
      expect(
        (await listRequests(port, await access(port, fresh.id, dm.id))).map((r) => r.arrival),
      ).toEqual([null]);
    });

    it("an organizer issues vote links to everyone asked to agree — not themself, not the others", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "issue");
      const poll = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        requests: new Map([[ann, "accept"]]),
        now: T0,
      });
      const issued = await issueResponseLinks(port, await access(port, poll.id, dm.id), {
        now: T0,
      });
      if (issued.kind !== "issued") throw new Error(issued.kind);
      expect(issued.action).toBe("vote");
      // Bob sees it but isn't asked: until it's agreed, it isn't his to answer (PARTY_RULE).
      expect(issued.links.map((l) => l.personId)).toEqual([ann]);
      expect((await access(port, poll.id, ann)).participation.responseState).toBe("pending");
      expect(
        await port.query({
          sql: "SELECT response_kind, response_state FROM event_participation WHERE canonical_event_id = ? AND person_id = ?",
          params: [poll.id, bob],
        }),
      ).toEqual([{ response_kind: "none", response_state: null }]);

      // The link IS Ann: it resolves to her access, and answering through it is attributed to her.
      const annLink = issued.links.find((l) => l.personId === ann);
      const resolved = await resolveResponseLink(port, annLink?.token ?? "", T0);
      expect(resolved).toMatchObject({
        action: "vote",
        access: { participation: { personId: ann } },
      });
      if (resolved === null) throw new Error("expected link");
      expect(
        (
          await answerProposal(port, resolved.access, {
            arrival: resolved.arrival,
            answer: "accept",
            now: T0,
          })
        ).kind,
      ).toBe("recorded");
      expect((await access(port, poll.id, ann)).participation.responseState).toBe("accepted");

      // Only hashes are stored.
      const stored = await port.query({
        sql: "SELECT token_hash FROM response_token WHERE canonical_event_id = ?",
        params: [poll.id],
      });
      for (const link of issued.links)
        expect(stored.map((r) => r.token_hash)).not.toContain(link.token);
      // A viewer can't send mail in the group's name.
      expect(
        (await issueResponseLinks(port, await access(port, poll.id, ann), { now: T0 })).kind,
      ).toBe("forbidden");
    });

    it("a scheduled event asks for attendance; a cancelled one asks nothing", async () => {
      const port = await makePort();
      const { dm, membership } = await table(port, "attendlinks");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const issued = await issueResponseLinks(port, await access(port, event.id, dm.id), {
        now: T0,
      });
      expect(issued).toMatchObject({ kind: "issued", action: "attend" });
      await port.batch([
        { sql: "UPDATE canonical_event SET status = 'cancelled' WHERE id = ?", params: [event.id] },
      ]);
      expect(
        (await issueResponseLinks(port, await access(port, event.id, dm.id), { now: T0 })).kind,
      ).toBe("closed");
    });

    it("resending within the interval is throttled and the old link keeps working", async () => {
      const port = await makePort();
      const { dm, membership, ann } = await table(port, "throttle");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const first = await issueResponseLinks(port, await access(port, event.id, dm.id), {
        now: T0,
      });
      if (first.kind !== "issued") throw new Error(first.kind);
      const again = await issueResponseLinks(port, await access(port, event.id, dm.id), {
        now: later(60_000),
      });
      expect(again).toMatchObject({ kind: "issued", links: [], throttled: 2 });
      const annFirst = first.links.find((l) => l.personId === ann)?.token ?? "";
      expect(await resolveResponseLink(port, annFirst, later(60_000))).not.toBeNull();
    });

    it("resending after the interval rotates: the old link dies, the new one works", async () => {
      const port = await makePort();
      const { dm, membership, ann } = await table(port, "rotate");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const first = await issueResponseLinks(port, await access(port, event.id, dm.id), {
        now: T0,
      });
      const t1 = later(RESPONSE_RESEND_INTERVAL_MS);
      const second = await issueResponseLinks(port, await access(port, event.id, dm.id), {
        now: t1,
      });
      if (first.kind !== "issued" || second.kind !== "issued") throw new Error("expected issued");
      expect(second.links).toHaveLength(2);
      const tokenOf = (links: typeof first.links) =>
        links.find((l) => l.personId === ann)?.token ?? "";
      expect(await resolveResponseLink(port, tokenOf(first.links), t1)).toBeNull();
      expect(await resolveResponseLink(port, tokenOf(second.links), t1)).not.toBeNull();
    });

    it("a link stops working when it expires, when its person leaves, or is made HIDDEN", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "revoke");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const issued = await issueResponseLinks(port, await access(port, event.id, dm.id), {
        now: T0,
      });
      if (issued.kind !== "issued") throw new Error(issued.kind);
      const tokenOf = (id: string) => issued.links.find((l) => l.personId === id)?.token ?? "";

      expect(
        await resolveResponseLink(port, tokenOf(ann), later(RESPONSE_TOKEN_TTL_MS - 1)),
      ).not.toBeNull();
      expect(
        await resolveResponseLink(port, tokenOf(ann), later(RESPONSE_TOKEN_TTL_MS)),
      ).toBeNull();

      await port.batch([
        {
          sql: "UPDATE event_participation SET visibility = 'HIDDEN' WHERE canonical_event_id = ? AND person_id = ?",
          params: [event.id, ann],
        },
        {
          sql: "DELETE FROM event_participation WHERE canonical_event_id = ? AND person_id = ?",
          params: [event.id, bob],
        },
      ]);
      expect(await resolveResponseLink(port, tokenOf(ann), T0)).toBeNull();
      expect(await resolveResponseLink(port, tokenOf(bob), T0)).toBeNull();
    });

    it("an undelivered link can be withdrawn, and then a resend is not throttled", async () => {
      const port = await makePort();
      const { dm, membership, ann } = await table(port, "undelivered");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: SESSION,
        now: T0,
      });
      const first = await issueResponseLinks(port, await access(port, event.id, dm.id), {
        now: T0,
      });
      if (first.kind !== "issued") throw new Error(first.kind);
      const annLink = first.links.find((l) => l.personId === ann);
      if (annLink === undefined) throw new Error("expected Ann's link");
      expect(annLink.visibility).toBe("FULL");
      await revokeUndeliveredLink(port, annLink); // say her mail bounced at the cap
      expect(await resolveResponseLink(port, annLink.token, T0)).toBeNull();
      const retry = await issueResponseLinks(port, await access(port, event.id, dm.id), {
        now: later(60_000),
      });
      // Ann gets a fresh link at once; Bob's is still inside the interval.
      expect(retry).toMatchObject({
        kind: "issued",
        throttled: 1,
        links: [expect.objectContaining({ personId: ann })],
      });
    });

    it("unknown and empty links resolve to nothing", async () => {
      const port = await makePort();
      expect(await resolveResponseLink(port, "not-a-real-token", T0)).toBeNull();
      expect(await resolveResponseLink(port, "", T0)).toBeNull();
    });
  });
}
