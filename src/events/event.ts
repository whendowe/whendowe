// SPDX-License-Identifier: AGPL-3.0-or-later
import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import { type Diff, diff } from "../changelog.js";
import type { SqlStatement, StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import type { GroupMembership } from "../people/group.js";
import { type Shown, shownAs } from "../people/person.js";
import { purge } from "../privacy/purge.js";
import { expandOccurrences, formatRRule, parseRRule } from "../recurrence.js";
import {
  type GroupDefault,
  groupDefaults,
  PARTICIPATION_COLUMNS,
  type Participation,
  toParticipation,
} from "./participation.js";

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
    /**
     * A whole series (DESIGN §10 rc13, slice 2E-3): an RRULE in the validated subset of
     * src/recurrence.ts, stored in its canonical form. Absent = a single event.
     */
    rrule: z.string().trim().max(500).nullable().default(null),
  })
  .transform((v, ctx) => {
    const fail = (message: string) => {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    };
    let times: { startLocal: string; endLocal: string; tzid: string | null };
    try {
      if (v.allDay) {
        const start = Temporal.PlainDate.from(v.startLocal, { overflow: "reject" });
        const end = Temporal.PlainDate.from(v.endLocal, { overflow: "reject" });
        if (Temporal.PlainDate.compare(end, start) <= 0)
          return fail("An all-day event must end after it starts.");
        times = { startLocal: start.toString(), endLocal: end.toString(), tzid: null };
      } else {
        if (v.tzid === null || !isTimeZone(v.tzid)) return fail("Choose a valid time zone.");
        const start = Temporal.PlainDateTime.from(v.startLocal, { overflow: "reject" });
        const end = Temporal.PlainDateTime.from(v.endLocal, { overflow: "reject" });
        if (Temporal.PlainDateTime.compare(end, start) <= 0)
          return fail("The event must end after it starts.");
        const fmt = (t: Temporal.PlainDateTime) => t.toString({ smallestUnit: "second" });
        times = { startLocal: fmt(start), endLocal: fmt(end), tzid: v.tzid };
      }
    } catch {
      return fail("That isn't a valid date or time.");
    }
    let rrule: string | null = null;
    if (v.rrule !== null && v.rrule !== "") {
      try {
        rrule = formatRRule(parseRRule(v.rrule));
      } catch {
        return fail("That repeat rule isn't supported.");
      }
      // A rule whose UNTIL is before the start would be a series with nothing in it.
      if (expandOccurrences({ ...times, rrule, exdates: [] }, 1).length === 0)
        return fail("The series must end after its first date.");
    }
    return { ...v, ...times, rrule };
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
  rrule: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * WORKFLOWS §5 / US-3: a proposal is between its parties. While an event is `proposed`
 * — and after it was `declined` or `withdrawn` — only its creator and the people asked
 * to decide (agree, or vote on a poll) can see it; everyone else sees scheduled
 * reality only. Part of the single access gate, so no page can forget it. A constant
 * fragment, never built from input.
 */
export const PARTY_RULE = `(e.status NOT IN ('proposed', 'declined', 'withdrawn')
  OR e.owner_id = ep.person_id OR ep.response_kind IN ('accept', 'slot_vote'))`;

const EVENT_COLUMNS = `e.id, e.revision, e.status, e.owner_id, e.group_id, e.title, e.description,
  e.location, e.all_day, e.start_local, e.end_local, e.tzid, e.rrule, e.created_at, e.updated_at`;

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
    rrule: r.rrule,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The diffable, flat view of an event's fields (what the change log records). */
export function flatten(f: EventFields): Record<string, string | number | null> {
  return {
    title: f.title,
    description: f.description,
    location: f.location,
    allDay: f.allDay ? 1 : 0,
    startLocal: f.startLocal,
    endLocal: f.endLocal,
    tzid: f.tzid,
    rrule: f.rrule,
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
 * Who takes part besides the creator: a group's members at their defaults — a COPY,
 * never a live link — and the people named directly, whose terms win. Once each.
 */
/**
 * An event made from a group COPIES each member's name and address choice there, as it
 * copies their tiers (DESIGN §10 rc21, rc15): a copy, never a live link.
 */
function copyAppearance(eventId: string, groupId: string): SqlStatement {
  return {
    sql: `UPDATE event_participation
          SET handle = (SELECT m.handle FROM group_member m
                        WHERE m.group_id = ? AND m.person_id = event_participation.person_id),
              show_email = (SELECT m.show_email FROM group_member m
                            WHERE m.group_id = ? AND m.person_id = event_participation.person_id)
          WHERE canonical_event_id = ?
            AND person_id IN (SELECT person_id FROM group_member WHERE group_id = ?)`,
    params: [groupId, groupId, eventId, groupId],
  };
}

async function takingPart(
  storage: StoragePort,
  input: {
    readonly creatorId: string;
    readonly group: GroupMembership | null;
    readonly people?: readonly GroupDefault[];
  },
): Promise<GroupDefault[]> {
  const fromGroup = input.group === null ? [] : await groupDefaults(storage, input.group);
  const byPerson = new Map<string, GroupDefault>();
  for (const m of [...fromGroup, ...(input.people ?? [])]) byPerson.set(m.personId, m);
  byPerson.delete(input.creatorId);
  return [...byPerson.values()];
}

/**
 * Create an event, optionally for a group. The creator takes part with `edit` +
 * `FULL`; everyone else on the terms takingPart gives them. One batch: an event
 * nobody can see, or one with no history row, must never exist even briefly.
 */
export async function createEvent(
  storage: StoragePort,
  input: {
    readonly creatorId: string;
    readonly group: GroupMembership | null;
    readonly fields: EventFieldsInput;
    readonly now: string;
    readonly newId?: () => string;
    /**
     * Who must agree ("accept") or should acknowledge ("ack") — DESIGN §10 rc13. Anyone
     * asked to agree makes the event a `proposed` one until the last of them accepts.
     * Ids that aren't taking part (or are the creator) are ignored.
     */
    readonly requests?: ReadonlyMap<string, "accept" | "ack">;
    /** People named directly, by email (DESIGN rc15); see createEventWith. */
    readonly people?: readonly GroupDefault[];
  },
): Promise<CanonicalEvent> {
  const members = (await takingPart(storage, input)).map((m) => m.personId);
  const requests = new Map(
    [...(input.requests ?? new Map<string, "accept" | "ack">())].filter(
      ([id]) => id !== input.creatorId && members.includes(id),
    ),
  );
  const needsAgreement = [...requests.values()].includes("accept");
  return createEventWith(
    storage,
    { ...input, status: needsAgreement ? "proposed" : "scheduled", responseKind: "none", requests },
    () => [],
  );
}

/**
 * createEvent for sibling modules in src/events (poll.ts): a lifecycle status, the
 * response everyone is asked for, and further rows written IN THE SAME BATCH — a poll
 * without its candidates must never exist, even briefly.
 */
export async function createEventWith(
  storage: StoragePort,
  input: {
    readonly creatorId: string;
    readonly group: GroupMembership | null;
    readonly fields: EventFieldsInput;
    readonly status: EventStatus;
    readonly responseKind: "none" | "slot_vote";
    readonly requests?: ReadonlyMap<string, "accept" | "ack">;
    /**
     * People named directly, at their own tiers (DESIGN rc15). With a group, they join its
     * members, and where someone is both, the terms named here win.
     */
    readonly people?: readonly GroupDefault[];
    readonly now: string;
    readonly newId?: () => string;
  },
  extra: (eventId: string) => SqlStatement[],
): Promise<CanonicalEvent> {
  const fields = eventFieldsSchema.parse(input.fields);
  const id = (input.newId ?? (() => uuidv7()))();
  const status = input.status;
  const others = await takingPart(storage, input);

  await storage.batch([
    {
      sql: `INSERT INTO canonical_event
              (id, revision, origin, owner_id, group_id, title, description, location, all_day,
               start_local, end_local, tzid, rrule, status, created_at, updated_at)
            VALUES (?, 1, 'user_edit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        fields.rrule,
        status,
        input.now,
        input.now,
      ],
    },
    {
      sql: `INSERT INTO event_participation (canonical_event_id, person_id, edit_tier, visibility, response_kind, created_at)
            VALUES (?, ?, 'edit', 'FULL', ?, ?)`,
      params: [id, input.creatorId, input.responseKind, input.now],
    },
    ...others.map((m) => {
      const requested = input.requests?.get(m.personId);
      return {
        sql: `INSERT INTO event_participation
                (canonical_event_id, person_id, edit_tier, visibility, response_kind, response_state, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          m.personId,
          m.editTier,
          m.visibility,
          requested ?? input.responseKind,
          requested === undefined ? null : "pending",
          input.now,
        ],
      };
    }),
    ...(input.group === null ? [] : [copyAppearance(id, input.group.group.id)]),
    ...extra(id),
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
    sql: `SELECT ${EVENT_COLUMNS}, ${PARTICIPATION_COLUMNS}
          FROM canonical_event e JOIN event_participation ep ON ep.canonical_event_id = e.id
          WHERE e.id = ? AND ep.person_id = ? AND ${PARTY_RULE}`,
    params: [eventId, personId],
  });
  if (rows[0] === undefined) return null;
  return { event: toEvent(rows[0]), participation: toParticipation(rows[0]) };
}

/**
 * A group page's events, soonest first (DESIGN rc15): those this person takes part in
 * that were created from this group (`group_id`, provenance), and any other they share
 * with at least one other current member — an event made by email with the same people
 * is here too. Not a feed of "the group's events": joining a group never adds you to
 * its earlier events, and an event you aren't on is never listed.
 *
 * Who else takes part is part of an event's `participants`, which not every tier may
 * see (WORKFLOWS US-6). So the shared-with-members rule applies only at FULL: the list
 * never tells a viewer about a member they couldn't see on the event's own page.
 *
 * Each WITH this person's participation, to render at their own tier.
 */
export async function listGroupEvents(
  storage: StoragePort,
  membership: GroupMembership,
  personId: string,
): Promise<EventAccess[]> {
  const rows = await storage.query({
    sql: `SELECT ${EVENT_COLUMNS}, ${PARTICIPATION_COLUMNS}
          FROM canonical_event e JOIN event_participation ep ON ep.canonical_event_id = e.id
          WHERE ep.person_id = ? AND ep.visibility <> 'HIDDEN' AND ${PARTY_RULE}
            AND (e.group_id = ? OR (ep.visibility = 'FULL'
              AND EXISTS (SELECT 1 FROM event_participation o
                            JOIN group_member m ON m.person_id = o.person_id AND m.group_id = ?
                          WHERE o.canonical_event_id = e.id AND o.person_id <> ?)))
          ORDER BY e.start_local, e.id`,
    params: [personId, membership.group.id, membership.group.id, personId],
  });
  return rows.map((row) => ({ event: toEvent(row), participation: toParticipation(row) }));
}

/**
 * Every event this person takes part in, at any visibility but HIDDEN, soonest first —
 * "Your events" (DESIGN rc15). The event is the primary object: this does not go
 * through groups, so an event someone was added to directly is here too. Each comes
 * WITH the person's participation, to render at their own tier.
 */
export async function listEventsFor(
  storage: StoragePort,
  personId: string,
): Promise<EventAccess[]> {
  const rows = await storage.query({
    sql: `SELECT ${EVENT_COLUMNS}, ${PARTICIPATION_COLUMNS}
          FROM canonical_event e JOIN event_participation ep ON ep.canonical_event_id = e.id
          WHERE ep.person_id = ? AND ep.visibility <> 'HIDDEN' AND ${PARTY_RULE}
          ORDER BY e.start_local, e.id`,
    params: [personId],
  });
  return rows.map((row) => ({ event: toEvent(row), participation: toParticipation(row) }));
}

/** Fields whose change alters someone's plans (DESIGN §10 rc13): not title, not notes. */
const MATERIAL_FIELDS: ReadonlySet<string> = new Set([
  "rrule",
  "startLocal",
  "endLocal",
  "tzid",
  "allDay",
  "location",
]);

export function isMaterial(change: Diff): boolean {
  return Object.keys(change).some((field) => MATERIAL_FIELDS.has(field));
}

export type EditResult =
  | { readonly kind: "updated"; readonly event: CanonicalEvent }
  | { readonly kind: "unchanged" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "conflict" };

/**
 * The statements of one optimistic field edit, in order:
 *   UPDATE … SET …, revision = revision + 1 WHERE id = ? AND revision = expected [AND gate]
 *   INSERT INTO change_log … SELECT … WHERE changes() = 1
 *   …`afterLog`, each of which must itself be guarded by changes() = 1
 *   a material change's reack, guarded the same way
 * so every statement after the first happens exactly when the edit did. Shared by a
 * direct edit and an accepted change proposal (proposal.ts).
 */
export function fieldEditStatements(input: {
  readonly eventId: string;
  readonly expected: number;
  readonly fields: EventFields;
  readonly change: Diff;
  readonly actorId: string;
  readonly now: string;
  readonly gate?: SqlStatement;
  readonly afterLog?: readonly SqlStatement[];
}): SqlStatement[] {
  const { fields } = input;
  const log = logRow(input.eventId, input.expected + 1, input.actorId, input.change, input.now);
  return [
    {
      sql: `UPDATE canonical_event SET title = ?, description = ?, location = ?, all_day = ?,
              start_local = ?, end_local = ?, tzid = ?, rrule = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?${input.gate === undefined ? "" : ` AND ${input.gate.sql}`}`,
      params: [
        fields.title,
        fields.description,
        fields.location,
        fields.allDay ? 1 : 0,
        fields.startLocal,
        fields.endLocal,
        fields.tzid,
        fields.rrule,
        input.now,
        input.eventId,
        input.expected,
        ...(input.gate?.params ?? []),
      ],
    },
    {
      sql: `INSERT INTO change_log (canonical_event_id, revision, actor, source, diff, created_at)
            SELECT ?, ?, ?, 'ui', ?, ? WHERE changes() = 1`,
      params: log.params,
    },
    ...(input.afterLog ?? []),
    // A material change (time, date, place — DESIGN §10 rc13) asks everyone who had
    // agreed or acknowledged to look again. Guarded by changes() on the statement before,
    // so it happens exactly when the edit did.
    ...(isMaterial(input.change)
      ? [
          {
            sql: `UPDATE event_participation SET response_state = 'reack'
                  WHERE canonical_event_id = ? AND response_state IN ('accepted', 'acknowledged')
                    AND changes() = 1`,
            params: [input.eventId],
          },
        ]
      : []),
  ];
}

/**
 * Edit an event's fields, optimistically: only if nobody else changed it since the
 * caller read it (`access.event.revision`).
 *
 * One batch (fieldEditStatements), whose first two statements are:
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
  // Only `edit` changes directly; `propose` makes a change proposal (proposal.ts).
  if (access.participation.editTier !== "edit") return { kind: "forbidden" };
  // A poll's time is decided by confirming a candidate (poll.ts), not by editing a
  // placeholder; changing candidates is slice 2E. A confirm that lands between this
  // check and the write bumps the revision, so the optimistic guard still catches it.
  if (access.event.status === "proposed") return { kind: "forbidden" };

  const fields = eventFieldsSchema.parse(input.fields);
  const change = diff(flatten(access.event), flatten(fields));
  if (Object.keys(change).length === 0) return { kind: "unchanged" };

  const expected = input.expectedRevision ?? access.event.revision;
  const next = expected + 1;
  try {
    await storage.batch(
      fieldEditStatements({
        eventId: access.event.id,
        expected,
        fields,
        change,
        actorId: input.actorId,
        now: input.now,
      }),
    );
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
  /** As the event's people see the actor (DESIGN §10 rc21); null when it wasn't a person. */
  readonly actor: Shown | null;
  /** When this revision was an accepted change proposal: who proposed it (proposal.ts). */
  readonly proposedBy: Shown | null;
  readonly change: Diff;
  readonly at: string;
}

const historyRowSchema = z.object({
  revision: z.number(),
  actor: z.string(),
  email: z.string().nullable(),
  display_name: z.string().nullable(),
  handle: z.string().nullable(),
  show_email: z.number().nullable(),
  proposer_id: z.string().nullable(),
  proposer_email: z.string().nullable(),
  proposer_display_name: z.string().nullable(),
  proposer_handle: z.string().nullable(),
  proposer_show_email: z.number().nullable(),
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
    // An accepted proposal is applied only at its base revision, so it IS revision
    // base_revision + 1 — exactly one per revision, no extra column needed.
    sql: `SELECT c.revision, c.actor, p.email, p.display_name, ap.handle, ap.show_email,
                 ecp.proposed_by AS proposer_id, pp.email AS proposer_email,
                 pp.display_name AS proposer_display_name, xp.handle AS proposer_handle,
                 xp.show_email AS proposer_show_email, c.diff, c.created_at
          FROM change_log c LEFT JOIN person p ON p.id = c.actor
            LEFT JOIN event_participation ap
              ON ap.canonical_event_id = c.canonical_event_id AND ap.person_id = c.actor
            LEFT JOIN event_change_proposal ecp ON ecp.canonical_event_id = c.canonical_event_id
              AND ecp.status = 'accepted' AND ecp.base_revision + 1 = c.revision
            LEFT JOIN person pp ON pp.id = ecp.proposed_by
            LEFT JOIN event_participation xp
              ON xp.canonical_event_id = c.canonical_event_id AND xp.person_id = ecp.proposed_by
          WHERE c.canonical_event_id = ?
          ORDER BY c.revision DESC`,
    params: [access.event.id],
  });
  return rows.map((row) => {
    const r = historyRowSchema.parse(row);
    return {
      revision: r.revision,
      actorId: r.actor,
      actor:
        r.email === null
          ? null
          : shownAs(
              r.actor,
              {
                email: r.email,
                display_name: r.display_name,
                handle: r.handle,
                show_email: r.show_email,
              },
              access.event.id,
            ),
      proposedBy:
        r.proposer_id === null || r.proposer_email === null
          ? null
          : shownAs(
              r.proposer_id,
              {
                email: r.proposer_email,
                display_name: r.proposer_display_name,
                handle: r.proposer_handle,
                show_email: r.proposer_show_email,
              },
              access.event.id,
            ),
      change: diffSchema.parse(JSON.parse(r.diff)),
      at: r.created_at,
    };
  });
}

