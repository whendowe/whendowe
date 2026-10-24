// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import type { GroupMembership } from "../people/group.js";
import {
  type EditTier,
  editTierSchema,
  type Visibility,
  visibilitySchema,
} from "../people/invite.js";
import { findOrCreatePerson } from "../people/person.js";
import type { EventAccess } from "./event.js";

// Who takes part in an event, and on what terms (DESIGN §10 rc7). Two independent
// axes per person: what they may CHANGE (edit tier) and what they SEE (visibility).

export const responseKindSchema = z.enum(["none", "ack", "accept", "slot_vote"]);
export type ResponseKind = z.infer<typeof responseKindSchema>;
/**
 * DESIGN §10 rc13. The column has no CHECK (SQLite can't add one without a rebuild,
 * §16), so THIS is the constraint: every read of response_state goes through it.
 */
export const responseStateSchema = z.enum([
  "pending",
  "accepted",
  "declined",
  "acknowledged",
  "reack",
]);
export type ResponseState = z.infer<typeof responseStateSchema>;

export interface Participation {
  readonly eventId: string;
  readonly personId: string;
  readonly editTier: EditTier;
  readonly visibility: Visibility;
  readonly attendance: "going" | "maybe" | "not_going" | null;
  /** What the organizer asked this person for, and their answer so far. */
  readonly responseKind: ResponseKind;
  readonly responseState: ResponseState | null;
}

/** The SQL column list toParticipation reads, aliased `ep`. */
export const PARTICIPATION_COLUMNS =
  "ep.canonical_event_id, ep.person_id, ep.edit_tier, ep.visibility, ep.attendance, ep.response_kind, ep.response_state";

export interface ParticipantView extends Participation {
  readonly email: string;
  readonly displayName: string | null;
}

export interface GroupDefault {
  readonly personId: string;
  readonly editTier: EditTier;
  readonly visibility: Visibility;
}

const defaultRowSchema = z.object({
  person_id: z.string(),
  default_edit_tier: editTierSchema,
  default_visibility: visibilitySchema,
});

/** The members of a group with their default tiers — for a PROVEN membership only. */
export async function groupDefaults(
  storage: StoragePort,
  membership: GroupMembership,
): Promise<GroupDefault[]> {
  const rows = await storage.query({
    sql: "SELECT person_id, default_edit_tier, default_visibility FROM group_member WHERE group_id = ?",
    params: [membership.group.id],
  });
  return rows.map((row) => {
    const r = defaultRowSchema.parse(row);
    return {
      personId: r.person_id,
      editTier: r.default_edit_tier,
      visibility: r.default_visibility,
    };
  });
}

export const participationRowSchema = z.object({
  canonical_event_id: z.string(),
  person_id: z.string(),
  edit_tier: editTierSchema,
  visibility: visibilitySchema,
  attendance: z.enum(["going", "maybe", "not_going"]).nullable(),
  response_kind: responseKindSchema,
  response_state: responseStateSchema.nullable(),
});

export function toParticipation(row: unknown): Participation {
  const r = participationRowSchema.parse(row);
  return {
    eventId: r.canonical_event_id,
    personId: r.person_id,
    editTier: r.edit_tier,
    visibility: r.visibility,
    attendance: r.attendance,
    responseKind: r.response_kind,
    responseState: r.response_state,
  };
}

const participantRowSchema = participationRowSchema.extend({
  email: z.string(),
  display_name: z.string().nullable(),
});

/** Everyone taking part, for someone who has already passed findEventForParticipant. */
export async function listParticipants(
  storage: StoragePort,
  eventId: string,
): Promise<ParticipantView[]> {
  const rows = await storage.query({
    sql: `SELECT ${PARTICIPATION_COLUMNS},
                 p.email, p.display_name
          FROM event_participation ep JOIN person p ON p.id = ep.person_id
          WHERE ep.canonical_event_id = ?
          ORDER BY ep.edit_tier = 'edit' DESC, p.email`,
    params: [eventId],
  });
  return rows.map((row) => {
    const r = participantRowSchema.parse(row);
    return { ...toParticipation(row), email: r.email, displayName: r.display_name };
  });
}

// --- What each visibility tier may see (WORKFLOWS §3, DESIGN §9 visibility integrity)
//
// THE single source of truth for "who sees what", used by every view: the event page,
// the group's event list AND the change history. History matters most — an entry
// "description: old → new" shown to a DETAILS viewer would leak exactly the private
// notes the tier exists to protect (WORKFLOWS US-6).

export type EventPart = "title" | "time" | "location" | "description" | "participants";

