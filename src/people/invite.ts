// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import type { GroupMembership } from "./group.js";
import { findOrCreatePerson, normalizeEmail } from "./person.js";
import { hashToken, issueToken } from "./tokens.js";

// Group invites (MVP-1 slice D2).
//
// An invite is ALSO a sign-in. The link went to that exact address, so following it
// proves ownership just as a magic link does — one click to join, rather than an
// invite email followed by a separate sign-in email. The trade-off, stated plainly:
// an unused invite is a sign-in link for that address for INVITE_TTL_MS (7 days, vs
// 15 minutes for a magic link). Mitigations: single use, hash-only storage, built from
// PUBLIC_BASE_URL, and the accept page names the group, the inviter and the account.

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-group invites per rolling day — bounds a runaway form and the mail budget. */
export const INVITES_PER_GROUP_PER_DAY = 50;

export const editTierSchema = z.enum(["edit", "propose", "view"]);
export const visibilitySchema = z.enum(["FULL", "DETAILS", "BUSY", "HIDDEN"]);
export type EditTier = z.infer<typeof editTierSchema>;
export type Visibility = z.infer<typeof visibilitySchema>;

export type CreateInviteResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly email: string;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly reason: "not_organizer" | "already_member" | "rate_limited" };

function shift(iso: string, ms: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error("invalid `now`");
  return new Date(t + ms).toISOString();
}

/**
 * Invite an address into a group. Only an organizer may, and the caller must hold the
 * PROVEN membership (from findGroupForMember) — there is no way to call this with a
 * bare group id.
 */
export async function createInvite(
  storage: StoragePort,
  membership: GroupMembership,
  input: {
    readonly email: string;
    readonly invitedBy: string;
    readonly editTier: EditTier;
    readonly visibility: Visibility;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<CreateInviteResult> {
  if (membership.role !== "organizer") return { ok: false, reason: "not_organizer" };
  const email = normalizeEmail(input.email);
  const groupId = membership.group.id;

  const existing = await storage.query({
    sql: `SELECT 1 AS present FROM group_member m JOIN person p ON p.id = m.person_id
          WHERE m.group_id = ? AND p.email = ?`,
    params: [groupId, email],
  });
  // Check-then-insert, deliberately not atomic: the only race is two organizers
  // inviting someone who joins in between, which yields one redundant invite —
  // harmless, because acceptInvite keeps an existing membership as it is.
  if (existing.length > 0) return { ok: false, reason: "already_member" };

  const { token, hash } = await issueToken();
  const expiresAt = shift(input.now, INVITE_TTL_MS);
  // Rate limit and insert as ONE statement, the same reservation shape as the mail cap
  // and login requests: concurrent submissions cannot each see room.
  const rows = await storage.query({
    sql: `INSERT INTO group_invite
            (id, group_id, email, token_hash, invited_by, edit_tier, visibility, expires_at, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT count(*) FROM group_invite WHERE group_id = ? AND created_at > ?) < ?
          RETURNING id`,
    params: [
      (input.newId ?? (() => uuidv7()))(),
      groupId,
      email,
      hash,
      input.invitedBy,
      input.editTier,
      input.visibility,
      expiresAt,
      input.now,
      groupId,
      shift(input.now, -24 * 60 * 60 * 1000),
      INVITES_PER_GROUP_PER_DAY,
    ],
  });
  return rows.length === 0
    ? { ok: false, reason: "rate_limited" }
    : { ok: true, token, email, expiresAt };
}

const peekSchema = z.object({
  group_name: z.string(),
  inviter_email: z.string(),
  email: z.string(),
});

export interface InvitePreview {
  readonly groupName: string;
  readonly inviterEmail: string;
  /** The account accepting will sign the browser into. */
  readonly email: string;
}

/** What a still-valid invite would do, WITHOUT using it (the GET page; mail scanners). */
export async function peekInvite(
  storage: StoragePort,
  token: string,
  now: string,
): Promise<InvitePreview | null> {
  const rows = await storage.query({
    sql: `SELECT g.name AS group_name, p.email AS inviter_email, i.email
          FROM group_invite i
          JOIN person_group g ON g.id = i.group_id
          JOIN person p ON p.id = i.invited_by
          WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?`,
    params: [await hashToken(token), now],
  });
  if (rows[0] === undefined) return null;
  const r = peekSchema.parse(rows[0]);
  return { groupName: r.group_name, inviterEmail: r.inviter_email, email: r.email };
}

const acceptedSchema = z.object({
  group_id: z.string(),
  email: z.string(),
  edit_tier: editTierSchema,
  visibility: visibilitySchema,
});

export interface AcceptedInvite {
  readonly groupId: string;
  readonly personId: string;
}

/**
 * Use an invite: exactly once (UPDATE … WHERE unused AND unexpired RETURNING), then
 * create the person if new and add them as a member. Re-joining is harmless:
 * ON CONFLICT DO NOTHING keeps an existing membership, and its role, as it was.
 */
export async function acceptInvite(
  storage: StoragePort,
  token: string,
  now: string,
): Promise<AcceptedInvite | null> {
  const rows = await storage.query({
    sql: `UPDATE group_invite SET accepted_at = ?
          WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?
          RETURNING group_id, email, edit_tier, visibility`,
    params: [now, await hashToken(token), now],
  });
  if (rows[0] === undefined) return null;
  const invite = acceptedSchema.parse(rows[0]);
  const person = await findOrCreatePerson(storage, invite.email, { now });
  await storage.batch([
    {
      sql: `INSERT INTO group_member
              (group_id, person_id, role, default_edit_tier, default_visibility, joined_at)
            VALUES (?, ?, 'member', ?, ?, ?)
            ON CONFLICT(group_id, person_id) DO NOTHING`,
      params: [invite.group_id, person.id, invite.edit_tier, invite.visibility, now],
    },
  ]);
  return { groupId: invite.group_id, personId: person.id };
}