// --- Lifecycle transitions (WORKFLOWS §5, DESIGN §10 rc13) ------------------------------

/**
 * The two statements every lifecycle transition ends with: flip the status — only from
 * `from`, only if `gate` — and log it, attributed, only if the flip happened. When a
 * caller puts a statement before these (an answer being recorded), the flip is further
 * gated on THAT having changed a row: no answer recorded, no transition.
 */
export function transitionStatements(input: {
  readonly eventId: string;
  readonly from: EventStatus;
  readonly to: EventStatus;
  readonly actorId: string;
  readonly now: string;
  readonly afterPrevious: boolean;
  readonly gate?: SqlStatement;
}): SqlStatement[] {
  const change = diff({ status: input.from }, { status: input.to });
  return [
    {
      sql: `UPDATE canonical_event SET status = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND status = ?${input.afterPrevious ? " AND changes() = 1" : ""}${
              input.gate === undefined ? "" : ` AND ${input.gate.sql}`
            }`,
      params: [input.to, input.now, input.eventId, input.from, ...(input.gate?.params ?? [])],
    },
    {
      sql: `INSERT INTO change_log (canonical_event_id, revision, actor, source, diff, created_at)
            SELECT ?, (SELECT revision FROM canonical_event WHERE id = ?), ?, 'ui', ?, ?
            WHERE changes() = 1`,
      params: [input.eventId, input.eventId, input.actorId, JSON.stringify(change), input.now],
    },
  ];
}