const VISIBLE: Record<Visibility, ReadonlySet<EventPart>> = {
  FULL: new Set<EventPart>(["title", "time", "location", "description", "participants"]),
  DETAILS: new Set<EventPart>(["title", "time", "location"]),
  BUSY: new Set<EventPart>(["time"]),
  HIDDEN: new Set<EventPart>(),
};

export function canSee(visibility: Visibility, part: EventPart): boolean {
  return VISIBLE[visibility].has(part);
}

/** Which part a change_log field belongs to; `status` is visible to every tier that sees anything. */
export function partOfField(field: string): EventPart | "status" | null {
  switch (field) {
    case "title":
      return "title";
    case "description":
      return "description";
    case "location":
      return "location";
    case "startLocal":
    case "endLocal":
    case "tzid":
    case "allDay":
    case "rrule": // which dates a series falls on is its time
      return "time";
    case "status":
      return "status";
    default:
      // An unknown field is hidden from everyone below FULL: failing closed means a
      // field added later can never leak by default.
      return null;
  }
}

export function canSeeField(visibility: Visibility, field: string): boolean {
  if (visibility === "FULL") return true;
  if (visibility === "HIDDEN") return false;
  const part = partOfField(field);
  if (part === null) return false;
  return part === "status" || canSee(visibility, part);
}

// --- Adding and removing people on an existing event (DESIGN rc15, slice 2F) ---------
//
// Only `edit` participants may: who an event is for is not a field proposal. Each
// change is an attributed event_participant_change row, written in the SAME batch as
// the participation it records, and never a revision: adding someone must not turn a
// concurrent field edit into a conflict.

/** Adds per event per rolling day — bounds a runaway form and the mail budget, like group invites. */
export const ADDS_PER_EVENT_PER_DAY = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Events that are over take no new people: there is nothing for them to answer. */
export const TAKES_PEOPLE: ReadonlySet<string> = new Set(["draft", "proposed", "scheduled"]);

export type AddResult =
  | { readonly kind: "added"; readonly personId: string; readonly email: string }
  | { readonly kind: "forbidden" | "closed" | "already" | "rate_limited" };

/**
 * Add a person by email to an event, at the given tiers. An address with no person yet
 * gets one (§2: a person exists with zero connections) — the event's people list is
 * its truth, whether or not they ever sign in. A poll's new person may vote, like
 * everyone else on it; on any other event they are asked nothing.
 */
