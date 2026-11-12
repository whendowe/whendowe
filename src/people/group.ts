// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { SqlStatement, StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { collect } from "../privacy/purge.js";
import { type Shown, shownAs, shownRowSchema } from "./person.js";

/**
 * What a person may change, and what they see (DESIGN §10 rc7). Here, with a group member's
 * defaults, and not with invites: participation.ts needs them too, and importing invites
 * from there closed an import cycle (invite → suppression → erasure → event →
 * participation → invite) that left these undefined when invites loaded first.
 */
export const editTierSchema = z.enum(["edit", "propose", "view"]);
export const visibilitySchema = z.enum(["FULL", "DETAILS", "BUSY", "HIDDEN"]);
export type EditTier = z.infer<typeof editTierSchema>;
export type Visibility = z.infer<typeof visibilitySchema>;

// Groups (MVP-1 slice D): a reusable set of people — a household, a D&D table.
//
// AUTHORIZATION LIVES HERE, not in the routes: the only way to read a group is
// findGroupForMember(groupId, personId), which answers null both for "no such group"
// and "not your group". A route cannot forget the membership check, because there is
// no unchecked read to call (§13: an IDOR is an authorization bug, not a styling one).

export type GroupRole = "organizer" | "member";

export interface Group {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface GroupMembership {
  readonly group: Group;
  readonly role: GroupRole;
}

export interface GroupSummary extends Group {
  readonly role: GroupRole;
  readonly memberCount: number;
}

export interface GroupMemberView {
  readonly personId: string;
  /** As the other members see them (DESIGN §10 rc21): a handle, an address only if shown. */
  readonly shown: Shown;
  readonly role: GroupRole;
}

const MAX_NAME = 80;

/** Trimmed, 1–80 characters. Throws with a user-presentable reason. */
export function normalizeGroupName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new Error("Give the group a name.");
  if (name.length > MAX_NAME) throw new Error(`Keep the name under ${MAX_NAME} characters.`);
  return name;
}

const roleSchema = z.enum(["organizer", "member"]);

/** Create a group; its creator becomes its organizer — atomically, in one batch. */
export async function createGroup(
  storage: StoragePort,
  input: {
    readonly name: string;
    readonly creatorId: string;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<Group> {
  const name = normalizeGroupName(input.name);
  const id = (input.newId ?? (() => uuidv7()))();
  // One batch: a group with no organizer would be unreachable by anyone, forever.
  await storage.batch([
    {
      sql: "INSERT INTO person_group (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
      params: [id, name, input.creatorId, input.now],
    },
    {
      sql: `INSERT INTO group_member (group_id, person_id, role, joined_at)
            VALUES (?, ?, 'organizer', ?)`,
      params: [id, input.creatorId, input.now],
    },
  ]);
  return { id, name, createdAt: input.now };
}

const membershipRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  role: roleSchema,
});

/** The group IF the person belongs to it; null for "missing" and "not yours" alike. */
export async function findGroupForMember(
  storage: StoragePort,
  groupId: string,
  personId: string,
): Promise<GroupMembership | null> {
  const rows = await storage.query({
    sql: `SELECT g.id, g.name, g.created_at, m.role
          FROM person_group g JOIN group_member m ON m.group_id = g.id
          WHERE g.id = ? AND m.person_id = ?`,
    params: [groupId, personId],
  });
  if (rows[0] === undefined) return null;
  const r = membershipRowSchema.parse(rows[0]);
  return { group: { id: r.id, name: r.name, createdAt: r.created_at }, role: r.role };
}

const summaryRowSchema = membershipRowSchema.extend({ member_count: z.number() });

export async function listGroupsFor(
  storage: StoragePort,
  personId: string,
): Promise<GroupSummary[]> {
  const rows = await storage.query({
    sql: `SELECT g.id, g.name, g.created_at, m.role,
                 (SELECT count(*) FROM group_member c WHERE c.group_id = g.id) AS member_count
          FROM person_group g JOIN group_member m ON m.group_id = g.id
          WHERE m.person_id = ?
          ORDER BY g.name COLLATE NOCASE, g.id`,
    params: [personId],
  });
  return rows.map((row) => {
    const r = summaryRowSchema.parse(row);
    return {
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      role: r.role,
      memberCount: r.member_count,
    };
  });
}

const memberRowSchema = shownRowSchema.extend({
  person_id: z.string(),
  role: roleSchema,
});

/**
 * Members of a group, for someone who has ALREADY passed findGroupForMember — the
 * membership argument is that proof, so this cannot be called with a bare id.
 */
export async function listMembers(
  storage: StoragePort,
  membership: GroupMembership,
): Promise<GroupMemberView[]> {
  const rows = await storage.query({
    sql: `SELECT p.id AS person_id, p.email, p.display_name, m.handle, m.show_email, m.role
          FROM group_member m JOIN person p ON p.id = m.person_id
          WHERE m.group_id = ?
          ORDER BY m.role = 'organizer' DESC, m.joined_at, p.id`,
    params: [membership.group.id],
  });
  return rows.map((row) => {
    const r = memberRowSchema.parse(row);
    return {
      personId: r.person_id,
      shown: shownAs(r.person_id, r, membership.group.id),
      role: r.role,
    };
  });
}

