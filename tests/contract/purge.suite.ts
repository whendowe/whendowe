// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  createEvent,
  deleteEvent,
  type EventAccess,
  type EventFieldsInput,
  findEventForParticipant,
  setCancelled,
} from "../../src/events/event.js";
import {
  addParticipant,
  leaveEvent,
  listParticipantChanges,
} from "../../src/events/participation.js";
import { proposeChange } from "../../src/events/proposal.js";
import { addFeedback, issueResponseLinks } from "../../src/events/response.js";
import { createGroup, findGroupForMember, leaveGroup } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { addDraftEvent, castVote, findDraft, sendDraft, startDraft } from "../../src/plans/plan.js";
import { createThread, findThreadForMember, leaveThread } from "../../src/plans/thread.js";
import { purge, reapplyLedger } from "../../src/privacy/purge.js";

// Leaving, deleting and the purge pipeline (DESIGN §10 rc21) on BOTH drivers: the purge
// is a chain of DELETEs in one batch, exactly what must behave alike on D1 and libsql.
// Residue-tolerant: every test uses its own people and things.

const T0 = "2101-11-01T10:00:00.000Z";
const T1 = "2101-11-01T11:00:00.000Z";
const LATER = "2101-12-01T10:00:00.000Z"; // after the dinner below

const DINNER: EventFieldsInput = {
  title: "Sunday dinner",
  description: null,
  location: "Mara's",
  allDay: false,
  startLocal: "2101-11-20T18:00",
  endLocal: "2101-11-20T20:00",
  tzid: "Europe/Prague",
};

/** Rows anywhere that hang off an event: all of them must go with it. */
const EVENT_TABLES = [
  "event_participation",
  "event_feedback",
  "response_token",
  "event_change_proposal",
  "event_participant_change",
  "change_log",
  "slot_response",
  "event_candidate",
  "event_override",
  "projection",
] as const;

async function rowsOf(port: StoragePort, eventId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of EVENT_TABLES) {
    // Fixed table names from the list above, in a test.
    const rows = await port.query({
      sql: `SELECT count(*) AS n FROM ${t} WHERE canonical_event_id = ?`,
      params: [eventId],
    });
    out[t] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("expected access");
  return a;
}

const exists = async (port: StoragePort, sql: string, id: string) =>
  (await port.query({ sql, params: [id] })).length > 0;

/** Mara's dinner with Ann on it, with something in every table an event has. */
async function busyDinner(port: StoragePort, tag: string) {
  const mara = await findOrCreatePerson(port, `pg-mara-${tag}@example.org`, { now: T0 });
  const event = await createEvent(port, {
    creatorId: mara.id,
    group: null,
    fields: DINNER,
    now: T0,
  });
  const added = await addParticipant(port, await access(port, event.id, mara.id), {
    email: `pg-ann-${tag}@example.org`,
    editTier: "propose",
    visibility: "FULL",
    now: T0,
  });
  if (added.kind !== "added") throw new Error(added.kind);
  const ann = added.personId;
  await addFeedback(port, await access(port, event.id, ann), { body: "might be late", now: T0 });
  await issueResponseLinks(port, await access(port, event.id, mara.id), { now: T0 });
  await proposeChange(port, await access(port, event.id, ann), {
    fields: { ...DINNER, startLocal: "2101-11-20T19:00", endLocal: "2101-11-20T21:00" },
    now: T0,
  });
  return { mara: mara.id, ann, eventId: event.id };
}

