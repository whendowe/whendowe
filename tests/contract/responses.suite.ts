// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { createEvent, type EventAccess, findEventForParticipant } from "../../src/events/event.js";
import { createPoll, pollResults, vote } from "../../src/events/poll.js";
import {
  addFeedback,
  FEEDBACK_PER_PERSON_PER_EVENT,
  issueResponseLinks,
  listResponses,
  RESPONSE_RESEND_INTERVAL_MS,
  RESPONSE_TOKEN_TTL_MS,
  resolveResponseLink,
  revokeUndeliveredLink,
  setAttendance,
} from "../../src/events/response.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";

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
            attendance: "going",
            now: T0,
          })
        ).kind,
      ).toBe("recorded");
      expect(
        (
          await setAttendance(port, await access(port, event.id, ann), {
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
            attendance: "going",
            now: T0,
          })
        ).kind,
      ).toBe("forbidden");

      const poll = await createPoll(port, {
        creatorId: dm.id,
        group: membership,
        fields: {
          title: "When?",
          description: null,
          location: null,
          allDay: false,
          tzid: "Europe/Prague",
        },
        candidates: [
          { startLocal: "2101-10-20T19:00", endLocal: "2101-10-20T23:00" },
          { startLocal: "2101-10-21T19:00", endLocal: "2101-10-21T23:00" },
        ],
        now: T0,
      });
      expect(
        (
          await setAttendance(port, await access(port, poll.id, ann), {
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
        body: "  might be late  ",
        now: T0,
      });
      await addFeedback(port, await access(port, event.id, bob), {
        body: "bringing snacks",
        now: later(1000),
      });
      expect(
        (await addFeedback(port, await access(port, event.id, bob), { body: "   ", now: T0 })).kind,
      ).toBe("invalid");
      expect(
        (
          await addFeedback(port, await access(port, event.id, bob), {
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
          addFeedback(port, a, { body: `note ${i}`, now: T0 }),
        ),
      );
      expect(results.filter((r) => r.kind === "recorded")).toHaveLength(
        FEEDBACK_PER_PERSON_PER_EVENT,
      );
      expect((await listResponses(port, a)).feedback).toHaveLength(FEEDBACK_PER_PERSON_PER_EVENT);
    });

    it("an organizer issues vote links to everyone who can see the poll — not themself, not HIDDEN", async () => {
      const port = await makePort();
      const { dm, membership, ann, bob } = await table(port, "issue");
      const poll = await createPoll(port, {
        creatorId: dm.id,
        group: membership,
        fields: {
          title: "When?",
          description: null,
          location: null,
          allDay: false,
          tzid: "Europe/Prague",
        },
        candidates: [
          { startLocal: "2101-10-20T19:00", endLocal: "2101-10-20T23:00" },
          { startLocal: "2101-10-21T19:00", endLocal: "2101-10-21T23:00" },
        ],
        now: T0,
      });
      const issued = await issueResponseLinks(port, await access(port, poll.id, dm.id), {
        now: T0,
      });
      if (issued.kind !== "issued") throw new Error(issued.kind);
      expect(issued.action).toBe("vote");
      expect(issued.links.map((l) => l.personId).sort()).toEqual([ann, bob].sort());

      // The link IS Ann: it resolves to her access, and voting through it is attributed to her.
      const annLink = issued.links.find((l) => l.personId === ann);
      const resolved = await resolveResponseLink(port, annLink?.token ?? "", T0);
      expect(resolved).toMatchObject({
        action: "vote",
        access: { participation: { personId: ann } },
      });
      if (resolved === null) throw new Error("expected link");
      expect(
        (await vote(port, resolved.access, { answers: new Map([[0, "yes"]]), now: T0 })).kind,
      ).toBe("recorded");
      expect(
        (await pollResults(port, await access(port, poll.id, dm.id))).candidates[0]?.voters.map(
          (v) => v.personId,
        ),
      ).toEqual([ann]);

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
