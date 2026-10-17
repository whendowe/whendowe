// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import type { GroupMembership } from "../people/group.js";
import {
  type EditTier,
  editTierSchema,
  type Visibility,
  visibilitySchema,
} from "../people/invite.js";

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
