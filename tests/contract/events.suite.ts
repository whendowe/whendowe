// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  createEvent,
  type EventAccess,
  type EventFieldsInput,
  editEvent,
  findEventForParticipant,
  listGroupEvents,
  listHistory,
} from "../../src/events/event.js";
import { listParticipants } from "../../src/events/participation.js";
import { createGroup, findGroupForMember, type GroupMembership } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";

// Events on BOTH drivers. Everything here leans on one batch being atomic and on
// SQLite's changes() behaving the same on libsql and D1 — exactly what must not
// differ between them. Residue-tolerant: every test uses its own people.

const T0 = "2101-10-01T10:00:00.000Z";
const T1 = "2101-10-01T11:00:00.000Z";

const GAME_NIGHT: EventFieldsInput = {
  title: "Game night",
  description: null,
  location: "Ann's place",
  allDay: false,
  startLocal: "2101-10-20T19:00",
  endLocal: "2101-10-20T23:00",
  tzid: "Europe/Prague",
};

async function table(port: StoragePort, tag: string) {
  const dm = await findOrCreatePerson(port, `ev-dm-${tag}@example.org`, { now: T0 });
  const group = await createGroup(port, { name: "Table", creatorId: dm.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, dm.id);
  if (membership === null) throw new Error("expected membership");
  const invite = await createInvite(port, membership, {
    email: `ev-player-${tag}@example.org`,
    invitedBy: dm.id,
    editTier: "view",
    visibility: "DETAILS",
    now: T0,
  });
  if (!invite.ok) throw new Error(invite.reason);
  const accepted = await acceptInvite(port, invite.token, T0);
  if (accepted === null) throw new Error("expected accept");
  return { dm, membership, playerId: accepted.personId };
}

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("expected access");
  return a;
}

