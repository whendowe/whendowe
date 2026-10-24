// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  createEvent,
  type EventAccess,
  type EventFieldsInput,
  findEventForParticipant,
  listEventsFor,
  listHistory,
} from "../../src/events/event.js";
import {
  ADDS_PER_EVENT_PER_DAY,
  addParticipant,
  listParticipantChanges,
  listParticipants,
  removeParticipant,
  resolveInvitees,
} from "../../src/events/participation.js";
import { createPoll, pollResults, vote } from "../../src/events/poll.js";
import { issueResponseLinks } from "../../src/events/response.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson, findPersonByEmail } from "../../src/people/person.js";

// People added to and removed from an existing event (DESIGN rc15, slice 2F) on BOTH
// drivers. Each change is a reservation row that the participation write is gated on,
// in one batch — exactly the kind of statement chain that must behave alike on D1 and
// libsql. Residue-tolerant: every test uses its own people.

const T0 = "2101-11-01T10:00:00.000Z";
const T1 = "2101-11-01T11:00:00.000Z";
const NEXT_DAY = "2101-11-02T11:00:01.000Z"; // a day after the adds at T1

const DINNER: EventFieldsInput = {
  title: "Sunday dinner",
  description: null,
  location: "Mara's",
  allDay: false,
  startLocal: "2101-11-20T18:00",
  endLocal: "2101-11-20T20:00",
  tzid: "Europe/Prague",
};

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("expected access");
  return a;
}

/** Mara's dinner, with nobody else on it yet. */
async function dinner(port: StoragePort, tag: string) {
  const mara = await findOrCreatePerson(port, `pp-mara-${tag}@example.org`, { now: T0 });
  const event = await createEvent(port, {
    creatorId: mara.id,
    group: null,
    fields: DINNER,
    now: T0,
  });
  return { mara: mara.id, eventId: event.id };
}

async function add(
  port: StoragePort,
  eventId: string,
  by: string,
  email: string,
  editTier: "edit" | "propose" | "view" = "view",
  now = T1,
) {
  return addParticipant(port, await access(port, eventId, by), {
    email,
    editTier,
    visibility: "FULL",
    now,
  });
}

async function added(port: StoragePort, eventId: string, by: string, email: string, tier?: "edit") {
  const r = await add(port, eventId, by, email, tier);
  if (r.kind !== "added") throw new Error(`expected added, got ${r.kind}`);
  return r.personId;
}