export type TransitionResult =
  | { readonly kind: "done"; readonly status: EventStatus }
  | { readonly kind: "forbidden" }
  | { readonly kind: "closed" };

async function currentStatus(storage: StoragePort, eventId: string): Promise<EventStatus> {
  const rows = await storage.query({
    sql: "SELECT status FROM canonical_event WHERE id = ?",
    params: [eventId],
  });
  return statusSchema.parse(rows[0]?.status);
}

async function runTransition(
  storage: StoragePort,
  access: EventAccess,
  from: EventStatus,
  to: EventStatus,
  input: { readonly actorId: string; readonly now: string },
): Promise<TransitionResult> {
  if (access.event.status !== from) return { kind: "closed" };
  await storage.batch(
    transitionStatements({ eventId: access.event.id, from, to, ...input, afterPrevious: false }),
  );
  const status = await currentStatus(storage, access.event.id);
  return status === to ? { kind: "done", status } : { kind: "closed" };
}

/** The creator takes back a proposal (or a poll) nobody has settled yet. */
export async function withdrawProposal(
  storage: StoragePort,
  access: EventAccess,
  input: { readonly now: string },
): Promise<TransitionResult> {
  if (access.event.ownerId !== access.participation.personId) return { kind: "forbidden" };
  return runTransition(storage, access, "proposed", "withdrawn", {
    actorId: access.participation.personId,
    now: input.now,
  });
}

