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

export interface Participation {
  readonly eventId: string;
  readonly personId: string;
  readonly editTier: EditTier;
  readonly visibility: Visibility;
  readonly attendance: "going" | "maybe" | "not_going" | null;
}

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
});

export function toParticipation(row: unknown): Participation {
  const r = participationRowSchema.parse(row);
  return {
    eventId: r.canonical_event_id,
    personId: r.person_id,
    editTier: r.edit_tier,
    visibility: r.visibility,
    attendance: r.attendance,
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
    sql: `SELECT ep.canonical_event_id, ep.person_id, ep.edit_tier, ep.visibility, ep.attendance,
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