export function runParticipantsContract(makePort: () => Promise<StoragePort>): void {
  describe("people on an existing event", () => {
    it("an editor adds an address; a person is created for it, at the given tiers", async () => {
      const port = await makePort();
      const d = await dinner(port, "add");
      const email = "pp-new-add@example.org";
      expect(await findPersonByEmail(port, email)).toBeNull();

      const r = await add(port, d.eventId, d.mara, "PP-New-Add@Example.org", "propose");
      expect(r).toMatchObject({ kind: "added", email });
      const ann = await findPersonByEmail(port, email);
      const mine = await access(port, d.eventId, ann?.id ?? "");
      expect(mine.participation).toMatchObject({
        editTier: "propose",
        visibility: "FULL",
        responseKind: "none",
      });

      const changes = await listParticipantChanges(port, mine);
      expect(changes).toEqual([
        { action: "added", personEmail: email, actorEmail: "pp-mara-add@example.org", at: T1 },
      ]);
      // Not a revision: the event's own history and revision are untouched.
      expect(mine.event.revision).toBe(1);
      expect(await listHistory(port, mine)).toHaveLength(1);
    });

    it("an added person's events include it, through no group; never at HIDDEN", async () => {
      const port = await makePort();
      const d = await dinner(port, "mine");
      const guest = await added(port, d.eventId, d.mara, "pp-guest-mine@example.org");
      expect((await listEventsFor(port, guest)).map((a) => a.event.id)).toEqual([d.eventId]);
      await port.query({
        sql: "UPDATE event_participation SET visibility = 'HIDDEN' WHERE canonical_event_id = ? AND person_id = ?",
        params: [d.eventId, guest],
      });
      expect(await listEventsFor(port, guest)).toEqual([]);
    });

    it("a new event names people directly; the creator stays an editor whatever a row says", async () => {
      const port = await makePort();
      const mara = await findOrCreatePerson(port, "pp-mara-named@example.org", { now: T0 });
      const people = await resolveInvitees(
        port,
        [
          { email: "pp-bob-named@example.org", editTier: "edit", visibility: "FULL" },
          { email: "pp-cat-named@example.org", editTier: "view", visibility: "BUSY" },
          { email: "pp-cat-named@example.org", editTier: "view", visibility: "DETAILS" },
          { email: mara.email, editTier: "view", visibility: "BUSY" },
        ],
        { now: T0 },
      );
      expect(people).toHaveLength(3); // Cat once, on her last terms
      const event = await createEvent(port, {
        creatorId: mara.id,
        group: null,
        fields: DINNER,
        now: T0,
        people,
      });
      const terms = (await listParticipants(port, event.id)).map(
        (p) => `${p.email} ${p.editTier} ${p.visibility}`,
      );
      expect(terms.sort()).toEqual([
        "pp-bob-named@example.org edit FULL",
        "pp-cat-named@example.org view DETAILS",
        "pp-mara-named@example.org edit FULL",
      ]);
    });

    it("only the edit tier adds and removes", async () => {
      const port = await makePort();
      const d = await dinner(port, "tiers");
      const viewer = await added(port, d.eventId, d.mara, "pp-viewer-tiers@example.org");
      const r = await add(port, d.eventId, viewer, "pp-other-tiers@example.org");
      expect(r.kind).toBe("forbidden");
      const removed = await removeParticipant(port, await access(port, d.eventId, viewer), {
        personId: viewer,
        now: T1,
      });
      expect(removed.kind).toBe("forbidden");
      expect(await findPersonByEmail(port, "pp-other-tiers@example.org")).toBeNull();
    });

    it("someone already taking part is not added twice, even by two editors at once", async () => {
      const port = await makePort();
      const d = await dinner(port, "twice");
      const ed = await added(port, d.eventId, d.mara, "pp-ed-twice@example.org", "edit");
      const email = "pp-guest-twice@example.org";
      const both = await Promise.all([
        add(port, d.eventId, d.mara, email),
        add(port, d.eventId, ed, email),
      ]);
      expect(both.map((r) => r.kind).sort()).toEqual(["added", "already"]);
      expect((await add(port, d.eventId, d.mara, email)).kind).toBe("already");
      const changes = await listParticipantChanges(port, await access(port, d.eventId, d.mara));
      expect(changes.filter((c) => c.personEmail === email)).toHaveLength(1);
    });

    it(`adds are bounded at ${ADDS_PER_EVENT_PER_DAY} per event per rolling day`, async () => {
      const port = await makePort();
      const d = await dinner(port, "bound");
      for (let i = 0; i < ADDS_PER_EVENT_PER_DAY; i++) {
        expect((await add(port, d.eventId, d.mara, `pp-b${i}-bound@example.org`)).kind).toBe(
          "added",
        );
      }
      const over = "pp-over-bound@example.org";
      expect((await add(port, d.eventId, d.mara, over)).kind).toBe("rate_limited");
      const later = await add(port, d.eventId, d.mara, over, "view", NEXT_DAY);
      expect(later.kind).toBe("added");
    });

    it("removing takes their participation, links and votes; their trail stays", async () => {
      const port = await makePort();
      const mara = await findOrCreatePerson(port, "pp-mara-rm@example.org", { now: T0 });
      const poll = await createPoll(port, {
        creatorId: mara.id,
        group: null,
        fields: { ...DINNER },
        candidates: [
          { startLocal: "2101-11-20T18:00", endLocal: "2101-11-20T20:00" },
          { startLocal: "2101-11-21T18:00", endLocal: "2101-11-21T20:00" },
        ],
        now: T0,
      });
      const bob = await added(port, poll.id, mara.id, "pp-bob-rm@example.org");
      const asBob = await access(port, poll.id, bob);
      expect(asBob.participation.responseKind).toBe("slot_vote"); // a poll's new person votes
      expect((await vote(port, asBob, { answers: new Map([[0, "yes"]]), now: T1 })).kind).not.toBe(
        "forbidden",
      );
      const links = await issueResponseLinks(port, await access(port, poll.id, mara.id), {
        now: T1,
        only: bob,
      });
      expect(links.kind === "issued" && links.links.map((l) => l.personId)).toEqual([bob]);

      const asMara = await access(port, poll.id, mara.id);
      expect((await removeParticipant(port, asMara, { personId: bob, now: T1 })).kind).toBe(
        "removed",
      );
      expect(await findEventForParticipant(port, poll.id, bob)).toBeNull();
      const tokens = await port.query({
        sql: "SELECT 1 AS present FROM response_token WHERE canonical_event_id = ? AND person_id = ?",
        params: [poll.id, bob],
      });
      expect(tokens).toEqual([]);
      const results = await pollResults(port, asMara);
      expect(results.candidates.flatMap((c) => c.voters)).toEqual([]);
      expect((await listParticipantChanges(port, asMara)).map((c) => c.action)).toEqual([
        "removed",
        "added",
      ]);
      // Gone is gone: removing again changes nothing.
      expect((await removeParticipant(port, asMara, { personId: bob, now: T1 })).kind).toBe(
        "not_taking_part",
      );
    });

    it("the creator stays, someone can always edit, and a proposal's awaited answer stays", async () => {
      const port = await makePort();
      const d = await dinner(port, "keep");
      const ed = await added(port, d.eventId, d.mara, "pp-ed-keep@example.org", "edit");
      const asEd = await access(port, d.eventId, ed);
      expect((await removeParticipant(port, asEd, { personId: d.mara, now: T1 })).kind).toBe(
        "creator",
      );
      // Were the creator not an editor, the last editor couldn't remove themselves.
      await port.query({
        sql: "UPDATE event_participation SET edit_tier = 'view' WHERE canonical_event_id = ? AND person_id = ?",
        params: [d.eventId, d.mara],
      });
      expect((await removeParticipant(port, asEd, { personId: ed, now: T1 })).kind).toBe(
        "last_editor",
      );
      expect(await findEventForParticipant(port, d.eventId, ed)).not.toBeNull();

      const ann = await findOrCreatePerson(port, "pp-ann-keep@example.org", { now: T0 });
      const mara = await findOrCreatePerson(port, "pp-mara2-keep@example.org", { now: T0 });
      // Ann's agreement is asked for through a group, the only way requests are made.
      const group = await createGroup(port, { name: "Pair", creatorId: mara.id, now: T0 });
      const membership = await findGroupForMember(port, group.id, mara.id);
      if (membership === null) throw new Error("expected membership");
      const invite = await createInvite(port, membership, {
        email: ann.email,
        invitedBy: mara.id,
        editTier: "view",
        visibility: "FULL",
        now: T0,
      });
      if (!invite.ok) throw new Error(invite.reason);
      await acceptInvite(port, invite.token, T0);
      const proposal = await createEvent(port, {
        creatorId: mara.id,
        group: membership,
        fields: DINNER,
        now: T0,
        requests: new Map([[ann.id, "accept"]]),
      });
      const asMara = await access(port, proposal.id, mara.id);
      expect(asMara.event.status).toBe("proposed");
      expect((await removeParticipant(port, asMara, { personId: ann.id, now: T1 })).kind).toBe(
        "awaited",
      );
      expect(await listParticipants(port, proposal.id)).toHaveLength(2);
    });
  });
}
