// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { SqlStatement, StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { type Shown, shownAs, shownRowSchema } from "../people/person.js";
import { collect } from "../privacy/purge.js";

// Plan threads (DESIGN §10 rc19, slice P1): what people are planning — "Kiddo's weeks",
// "Christmas 2026" — its members, and the organizer who decides when more than two plan.
//
// AUTHORIZATION LIVES HERE, as with groups and events: the only read of a thread is
// findThreadForMember, which answers null for "no such thread" and "not yours" alike,
// and every plan operation takes the access it returned.

export interface Thread {
  readonly id: string;
  readonly name: string;
  readonly organizerId: string;
  /** The zone of every timed event in the thread. */
  readonly tzid: string;
  readonly createdAt: string;
  /** The group it was started from, if any (rc27). */
  readonly groupId: string | null;
  /** When a shared link was first made (rc29); set, the organizer decides. */
  readonly sharedAt: string | null;
}

export interface ThreadMember {
  readonly personId: string;
  /** As the other members see them (DESIGN §10 rc21): a handle, an address only if shown. */
  readonly shown: Shown;
  /** A name claimed from a shared link, not yet an account's (rc29): "not confirmed" (rc30). */
  readonly guest: boolean;
}

/** Proof that a person is a member of a thread, with everyone who plans in it. */
export interface ThreadAccess {
  readonly thread: Thread;
  readonly personId: string;
  /** In the order they joined, so every page lists people (and colours them) the same way. */
  readonly members: readonly ThreadMember[];
}

/**
 * Two members decide by consensus; more, by the organizer after voting (owner decision,
 * 2026-10-25). Derived from the member count at the moment of deciding, never stored. A
 * thread that has had a shared link is the organizer's to decide however few are in it
 * (rc29): its members aren't all there yet, so the first guest's yes can't settle it. One
 * member alone (a poll made to be shared, or everyone else left) is not a consensus of
 * two: their own yes must not accept a time, so the organizer — they — decide.
 */
export function decidesByConsensus(access: ThreadAccess): boolean {
  return access.members.length === 2 && access.thread.sharedAt === null;
}

/** Who may decide: both in a pair, the organizer in a larger group. */
export function deciders(access: ThreadAccess): readonly string[] {
  return decidesByConsensus(access)
    ? access.members.map((m) => m.personId)
    : [access.thread.organizerId];
}

/** A member's name: their handle here, never any part of their address (§10 rc21). */
export function memberName(m: Pick<ThreadMember, "shown">): string {
  return m.shown.name;
}

export const MAX_THREAD_NAME = 80;
export const MAX_MEMBERS = 20;

/** A person-facing problem with what was asked (shown on the form, not a crash). */
export class ThreadInputError extends Error {}

export function normalizeThreadName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new ThreadInputError("Say what you are planning.");
  if (name.length > MAX_THREAD_NAME)
    throw new ThreadInputError(`Keep the name under ${MAX_THREAD_NAME} characters.`);
  return name;
}