/** Editors cancel a scheduled event, or restore a cancelled one (US-9), attributed. */
export async function setCancelled(
  storage: StoragePort,
  access: EventAccess,
  input: { readonly cancelled: boolean; readonly now: string },
): Promise<TransitionResult> {
  if (access.participation.editTier !== "edit") return { kind: "forbidden" };
  const [from, to]: [EventStatus, EventStatus] = input.cancelled
    ? ["scheduled", "cancelled"]
    : ["cancelled", "scheduled"];
  return runTransition(storage, access, from, to, {
    actorId: access.participation.personId,
    now: input.now,
  });
}

// --- Deleting (DESIGN §10 rc21 *Privacy basics*) ---------------------------------------

/**
 * Whether an event is over: its end, in its own zone, has passed. A series never is. An
 * all-day event has no zone (a floating date), so it is over once its last day has
 * ended everywhere — the last zone on Earth, UTC−12.
 */
export function isOver(event: CanonicalEvent, now: string): boolean {
  if (event.rrule !== null) return false;
  const end = Temporal.PlainDateTime.from(event.endLocal).toZonedDateTime(
    event.tzid ?? "Etc/GMT+12",
  );
  return Temporal.Instant.compare(end.toInstant(), Temporal.Instant.from(now)) <= 0;
}

export type DeleteEventResult =
  | { readonly kind: "deleted" }
  | { readonly kind: "forbidden" }
  /** Still ahead and still on: cancel it first, so its people are told (rc13). */
  | { readonly kind: "upcoming" }
  /** Mirrored into a calendar still (MVP-4): purged once the mirrors are gone. */
  | { readonly kind: "mirrored" };

/** Whether this event may be deleted now, by this participant — for the page's buttons. */
export function canDelete(access: EventAccess, now: string): DeleteEventResult["kind"] {
  if (access.participation.editTier !== "edit") return "forbidden";
  const live = access.event.status === "scheduled" || access.event.status === "proposed";
  return live && !isOver(access.event, now) ? "upcoming" : "deleted";
}

/** Delete an event for everyone: any editor, once it's over or no longer on (§10 rc21). */
export async function deleteEvent(
  storage: StoragePort,
  access: EventAccess,
  now: string,
): Promise<DeleteEventResult> {
  const allowed = canDelete(access, now);
  if (allowed !== "deleted") return { kind: allowed };
  const done = await purge(storage, "event", access.event.id, now);
  return { kind: done.kind === "purged" ? "deleted" : "mirrored" };
}