export function runEventsContract(makePort: () => Promise<StoragePort>): void {
  describe("events", () => {
    it("creates a group event: organizer edit+FULL, members on their group defaults, history row 1", async () => {
      const port = await makePort();
      const { dm, membership, playerId } = await table(port, "create");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: GAME_NIGHT,
        now: T0,
      });

      expect(event).toMatchObject({
        revision: 1,
        status: "scheduled",
        groupId: membership.group.id,
      });
      // Times normalised to the canonical wall-clock form.
      expect(event.startLocal).toBe("2101-10-20T19:00:00");
      const people = await listParticipants(port, event.id);
      expect(people.find((p) => p.personId === dm.id)).toMatchObject({
        editTier: "edit",
        visibility: "FULL",
      });
      expect(people.find((p) => p.personId === playerId)).toMatchObject({
        editTier: "view",
        visibility: "DETAILS",
      });
      const history = await listHistory(port, await access(port, event.id, dm.id));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ revision: 1, actorEmail: "ev-dm-create@example.org" });
    });

    it("an outsider cannot read an event — same answer as a missing one", async () => {
      const port = await makePort();
      const { dm, membership } = await table(port, "idor");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: GAME_NIGHT,
        now: T0,
      });
      const outsider = await findOrCreatePerson(port, "ev-outsider@example.org", { now: T0 });
      expect(await findEventForParticipant(port, event.id, outsider.id)).toBeNull();
      expect(await findEventForParticipant(port, "no-such-event", outsider.id)).toBeNull();
    });

    it("validates times: end after start, a real zone, real dates", async () => {
      const port = await makePort();
      const { dm } = await table(port, "valid");
      const make = (fields: Partial<EventFieldsInput>) =>
        createEvent(port, {
          creatorId: dm.id,
          group: null,
          fields: { ...GAME_NIGHT, ...fields },
          now: T0,
        });
      await expect(make({ endLocal: "2101-10-20T18:00" })).rejects.toThrow(/end after/);
      await expect(make({ tzid: "Mars/Olympus_Mons" })).rejects.toThrow(/time zone/);
      await expect(make({ startLocal: "2101-02-30T19:00" })).rejects.toThrow(/valid date/);
      await expect(make({ title: "   " })).rejects.toThrow(/title/);
    });

    it("all-day events are bare dates with no zone and an exclusive end", async () => {
      const port = await makePort();
      const { dm } = await table(port, "allday");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: null,
        fields: {
          ...GAME_NIGHT,
          allDay: true,
          startLocal: "2101-10-24",
          endLocal: "2101-10-25",
          tzid: "Europe/Prague",
        },
        now: T0,
      });
      expect(event).toMatchObject({
        allDay: true,
        startLocal: "2101-10-24",
        endLocal: "2101-10-25",
        tzid: null,
      });
      await expect(
        createEvent(port, {
          creatorId: dm.id,
          group: null,
          fields: {
            ...GAME_NIGHT,
            allDay: true,
            startLocal: "2101-10-24",
            endLocal: "2101-10-24",
            tzid: null,
          },
          now: T0,
        }),
      ).rejects.toThrow(/end after/);
    });

    it("an edit bumps the revision and logs only what changed, attributed", async () => {
      const port = await makePort();
      const { dm, membership } = await table(port, "edit");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: GAME_NIGHT,
        now: T0,
      });
      const result = await editEvent(port, await access(port, event.id, dm.id), {
        fields: { ...GAME_NIGHT, startLocal: "2101-10-20T20:00" },
        actorId: dm.id,
        now: T1,
      });
      expect(result.kind).toBe("updated");
      const history = await listHistory(port, await access(port, event.id, dm.id));
      expect(history[0]).toMatchObject({
        revision: 2,
        change: { startLocal: { before: "2101-10-20T19:00:00", after: "2101-10-20T20:00:00" } },
      });
      expect(Object.keys(history[0]?.change ?? {})).toEqual(["startLocal"]);
    });

    it("an edit that changes nothing writes nothing (§11)", async () => {
      const port = await makePort();
      const { dm } = await table(port, "noop");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: null,
        fields: GAME_NIGHT,
        now: T0,
      });
      const result = await editEvent(port, await access(port, event.id, dm.id), {
        fields: GAME_NIGHT,
        actorId: dm.id,
        now: T1,
      });
      expect(result.kind).toBe("unchanged");
      expect((await access(port, event.id, dm.id)).event.revision).toBe(1);
    });

    it("someone with view tier cannot edit", async () => {
      const port = await makePort();
      const { dm, membership, playerId } = await table(port, "view");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: GAME_NIGHT,
        now: T0,
      });
      const result = await editEvent(port, await access(port, event.id, playerId), {
        fields: { ...GAME_NIGHT, title: "Hijacked" },
        actorId: playerId,
        now: T1,
      });
      expect(result.kind).toBe("forbidden");
      expect((await access(port, event.id, dm.id)).event.title).toBe("Game night");
    });

    it("a stale edit is a conflict and changes nothing", async () => {
      const port = await makePort();
      const { dm } = await table(port, "stale");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: null,
        fields: GAME_NIGHT,
        now: T0,
      });
      const stale = await access(port, event.id, dm.id);
      expect(
        (
          await editEvent(port, stale, {
            fields: { ...GAME_NIGHT, title: "First" },
            actorId: dm.id,
            now: T1,
          })
        ).kind,
      ).toBe("updated");
      expect(
        (
          await editEvent(port, stale, {
            fields: { ...GAME_NIGHT, title: "Second" },
            actorId: dm.id,
            now: T1,
          })
        ).kind,
      ).toBe("conflict");
      const now = await access(port, event.id, dm.id);
      expect(now.event).toMatchObject({ title: "First", revision: 2 });
    });

    it("concurrent edits from the same stale read: exactly one wins", async () => {
      const port = await makePort();
      const { dm } = await table(port, "race");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: null,
        fields: GAME_NIGHT,
        now: T0,
      });
      const stale = await access(port, event.id, dm.id);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          editEvent(port, stale, {
            fields: { ...GAME_NIGHT, title: `Edit ${i}` },
            actorId: dm.id,
            now: T1,
          }),
        ),
      );
      expect(results.filter((r) => r.kind === "updated")).toHaveLength(1);
      const history = await listHistory(port, await access(port, event.id, dm.id));
      expect(history.map((h) => h.revision)).toEqual([2, 1]);
    });

    it("never logs a change that did not happen (the changes() guard)", async () => {
      // Simulate a path that bumped the revision WITHOUT a log row. A stale edit's
      // UPDATE then matches nothing — and without the guard its log insert would land
      // at the free revision 2, recording a change that never happened.
      const port = await makePort();
      const { dm } = await table(port, "guard");
      const event = await createEvent(port, {
        creatorId: dm.id,
        group: null,
        fields: GAME_NIGHT,
        now: T0,
      });
      const stale = await access(port, event.id, dm.id);
      await port.batch([
        { sql: "UPDATE canonical_event SET revision = 2 WHERE id = ?", params: [event.id] },
      ]);
      const result = await editEvent(port, stale, {
        fields: { ...GAME_NIGHT, title: "Phantom" },
        actorId: dm.id,
        now: T1,
      });
      expect(result.kind).toBe("conflict");
      const logged = await port.query({
        sql: "SELECT count(*) AS n FROM change_log WHERE canonical_event_id = ? AND revision = 2",
        params: [event.id],
      });
      expect(logged[0]?.n).toBe(0);
      expect((await access(port, event.id, dm.id)).event.title).toBe("Game night");
    });

    it("lists a group's events soonest first, only those the person takes part in", async () => {
      const port = await makePort();
      const { dm, membership } = await table(port, "list");
      const later = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: { ...GAME_NIGHT, startLocal: "2101-11-01T19:00", endLocal: "2101-11-01T22:00" },
        now: T0,
      });
      const sooner = await createEvent(port, {
        creatorId: dm.id,
        group: membership,
        fields: GAME_NIGHT,
        now: T0,
      });
      const groupMembership: GroupMembership = membership;
      expect((await listGroupEvents(port, groupMembership, dm.id)).map((a) => a.event.id)).toEqual([
        sooner.id,
        later.id,
      ]);
      const outsider = await findOrCreatePerson(port, "ev-list-outsider@example.org", { now: T0 });
      expect(await listGroupEvents(port, groupMembership, outsider.id)).toEqual([]);
    });
  });
}