/**
 * Leave a group (DESIGN §10 rc21). Events stay as they are: a group is an address book
 * (rc15). An organizer leaving hands the role to the longest-standing member; the last
 * member leaving deletes the group.
 */
export async function leaveGroup(
  storage: StoragePort,
  membership: GroupMembership,
  personId: string,
  now: string,
): Promise<{ readonly deleted: boolean }> {
  const groupId = membership.group.id;
  await storage.batch([
    {
      sql: `UPDATE group_member SET role = 'organizer'
            WHERE group_id = ? AND person_id =
                (SELECT person_id FROM group_member WHERE group_id = ? AND person_id <> ?
                 ORDER BY joined_at, person_id LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM group_member
                              WHERE group_id = ? AND role = 'organizer' AND person_id <> ?)`,
      params: [groupId, groupId, personId, groupId, personId],
    },
    // The group calendar links they keep move to the organizer who takes over (rc36).
    moveSharedLinks(groupId, personId),
    {
      sql: "DELETE FROM group_member WHERE group_id = ? AND person_id = ?",
      params: [groupId, personId],
    },
    // Their link to the group's feed goes with them (rc34).
    {
      sql: "DELETE FROM feed_token WHERE kind = 'feed' AND group_id = ? AND person_id = ?",
      params: [groupId, personId],
    },
  ]);
  const gone = await collect(storage, { groups: [groupId] }, now);
  return { deleted: gone.groups.length > 0 };
}

/**
 * When `personId` stops being an organizer of a group (they leave, or are erased), the
 * group calendar links they keep there move to the organizer who remains or has just
 * taken over (DESIGN §10 rc36), and are capped by that person's view from then on. Run it
 * after the role is handed on; if nobody remains, the group goes and its links with it.
 */
export function moveSharedLinks(groupId: string, personId: string): SqlStatement {
  return {
    sql: `UPDATE feed_token SET person_id =
            (SELECT person_id FROM group_member
             WHERE group_id = ? AND role = 'organizer' AND person_id <> ?
             ORDER BY joined_at, person_id LIMIT 1)
          WHERE kind = 'shared' AND group_id = ? AND person_id = ?
            AND EXISTS (SELECT 1 FROM group_member
                        WHERE group_id = ? AND role = 'organizer' AND person_id <> ?)`,
    params: [groupId, personId, groupId, personId, groupId, personId],
  };
}

/** How long events made from this group are kept after they end (DESIGN §10 rc23). */
export async function groupRetention(storage: StoragePort, groupId: string): Promise<number> {
  const rows = await storage.query({
    sql: "SELECT retain_days FROM person_group WHERE id = ?",
    params: [groupId],
  });
  return z.object({ retain_days: z.number() }).parse(rows[0]).retain_days;
}

/**
 * Its organizers set the group's period; it applies to events made from it afterwards
 * (rc23) — the earlier ones keep theirs, since an organizer may not be able to edit them.
 * False, and nothing written, for anyone else.
 */
export async function setGroupRetention(
  storage: StoragePort,
  membership: GroupMembership,
  days: number,
): Promise<boolean> {
  if (membership.role !== "organizer") return false;
  await storage.batch([
    {
      sql: "UPDATE person_group SET retain_days = ? WHERE id = ?",
      params: [days, membership.group.id],
    },
  ]);
  return true;
}

/**
 * Whether events made from the group start verified (DESIGN §10 rc42). Its organizers
 * set it; it changes nothing already made.
 */
export async function setGroupDefaultVerified(
  storage: StoragePort,
  membership: GroupMembership,
  on: boolean,
): Promise<boolean> {
  if (membership.role !== "organizer") return false;
  await storage.batch([
    {
      sql: "UPDATE person_group SET default_verified = ? WHERE id = ?",
      params: [on ? 1 : 0, membership.group.id],
    },
  ]);
  return true;
}

/**
 * A member's default for "only my own email answers for me" (DESIGN §10 rc42), copied onto
 * the events made from the group afterwards. Their own, so no one else's: the caller is
 * the member, by their membership.
 */
export async function setDefaultOwnAnswersOnly(
  storage: StoragePort,
  membership: GroupMembership,
  personId: string,
  on: boolean,
): Promise<void> {
  await storage.batch([
    {
      sql: "UPDATE group_member SET default_own_answers_only = ? WHERE group_id = ? AND person_id = ?",
      params: [on ? 1 : 0, membership.group.id, personId],
    },
  ]);
}

/** Whether this member's default is on, for the group page's form. */
export async function defaultOwnAnswersOnly(
  storage: StoragePort,
  groupId: string,
  personId: string,
): Promise<boolean> {
  const rows = await storage.query({
    sql: "SELECT default_own_answers_only AS on_ FROM group_member WHERE group_id = ? AND person_id = ?",
    params: [groupId, personId],
  });
  return rows[0]?.on_ === 1;
}
