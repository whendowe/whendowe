// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";

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
  readonly email: string;
  readonly displayName: string | null;
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

const memberRowSchema = z.object({
  person_id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
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
    sql: `SELECT p.id AS person_id, p.email, p.display_name, m.role
          FROM group_member m JOIN person p ON p.id = m.person_id
          WHERE m.group_id = ?
          ORDER BY m.role = 'organizer' DESC, p.email`,
    params: [membership.group.id],
  });
  return rows.map((row) => {
    const r = memberRowSchema.parse(row);
    return { personId: r.person_id, email: r.email, displayName: r.display_name, role: r.role };
  });
}