function isTimeZone(tzid: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a thread. The creator is its organizer and a member; everyone in `memberIds`
 * joins too. One batch: a thread its organizer can't reach must never exist.
 */
export async function createThread(
  storage: StoragePort,
  input: {
    readonly name: string;
    readonly tzid: string;
    readonly creatorId: string;
    readonly memberIds: readonly string[];
    /** The group it is started from, if any (rc27): the caller has proven membership. */
    readonly groupId?: string | null;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<Thread> {
  const { thread, statements } = threadStatements(input);
  await storage.batch(statements);
  return thread;
}

/**
 * createThread's validation and rows, for a caller that writes more in the same batch
 * (a poll's times, rc26): a thread without what it was made for must never exist.
 */
export function threadStatements(input: {
  readonly name: string;
  readonly tzid: string;
  readonly creatorId: string;
  readonly memberIds: readonly string[];
  readonly groupId?: string | null;
  /** A poll may start with nobody else in it, to be shared in a group chat (rc29). */
  readonly alone?: boolean;
  readonly now: string;
  readonly newId?: () => string;
}): { readonly thread: Thread; readonly statements: SqlStatement[] } {
  const name = normalizeThreadName(input.name);
  if (!isTimeZone(input.tzid)) throw new ThreadInputError("Choose a valid time zone.");
  const others = [...new Set(input.memberIds)].filter((id) => id !== input.creatorId);
  if (others.length === 0 && input.alone !== true)
    throw new ThreadInputError("Add at least one person to plan with.");
  if (others.length + 1 > MAX_MEMBERS)
    throw new ThreadInputError(`At most ${MAX_MEMBERS} people plan together.`);
  const id = (input.newId ?? (() => uuidv7()))();
  const statements: SqlStatement[] = [
    {
      sql: "INSERT INTO plan_thread (id, name, organizer_id, tzid, created_at, group_id) VALUES (?, ?, ?, ?, ?, ?)",
      params: [id, name, input.creatorId, input.tzid, input.now, input.groupId ?? null],
    },
    ...[input.creatorId, ...others].map((personId) => ({
      sql: "INSERT INTO plan_thread_member (thread_id, person_id, created_at) VALUES (?, ?, ?)",
      params: [id, personId, input.now],
    })),
  ];
  const thread = {
    id,
    name,
    organizerId: input.creatorId,
    tzid: input.tzid,
    createdAt: input.now,
    groupId: input.groupId ?? null,
    sharedAt: null,
  };
  return { thread, statements };
}

const threadRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  organizer_id: z.string(),
  tzid: z.string(),
  created_at: z.string(),
  group_id: z.string().nullable(),
  shared_at: z.string().nullable(),
});

const memberRowSchema = shownRowSchema.extend({
  person_id: z.string(),
  guest_at: z.string().nullable(),
});

function toThread(row: unknown): Thread {
  const r = threadRowSchema.parse(row);
  return {
    id: r.id,
    name: r.name,
    organizerId: r.organizer_id,
    tzid: r.tzid,
    createdAt: r.created_at,
    groupId: r.group_id,
    sharedAt: r.shared_at,
  };
}

/** The thread IF the person is a member; null for "missing" and "not yours" alike. */
export async function findThreadForMember(
  storage: StoragePort,
  threadId: string,
  personId: string,
): Promise<ThreadAccess | null> {
  const rows = await storage.query({
    sql: `SELECT t.id, t.name, t.organizer_id, t.tzid, t.created_at, t.group_id, t.shared_at
          FROM plan_thread t JOIN plan_thread_member m ON m.thread_id = t.id
          WHERE t.id = ? AND m.person_id = ?`,
    params: [threadId, personId],
  });
  if (rows[0] === undefined) return null;
  return { thread: toThread(rows[0]), personId, members: await threadMembers(storage, threadId) };
}

/** A thread's members as they are shown, in the order they joined. Callers prove access. */
export async function threadMembers(
  storage: StoragePort,
  threadId: string,
): Promise<ThreadMember[]> {
  return (
    await storage.query({
      sql: `SELECT m.person_id, p.email, p.display_name, m.handle, m.show_email, p.guest_at
            FROM plan_thread_member m JOIN person p ON p.id = m.person_id
            WHERE m.thread_id = ? ORDER BY m.created_at, m.person_id`,
      params: [threadId],
    })
  ).map((row) => {
    const r = memberRowSchema.parse(row);
    return {
      personId: r.person_id,
      shown: shownAs(r.person_id, r, threadId),
      guest: r.guest_at !== null,
    };
  });
}

/** The thread by id, for a caller that has proven a right to it some other way (a shared link). */
export async function findThreadById(
  storage: StoragePort,
  threadId: string,
): Promise<Thread | null> {
  const rows = await storage.query({
    sql: "SELECT id, name, organizer_id, tzid, created_at, group_id, shared_at FROM plan_thread WHERE id = ?",
    params: [threadId],
  });
  return rows[0] === undefined ? null : toThread(rows[0]);
}

export interface ThreadSummary extends Thread {
  readonly memberCount: number;
  /** Plans on the table this person hasn't voted on. */
  readonly waiting: number;
  readonly onTable: number;
}

const summaryRowSchema = threadRowSchema.extend({
  member_count: z.number(),
  waiting: z.number(),
  on_table: z.number(),
});

/** Every thread this person plans in, the ones waiting for them first, then newest. */
export async function listThreadsFor(
  storage: StoragePort,
  personId: string,
): Promise<ThreadSummary[]> {
  const rows = await storage.query({
    sql: `SELECT t.id, t.name, t.organizer_id, t.tzid, t.created_at, t.group_id, t.shared_at,
            (SELECT count(*) FROM plan_thread_member c WHERE c.thread_id = t.id) AS member_count,
            (SELECT count(*) FROM plan p WHERE p.thread_id = t.id AND p.status = 'on_table'
               AND NOT EXISTS (SELECT 1 FROM plan_vote v WHERE v.plan_id = p.id AND v.person_id = ?)) AS waiting,
            (SELECT count(*) FROM plan p WHERE p.thread_id = t.id AND p.status = 'on_table') AS on_table
          FROM plan_thread t JOIN plan_thread_member m ON m.thread_id = t.id
          WHERE m.person_id = ?
          ORDER BY waiting > 0 DESC, t.created_at DESC, t.id`,
    params: [personId, personId],
  });
  return rows.map((row) => {
    const r = summaryRowSchema.parse(row);
    return {
      ...toThread(row),
      memberCount: r.member_count,
      waiting: r.waiting,
      onTable: r.on_table,
    };
  });
}

/**
 * Leave a plan thread (DESIGN §10 rc21): your drafts, votes and notes go, and plans of
 * yours still on the table are withdrawn. Accepted plans are ordinary events by now and
 * stay. The organizer role passes to the longest-standing member; the last member
 * leaving deletes the thread.
 */
export async function leaveThread(
  storage: StoragePort,
  access: ThreadAccess,
  now: string,
): Promise<{ readonly deleted: boolean }> {
  const t = access.thread.id;
  const me = access.personId;
  await storage.batch([
    {
      sql: `UPDATE plan SET status = 'withdrawn', decided_at = ?, updated_at = ?
            WHERE thread_id = ? AND author_id = ? AND status = 'on_table'`,
      params: [now, now, t, me],
    },
    {
      sql: `DELETE FROM plan_event WHERE plan_id IN
              (SELECT id FROM plan WHERE thread_id = ? AND author_id = ? AND status = 'draft')`,
      params: [t, me],
    },
    {
      sql: "DELETE FROM plan WHERE thread_id = ? AND author_id = ? AND status = 'draft'",
      params: [t, me],
    },
    {
      sql: "DELETE FROM plan_vote WHERE person_id = ? AND plan_id IN (SELECT id FROM plan WHERE thread_id = ?)",
      params: [me, t],
    },
    { sql: "DELETE FROM plan_note WHERE thread_id = ? AND author_id = ?", params: [t, me] },
    // A vote link outlives nothing it can no longer open (rc26).
    { sql: "DELETE FROM plan_vote_token WHERE thread_id = ? AND person_id = ?", params: [t, me] },
    // So do a guest's claim and the shared link this person made (rc25).
    { sql: "DELETE FROM guest_claim WHERE thread_id = ? AND person_id = ?", params: [t, me] },
    { sql: "DELETE FROM share_link WHERE thread_id = ? AND created_by = ?", params: [t, me] },
    {
      sql: `UPDATE plan_thread SET organizer_id =
              (SELECT person_id FROM plan_thread_member WHERE thread_id = ? AND person_id <> ?
               ORDER BY created_at, person_id LIMIT 1)
            WHERE id = ? AND organizer_id = ?
              AND EXISTS (SELECT 1 FROM plan_thread_member WHERE thread_id = ? AND person_id <> ?)`,
      params: [t, me, t, me, t, me],
    },
    {
      sql: "DELETE FROM plan_thread_member WHERE thread_id = ? AND person_id = ?",
      params: [t, me],
    },
  ]);
  const gone = await collect(storage, { threads: [t] }, now);
  return { deleted: gone.threads.length > 0 };
}
