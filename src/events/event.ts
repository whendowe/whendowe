// SPDX-License-Identifier: AGPL-3.0-or-later
import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import { type Diff, diff } from "../changelog.js";
import type { SqlStatement, StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import type { GroupMembership } from "../people/group.js";
import { groupDefaults, type Participation, toParticipation } from "./participation.js";

// Canonical events (MVP-2, DESIGN §10/§11). Every accepted change bumps `revision`
// and appends a change_log row IN THE SAME BATCH — the attribution feed and the
// serialisation of history (§10: UNIQUE(canonical_event_id, revision)).
//
// AUTHORIZATION LIVES HERE, as with groups: the only read is findEventForParticipant,
// which returns null for "no such event" and "not yours" alike, and the only write
// takes the access it returned. A route cannot skip a check it has no way around.

const statusSchema = z.enum([
  "draft",
  "proposed",
  "scheduled",
  "declined",
  "withdrawn",
  "cancelled",
]);
export type EventStatus = z.infer<typeof statusSchema>;
/** The lifecycle values, derived from the schema rather than asserted with a cast. */
export const EVENT_STATUSES = statusSchema.options;

function isTimeZone(tzid: string): boolean {
  try {
    // Throws RangeError for an unknown zone, identically on Node and workerd.
    new Intl.DateTimeFormat("en", { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

/**
 * What a person can set on an event. Times are RFC 5545 wall clock (§10): a timed
 * event is `YYYY-MM-DDTHH:mm[:ss]` plus an IANA zone; an all-day event is a bare date
 * with no zone and an EXCLUSIVE end (the day after), exactly as RFC 5545 and Google do.
 */
export const eventFieldsSchema = z
  .object({
    title: z.string().trim().min(1, "Give the event a title.").max(200),
    description: z.string().trim().max(5000).nullable(),
    location: z.string().trim().max(500).nullable(),
    allDay: z.boolean(),
    startLocal: z.string(),
    endLocal: z.string(),
    tzid: z.string().nullable(),
  })
  .transform((v, ctx) => {
    const fail = (message: string) => {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    };
    try {
      if (v.allDay) {
        const start = Temporal.PlainDate.from(v.startLocal, { overflow: "reject" });
        const end = Temporal.PlainDate.from(v.endLocal, { overflow: "reject" });
        if (Temporal.PlainDate.compare(end, start) <= 0)
          return fail("An all-day event must end after it starts.");
        return { ...v, startLocal: start.toString(), endLocal: end.toString(), tzid: null };
      }
      if (v.tzid === null || !isTimeZone(v.tzid)) return fail("Choose a valid time zone.");
      const start = Temporal.PlainDateTime.from(v.startLocal, { overflow: "reject" });
      const end = Temporal.PlainDateTime.from(v.endLocal, { overflow: "reject" });
      if (Temporal.PlainDateTime.compare(end, start) <= 0)
        return fail("The event must end after it starts.");
      const fmt = (t: Temporal.PlainDateTime) => t.toString({ smallestUnit: "second" });
      return { ...v, startLocal: fmt(start), endLocal: fmt(end) };
    } catch {
      return fail("That isn't a valid date or time.");
    }
  });

export type EventFieldsInput = z.input<typeof eventFieldsSchema>;
export type EventFields = z.output<typeof eventFieldsSchema>;

export interface CanonicalEvent extends EventFields {
  readonly id: string;
  readonly revision: number;
  readonly status: EventStatus;
  readonly ownerId: string;
  readonly groupId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Proof that a person participates in an event, with their terms. */
export interface EventAccess {
  readonly event: CanonicalEvent;
  readonly participation: Participation;
}

const eventRowSchema = z.object({
  id: z.string(),
  revision: z.number(),
  status: statusSchema,
  owner_id: z.string(),
  group_id: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  all_day: z.number(),
  start_local: z.string(),
  end_local: z.string(),
  tzid: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const EVENT_COLUMNS = `e.id, e.revision, e.status, e.owner_id, e.group_id, e.title, e.description,
  e.location, e.all_day, e.start_local, e.end_local, e.tzid, e.created_at, e.updated_at`;

function toEvent(row: unknown): CanonicalEvent {
  const r = eventRowSchema.parse(row);
  return {
    id: r.id,
    revision: r.revision,
    status: r.status,
    ownerId: r.owner_id,
    groupId: r.group_id,
    title: r.title,
    description: r.description,
    location: r.location,
    allDay: r.all_day === 1,
    startLocal: r.start_local,
    endLocal: r.end_local,
    tzid: r.tzid,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The diffable, flat view of an event's fields (what the change log records). */
function flatten(f: EventFields): Record<string, string | number | null> {
  return {
    title: f.title,
    description: f.description,
    location: f.location,
    allDay: f.allDay ? 1 : 0,
    startLocal: f.startLocal,
    endLocal: f.endLocal,
    tzid: f.tzid,
  };
}

function logRow(
  eventId: string,
  revision: number,
  actor: string,
  change: Diff,
  now: string,
): SqlStatement {
  return {
    sql: `INSERT INTO change_log (canonical_event_id, revision, actor, source, diff, created_at)
          VALUES (?, ?, ?, 'ui', ?, ?)`,
    params: [eventId, revision, actor, JSON.stringify(change), now],
  };
}

/**
 * Create an event, optionally for a group. The creator takes part with `edit` +
 * `FULL`; every other group member with their group defaults. One batch: an event
 * nobody can see, or one with no history row, must never exist even briefly.
 */
export async function createEvent(
  storage: StoragePort,
  input: {
    readonly creatorId: string;
    readonly group: GroupMembership | null;
    readonly fields: EventFieldsInput;
    readonly status?: EventStatus;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<CanonicalEvent> {
  const fields = eventFieldsSchema.parse(input.fields);
  const id = (input.newId ?? (() => uuidv7()))();
  const status = input.status ?? "scheduled";
  const others =
    input.group === null
      ? []
      : (await groupDefaults(storage, input.group)).filter((m) => m.personId !== input.creatorId);

  await storage.batch([
    {
      sql: `INSERT INTO canonical_event
              (id, revision, origin, owner_id, group_id, title, description, location, all_day,
               start_local, end_local, tzid, status, created_at, updated_at)
            VALUES (?, 1, 'user_edit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        input.creatorId,
        input.group?.group.id ?? null,
        fields.title,
        fields.description,
        fields.location,
        fields.allDay ? 1 : 0,
        fields.startLocal,
        fields.endLocal,
        fields.tzid,
        status,
        input.now,
        input.now,
      ],
    },
    {
      sql: `INSERT INTO event_participation (canonical_event_id, person_id, edit_tier, visibility, created_at)
            VALUES (?, ?, 'edit', 'FULL', ?)`,
      params: [id, input.creatorId, input.now],
    },
    ...others.map((m) => ({
      sql: `INSERT INTO event_participation (canonical_event_id, person_id, edit_tier, visibility, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [id, m.personId, m.editTier, m.visibility, input.now],
    })),
    logRow(id, 1, input.creatorId, diff({}, { ...flatten(fields), status }), input.now),
  ]);

  return {
    ...fields,
    id,
    revision: 1,
    status,
    ownerId: input.creatorId,
    groupId: input.group?.group.id ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** The event IF the person takes part in it; null for "missing" and "not yours" alike. */
export async function findEventForParticipant(
  storage: StoragePort,
  eventId: string,
  personId: string,
): Promise<EventAccess | null> {
  const rows = await storage.query({
    sql: `SELECT ${EVENT_COLUMNS}, ep.canonical_event_id, ep.person_id, ep.edit_tier, ep.visibility, ep.attendance
          FROM canonical_event e JOIN event_participation ep ON ep.canonical_event_id = e.id
          WHERE e.id = ? AND ep.person_id = ?`,
    params: [eventId, personId],
  });
  if (rows[0] === undefined) return null;
  return { event: toEvent(rows[0]), participation: toParticipation(rows[0]) };
}

/**
 * Events in a group that this person takes part in, soonest first — each WITH that
 * person's participation, because a list must render every event at the viewer's own
 * visibility tier, never at the event's full detail.
 */
export async function listGroupEvents(
  storage: StoragePort,
  membership: GroupMembership,
  personId: string,
): Promise<EventAccess[]> {
  const rows = await storage.query({
    sql: `SELECT ${EVENT_COLUMNS}, ep.canonical_event_id, ep.person_id, ep.edit_tier, ep.visibility, ep.attendance
          FROM canonical_event e JOIN event_participation ep ON ep.canonical_event_id = e.id
          WHERE e.group_id = ? AND ep.person_id = ? AND ep.visibility <> 'HIDDEN'
          ORDER BY e.start_local, e.id`,
    params: [membership.group.id, personId],
  });
  return rows.map((row) => ({ event: toEvent(row), participation: toParticipation(row) }));
}

export type EditResult =
  | { readonly kind: "updated"; readonly event: CanonicalEvent }
  | { readonly kind: "unchanged" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "conflict" };

/**
 * Edit an event's fields, optimistically: only if nobody else changed it since the
 * caller read it (`access.event.revision`).
 *
 * One batch of two statements:
 *   UPDATE … SET …, revision = revision + 1 WHERE id = ? AND revision = expected
 *   INSERT INTO change_log … SELECT … WHERE changes() = 1
 * The guard on the insert matters: without it, an UPDATE that matched nothing (someone
 * else got there first) could still write a log row for a change that never happened.
 * And if a rival DID write revision expected+1, change_log's UNIQUE(event, revision)
 * rejects ours and the batch rolls back. Either way the caller learns of the conflict
 * by reading back whose row sits at expected+1.
 *
 * An empty diff is a no-op: no revision bump, no log row (§11 idempotency).
 */
export async function editEvent(
  storage: StoragePort,
  access: EventAccess,
  input: {
    readonly fields: EventFieldsInput;
    readonly actorId: string;
    readonly now: string;
    /**
     * The revision the person SAW — carried in the edit form. Defaults to the access's
     * own revision, which is only right when the read and the write are one action. For
     * a form, checking against a revision re-read at save time would let two people
     * editing at once silently overwrite each other: each would pass the check.
     */
    readonly expectedRevision?: number;
  },
): Promise<EditResult> {
  // MVP-2 slice 2A: only `edit` changes directly. `propose` becomes a proposal in 2E.
  if (access.participation.editTier !== "edit") return { kind: "forbidden" };

  const fields = eventFieldsSchema.parse(input.fields);
  const change = diff(flatten(access.event), flatten(fields));
  if (Object.keys(change).length === 0) return { kind: "unchanged" };

  const expected = input.expectedRevision ?? access.event.revision;
  const next = expected + 1;
  const log = logRow(access.event.id, next, input.actorId, change, input.now);
  try {
    await storage.batch([
      {
        sql: `UPDATE canonical_event SET title = ?, description = ?, location = ?, all_day = ?,
                start_local = ?, end_local = ?, tzid = ?, revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`,
        params: [
          fields.title,
          fields.description,
          fields.location,
          fields.allDay ? 1 : 0,
          fields.startLocal,
          fields.endLocal,
          fields.tzid,
          input.now,
          access.event.id,
          expected,
        ],
      },
      {
        sql: `INSERT INTO change_log (canonical_event_id, revision, actor, source, diff, created_at)
              SELECT ?, ?, ?, 'ui', ?, ? WHERE changes() = 1`,
        params: log.params,
      },
    ]);
  } catch {
    // UNIQUE(event, revision): a rival committed revision `next` first.
    return { kind: "conflict" };
  }

  const written = await storage.query({
    sql: "SELECT actor, diff FROM change_log WHERE canonical_event_id = ? AND revision = ?",
    params: [access.event.id, next],
  });
  const row = written[0];
  if (row === undefined || row.actor !== input.actorId || row.diff !== JSON.stringify(change)) {
    return { kind: "conflict" };
  }
  return {
    kind: "updated",
    event: { ...access.event, ...fields, revision: next, updatedAt: input.now },
  };
}

export interface HistoryEntry {
  readonly revision: number;
  readonly actorId: string;
  readonly actorEmail: string | null;
  readonly change: Diff;
  readonly at: string;
}

const historyRowSchema = z.object({
  revision: z.number(),
  actor: z.string(),
  email: z.string().nullable(),
  diff: z.string(),
  created_at: z.string(),
});

const diffSchema = z.record(
  z.string(),
  z.object({
    before: z.union([z.string(), z.number(), z.null()]),
    after: z.union([z.string(), z.number(), z.null()]),
  }),
);

/** Who changed what, newest first — for someone with proven access. */
export async function listHistory(
  storage: StoragePort,
  access: EventAccess,
): Promise<HistoryEntry[]> {
  const rows = await storage.query({
    sql: `SELECT c.revision, c.actor, p.email, c.diff, c.created_at
          FROM change_log c LEFT JOIN person p ON p.id = c.actor
          WHERE c.canonical_event_id = ?
          ORDER BY c.revision DESC`,
    params: [access.event.id],
  });
  return rows.map((row) => {
    const r = historyRowSchema.parse(row);
    return {
      revision: r.revision,
      actorId: r.actor,
      actorEmail: r.email,
      change: diffSchema.parse(JSON.parse(r.diff)),
      at: r.created_at,
    };
  });
}