export function runPurgeContract(makePort: () => Promise<StoragePort>): void {
  describe("the purge pipeline (DESIGN §10 rc21)", () => {
    it("purging an event removes every row under it, and only its own, and ledgers its id", async () => {
      const port = await makePort();
      const d = await busyDinner(port, "purge");
      const other = await busyDinner(port, "purge-other");
      const before = await rowsOf(port, d.eventId);
      expect(before.event_feedback).toBe(1);
      expect(before.event_change_proposal).toBe(1);
      expect(before.response_token).toBe(1);

      expect((await purge(port, "event", d.eventId, T1)).kind).toBe("purged");
      expect(Object.values(await rowsOf(port, d.eventId)).every((n) => n === 0)).toBe(true);
      expect(await exists(port, "SELECT 1 FROM canonical_event WHERE id = ?", d.eventId)).toBe(
        false,
      );
      expect(
        await exists(
          port,
          "SELECT 1 FROM erasure_ledger WHERE kind = 'event' AND id = ?",
          d.eventId,
        ),
      ).toBe(true);
      // The people stay: an event is not its people.
      expect(await exists(port, "SELECT 1 FROM person WHERE id = ?", d.ann)).toBe(true);
      expect(await rowsOf(port, other.eventId)).toEqual(await rowsOf(port, other.eventId));
      expect((await rowsOf(port, other.eventId)).event_feedback).toBe(1);
    });

    it("a restore from backup is undone by re-applying the ledger", async () => {
      const port = await makePort();
      const d = await busyDinner(port, "restore");
      await purge(port, "event", d.eventId, T1);
      // The backup brings the event row back.
      await port.batch([
        {
          sql: `INSERT INTO canonical_event
                  (id, revision, origin, owner_id, title, all_day, start_local, end_local, tzid,
                   status, created_at, updated_at)
                VALUES (?, 1, 'user_edit', ?, 'restored', 0, '2101-11-20T18:00', '2101-11-20T20:00',
                        'Europe/Prague', 'scheduled', ?, ?)`,
          params: [d.eventId, d.mara, T0, T0],
        },
      ]);
      expect(await reapplyLedger(port, LATER)).toBeGreaterThanOrEqual(1);
      expect(await exists(port, "SELECT 1 FROM canonical_event WHERE id = ?", d.eventId)).toBe(
        false,
      );
    });
  });

  describe("leaving and deleting (DESIGN §10 rc21)", () => {
    it("leaving an event takes your answers, notes, links and pending proposals with you, and says you left", async () => {
      const port = await makePort();
      const d = await busyDinner(port, "leave");
      const left = await leaveEvent(port, await access(port, d.eventId, d.ann), { now: T1 });
      expect(left).toEqual({ kind: "left", deleted: false });
      expect(await findEventForParticipant(port, d.eventId, d.ann)).toBeNull();
      const mine = async (table: string) =>
        (
          await port.query({
            sql: `SELECT count(*) AS n FROM ${table} WHERE canonical_event_id = ? AND person_id = ?`,
            params: [d.eventId, d.ann],
          })
        )[0]?.n;
      expect(await mine("event_feedback")).toBe(0);
      expect(await mine("response_token")).toBe(0);
      const pending = await port.query({
        sql: "SELECT status FROM event_change_proposal WHERE canonical_event_id = ? AND proposed_by = ?",
        params: [d.eventId, d.ann],
      });
      expect(pending.map((r) => r.status)).toEqual(["withdrawn"]);
      const trail = await listParticipantChanges(port, await access(port, d.eventId, d.mara));
      expect(trail[0]).toMatchObject({ action: "removed", personId: d.ann, actorId: d.ann });
    });

    it("the last editor leaving deletes the event for everyone", async () => {
      const port = await makePort();
      const d = await busyDinner(port, "last");
      const left = await leaveEvent(port, await access(port, d.eventId, d.mara), { now: T1 });
      expect(left).toEqual({ kind: "left", deleted: true });
      expect(await findEventForParticipant(port, d.eventId, d.ann)).toBeNull();
      expect(Object.values(await rowsOf(port, d.eventId)).every((n) => n === 0)).toBe(true);
    });

    it("an editor deletes an event once it's over or off; never while it's still ahead and on", async () => {
      const port = await makePort();
      const d = await busyDinner(port, "del");
      expect((await deleteEvent(port, await access(port, d.eventId, d.ann), T1)).kind).toBe(
        "forbidden",
      );
      expect((await deleteEvent(port, await access(port, d.eventId, d.mara), T1)).kind).toBe(
        "upcoming",
      );
      // Over: deletable.
      expect((await deleteEvent(port, await access(port, d.eventId, d.mara), LATER)).kind).toBe(
        "deleted",
      );
      expect(await exists(port, "SELECT 1 FROM canonical_event WHERE id = ?", d.eventId)).toBe(
        false,
      );

      // Cancelled, still ahead: deletable too.
      const e = await busyDinner(port, "del-cancel");
      await setCancelled(port, await access(port, e.eventId, e.mara), { cancelled: true, now: T1 });
      expect((await deleteEvent(port, await access(port, e.eventId, e.mara), T1)).kind).toBe(
        "deleted",
      );
    });

    it("an organizer leaving hands the group on; the last one out deletes it, its events stay", async () => {
      const port = await makePort();
      const mara = await findOrCreatePerson(port, "pg-mara-group@example.org", { now: T0 });
      const group = await createGroup(port, { name: "Jam", creatorId: mara.id, now: T0 });
      const membership = await findGroupForMember(port, group.id, mara.id);
      if (membership === null) throw new Error("membership");
      const invite = await createInvite(port, membership, {
        email: "pg-lena-group@example.org",
        invitedBy: mara.id,
        editTier: "view",
        visibility: "FULL",
        now: T0,
      });
      if (!invite.ok) throw new Error(invite.reason);
      const lena = (await acceptInvite(port, invite.token, T1))?.personId ?? "";
      const event = await createEvent(port, {
        creatorId: mara.id,
        group: membership,
        fields: DINNER,
        now: T1,
      });

      expect(await leaveGroup(port, membership, mara.id, T1)).toEqual({ deleted: false });
      expect((await findGroupForMember(port, group.id, lena))?.role).toBe("organizer");
      const asLena = await findGroupForMember(port, group.id, lena);
      if (asLena === null) throw new Error("lena");
      expect(await leaveGroup(port, asLena, lena, T1)).toEqual({ deleted: true });
      expect(await exists(port, "SELECT 1 FROM person_group WHERE id = ?", group.id)).toBe(false);
      // The event made from it is still Mara's, with no group behind it.
      const still = await access(port, event.id, mara.id);
      expect(still.event.groupId).toBeNull();
    });

    it("leaving a plan thread: drafts go, plans on the table are withdrawn, the organizer role passes", async () => {
      const port = await makePort();
      const adam = await findOrCreatePerson(port, "pg-adam-thread@example.org", { now: T0 });
      const mara = await findOrCreatePerson(port, "pg-mara-thread@example.org", { now: T0 });
      const thread = await createThread(port, {
        name: "Weeks",
        tzid: "Europe/Prague",
        creatorId: adam.id,
        memberIds: [mara.id],
        now: T0,
      });
      const gate = async (id: string) => {
        const a = await findThreadForMember(port, thread.id, id);
        if (a === null) throw new Error("member");
        return a;
      };
      const week = (title: string) => ({
        title,
        allDay: true,
        startLocal: "2101-11-07",
        endLocal: "2101-11-14",
        who: [] as string[],
        now: T0,
      });
      await startDraft(port, await gate(adam.id), {
        fromId: null,
        rest: false,
        replace: false,
        now: T0,
      });
      await addDraftEvent(port, await gate(adam.id), week("Sent"));
      const sent = await sendDraft(port, await gate(adam.id), { now: T0 });
      if (sent.kind !== "sent") throw new Error(sent.kind);
      await castVote(port, await gate(mara.id), { planId: sent.planId, answer: "no", now: T0 });
      await startDraft(port, await gate(adam.id), {
        fromId: null,
        rest: false,
        replace: false,
        now: T0,
      });
      await addDraftEvent(port, await gate(adam.id), week("Unsent"));

      expect(await leaveThread(port, await gate(adam.id), T1)).toEqual({ deleted: false });
      const asMara = await gate(mara.id);
      expect(asMara.thread.organizerId).toBe(mara.id);
      expect(asMara.members.map((m) => m.personId)).toEqual([mara.id]);
      const plans = await port.query({
        sql: "SELECT status FROM plan WHERE thread_id = ? ORDER BY created_at",
        params: [thread.id],
      });
      expect(plans.map((p) => p.status)).toEqual(["withdrawn"]); // the draft is gone
      expect(await findDraft(port, asMara)).toBeNull();

      expect(await leaveThread(port, asMara, T1)).toEqual({ deleted: true });
      expect(await exists(port, "SELECT 1 FROM plan_thread WHERE id = ?", thread.id)).toBe(false);
      expect(
        await exists(
          port,
          "SELECT 1 FROM erasure_ledger WHERE kind = 'thread' AND id = ?",
          thread.id,
        ),
      ).toBe(true);
    });
  });
}