export async function addParticipant(
  storage: StoragePort,
  access: EventAccess,
  input: {
    readonly email: string;
    readonly editTier: EditTier;
    readonly visibility: Visibility;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<AddResult> {
  if (access.participation.editTier !== "edit") return { kind: "forbidden" };
  if (!TAKES_PEOPLE.has(access.event.status)) return { kind: "closed" };
  const newId = input.newId ?? (() => uuidv7());
  const person = await findOrCreatePerson(storage, input.email, { now: input.now, newId });
  const eventId = access.event.id;
  const changeId = newId();
  const kind = access.participation.responseKind === "slot_vote" ? "slot_vote" : "none";
  // The change row is the reservation: inserted only if this person isn't taking part
  // and the day's adds are under the bound, in ONE statement, so concurrent adds can't
  // each see room. The participation follows only if the change row was written.
  await storage.batch([
    {
      sql: `INSERT INTO event_participant_change (id, canonical_event_id, person_id, action, actor_id, created_at)
            SELECT ?, ?, ?, 'added', ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM event_participation WHERE canonical_event_id = ? AND person_id = ?)
              AND (SELECT count(*) FROM event_participant_change
                   WHERE canonical_event_id = ? AND action = 'added' AND created_at > ?) < ?`,
      params: [
        changeId,
        eventId,
        person.id,
        access.participation.personId,
        input.now,
        eventId,
        person.id,
        eventId,
        new Date(Date.parse(input.now) - DAY_MS).toISOString(),
        ADDS_PER_EVENT_PER_DAY,
      ],
    },
    {
      sql: `INSERT INTO event_participation (canonical_event_id, person_id, edit_tier, visibility, response_kind, created_at)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM event_participant_change WHERE id = ?)`,
      params: [eventId, person.id, input.editTier, input.visibility, kind, input.now, changeId],
    },
  ]);
  const written = await storage.query({
    sql: "SELECT 1 AS present FROM event_participant_change WHERE id = ?",
    params: [changeId],
  });
  if (written.length === 1) return { kind: "added", personId: person.id, email: person.email };
  const present = await storage.query({
    sql: "SELECT 1 AS present FROM event_participation WHERE canonical_event_id = ? AND person_id = ?",
    params: [eventId, person.id],
  });
  return { kind: present.length > 0 ? "already" : "rate_limited" };
}

export type RemoveResult = {
  readonly kind:
    | "removed"
    | "forbidden"
    | "creator"
    | "last_editor"
    | "awaited"
    | "not_taking_part";
};

/**
 * Remove a person from an event: their participation, their response links and their
 * poll votes go — they are no longer asked, and no longer counted. Their feedback stays,
 * attributed: it was said. The creator cannot be removed, and an event always keeps at
 * least one `edit` participant. Nor can someone whose agreement the event is still
 * waiting for: the proposal would wait on nobody. Withdraw it instead.
 */
export async function removeParticipant(
  storage: StoragePort,
  access: EventAccess,
  input: { readonly personId: string; readonly now: string; readonly newId?: () => string },
): Promise<RemoveResult> {
  if (access.participation.editTier !== "edit") return { kind: "forbidden" };
  const eventId = access.event.id;
  if (input.personId === access.event.ownerId) return { kind: "creator" };
  const changeId = (input.newId ?? (() => uuidv7()))();
  const taking = "SELECT 1 FROM event_participation WHERE canonical_event_id = ? AND person_id = ?";
  const anotherEditor = `SELECT 1 FROM event_participation
    WHERE canonical_event_id = ? AND person_id <> ? AND edit_tier = 'edit'`;
  const awaited = `SELECT 1 FROM event_participation ep JOIN canonical_event e ON e.id = ep.canonical_event_id
    WHERE ep.canonical_event_id = ? AND ep.person_id = ? AND ep.response_kind = 'accept' AND e.status = 'proposed'`;
  const recorded = "EXISTS (SELECT 1 FROM event_participant_change WHERE id = ?)";
  // As with adding, the change row decides: it is written only while the person takes
  // part and someone else can still edit, and everything else follows it.
  await storage.batch([
    {
      sql: `INSERT INTO event_participant_change (id, canonical_event_id, person_id, action, actor_id, created_at)
            SELECT ?, ?, ?, 'removed', ?, ?
            WHERE EXISTS (${taking}) AND EXISTS (${anotherEditor}) AND NOT EXISTS (${awaited})`,
      params: [
        changeId,
        eventId,
        input.personId,
        access.participation.personId,
        input.now,
        eventId,
        input.personId,
        eventId,
        input.personId,
        eventId,
        input.personId,
      ],
    },
    {
      sql: `DELETE FROM response_token WHERE canonical_event_id = ? AND person_id = ? AND ${recorded}`,
      params: [eventId, input.personId, changeId],
    },
    {
      sql: `DELETE FROM slot_response WHERE canonical_event_id = ? AND person_id = ? AND ${recorded}`,
      params: [eventId, input.personId, changeId],
    },
    {
      sql: `DELETE FROM event_participation WHERE canonical_event_id = ? AND person_id = ? AND ${recorded}`,
      params: [eventId, input.personId, changeId],
    },
  ]);
  const written = await storage.query({
    sql: "SELECT 1 AS present FROM event_participant_change WHERE id = ?",
    params: [changeId],
  });
  if (written.length === 1) return { kind: "removed" };
  if ((await storage.query({ sql: taking, params: [eventId, input.personId] })).length === 0)
    return { kind: "not_taking_part" };
  const waiting = await storage.query({ sql: awaited, params: [eventId, input.personId] });
  return { kind: waiting.length > 0 ? "awaited" : "last_editor" };
}

export interface ParticipantChange {
  readonly action: "added" | "removed";
  readonly personEmail: string;
  readonly actorEmail: string;
  readonly at: string;
}

const participantChangeRowSchema = z.object({
  action: z.enum(["added", "removed"]),
  person_email: z.string(),
  actor_email: z.string(),
  created_at: z.string(),
});

/**
 * Who was added and removed, by whom, newest first — for someone with proven access who
 * may see the event's people (`canSee(…, "participants")`): the trail names them.
 */
export async function listParticipantChanges(
  storage: StoragePort,
  access: EventAccess,
): Promise<ParticipantChange[]> {
  const rows = await storage.query({
    sql: `SELECT c.action, p.email AS person_email, a.email AS actor_email, c.created_at
          FROM event_participant_change c JOIN person p ON p.id = c.person_id
            JOIN person a ON a.id = c.actor_id
          WHERE c.canonical_event_id = ?
          ORDER BY c.created_at DESC, c.id DESC`,
    params: [access.event.id],
  });
  return rows.map((row) => {
    const r = participantChangeRowSchema.parse(row);
    return {
      action: r.action,
      personEmail: r.person_email,
      actorEmail: r.actor_email,
      at: r.created_at,
    };
  });
}
