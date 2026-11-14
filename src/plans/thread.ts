// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { SqlStatement, StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { type Shown, shownAs, shownRowSchema } from "../people/person.js";
import { hashToken, issueToken } from "../people/tokens.js";
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
  /** rc42: when it was made verified — votes only from a mailed link or signed in. */
  readonly verifiedAt: string | null;
}

export interface ThreadMember {
  readonly personId: string;
  /** As the other members see them (DESIGN §10 rc21): a handle, an address only if shown. */
  readonly shown: Shown;
  /** A name claimed from a shared link, not yet an account's (rc29): "not confirmed" (rc30). */
  readonly guest: boolean;
  /** rc42: "only my own email answers for me" here: no copied vote link answers as them. */
  readonly ownAnswersOnly: boolean;
}

/**
 * rc42: a member's group default for their own answers, for a thread started from a group;
 * 0 otherwise. Params: the thread's id, then the person's.
 */
export const OWN_ANSWERS_DEFAULT = `coalesce((SELECT gm.default_own_answers_only FROM group_member gm
  WHERE gm.group_id = (SELECT t.group_id FROM plan_thread t WHERE t.id = ?) AND gm.person_id = ?), 0)`;

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
    /** rc42: made verified; a group whose organizers set its default makes it so anyway. */
    readonly verified?: boolean;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<Thread> {
  const verified = await verifiedAtBirth(storage, input.groupId ?? null, input.verified === true);
  const { thread, statements } = threadStatements({ ...input, verified });
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
  /** rc42: verified from birth — already decided, with the group's default (verifiedAtBirth). */
  readonly verified: boolean;
  readonly now: string;
  readonly newId?: () => string;
}): { readonly thread: Thread; readonly statements: SqlStatement[] } {
  const name = normalizeThreadName(input.name);
  if (!isTimeZone(input.tzid)) throw new ThreadInputError("Choose a valid time zone.");
  const others = [...new Set(input.memberIds)].filter((id) => id !== input.creatorId);
  if (others.length === 0 && input.alone !== true)
    throw new ThreadInputError("Add at least one person to plan with.");
  const id = (input.newId ?? (() => uuidv7()))();
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO plan_thread (id, name, organizer_id, tzid, created_at, group_id, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        name,
        input.creatorId,
        input.tzid,
        input.now,
        input.groupId ?? null,
        input.verified ? input.now : null,
      ],
    },
    ...[input.creatorId, ...others].map((personId) => ({
      sql: `INSERT INTO plan_thread_member (thread_id, person_id, created_at, own_answers_only)
            VALUES (?, ?, ?, ${OWN_ANSWERS_DEFAULT})`,
      params: [id, personId, input.now, id, personId],
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
    verifiedAt: input.verified ? input.now : null,
  };
  return { thread, statements };
}

/** Whether a new thread is verified (rc42): asked to be, or its group's organizers say so. */
export async function verifiedAtBirth(
  storage: StoragePort,
  groupId: string | null,
  asked: boolean,
): Promise<boolean> {
  if (asked) return true;
  if (groupId === null) return false;
  const rows = await storage.query({
    sql: "SELECT default_verified FROM person_group WHERE id = ?",
    params: [groupId],
  });
  return rows[0]?.default_verified === 1;
}

/**
 * Make a thread verified (DESIGN §10 rc42): votes count only from a link mailed to the
 * person or signed in, and nobody joins by its shared link. Whoever decides it may. Its
 * copied vote links (and those from before rc42 recorded how they were made) and its shared
 * link go in the same batch; a guest already in stays listed and can no longer vote.
 */
export async function setThreadVerified(
  storage: StoragePort,
  access: ThreadAccess,
  now: string,
): Promise<"verified" | "already" | "forbidden"> {
  if (!deciders(access).includes(access.personId)) return "forbidden";
  const threadId = access.thread.id;
  await storage.batch([
    {
      sql: "UPDATE plan_thread SET verified_at = ? WHERE id = ? AND verified_at IS NULL",
      params: [now, threadId],
    },
    {
      sql: `DELETE FROM plan_vote_token
            WHERE thread_id = ? AND (origin IS NULL OR origin <> 'mailed')`,
      params: [threadId],
    },
    { sql: "DELETE FROM share_link WHERE thread_id = ?", params: [threadId] },
  ]);
  return access.thread.verifiedAt === null ? "verified" : "already";
}

const threadRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  organizer_id: z.string(),
  tzid: z.string(),
  created_at: z.string(),
  group_id: z.string().nullable(),
  shared_at: z.string().nullable(),
  verified_at: z.string().nullable(),
});

const memberRowSchema = shownRowSchema.extend({
  person_id: z.string(),
  guest_at: z.string().nullable(),
  own_answers_only: z.number(),
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
    verifiedAt: r.verified_at,
  };
}

/** The thread IF the person is a member; null for "missing" and "not yours" alike. */
export async function findThreadForMember(
  storage: StoragePort,
  threadId: string,
  personId: string,
): Promise<ThreadAccess | null> {
  const rows = await storage.query({
    sql: `SELECT t.id, t.name, t.organizer_id, t.tzid, t.created_at, t.group_id, t.shared_at, t.verified_at
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
      // rc42: in a verified thread everyone in it sees each member's address.
      sql: `SELECT m.person_id, p.email, p.display_name, m.handle,
              CASE WHEN (SELECT t.verified_at FROM plan_thread t WHERE t.id = m.thread_id) IS NULL
                THEN m.show_email ELSE 1 END AS show_email,
              p.guest_at, m.own_answers_only
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
      ownAnswersOnly: r.own_answers_only === 1,
    };
  });
}

/** The thread by id, for a caller that has proven a right to it some other way (a shared link). */
export async function findThreadById(
  storage: StoragePort,
  threadId: string,
): Promise<Thread | null> {
  const rows = await storage.query({
    sql: "SELECT id, name, organizer_id, tzid, created_at, group_id, shared_at, verified_at FROM plan_thread WHERE id = ?",
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
    sql: `SELECT t.id, t.name, t.organizer_id, t.tzid, t.created_at, t.group_id, t.shared_at, t.verified_at,
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

// --- Receipts that didn't go out (DESIGN §10 rc42), as on events (events/response.ts) ----

/** Remember that a receipt for this member's votes here didn't go out, for the history. */
export async function recordUnsentThreadReceipt(
  storage: StoragePort,
  input: {
    readonly threadId: string;
    readonly personId: string;
    readonly reason: "suppressed" | "capped" | "failed";
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<void> {
  await storage.batch([
    {
      sql: `INSERT INTO receipt_unsent (id, thread_id, person_id, reason, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [
        (input.newId ?? (() => uuidv7()))(),
        input.threadId,
        input.personId,
        input.reason,
        input.now,
      ],
    },
  ]);
}

export interface UnsentThreadReceipt {
  readonly personId: string;
  readonly reason: "suppressed" | "capped" | "failed";
  readonly at: string;
}

const unsentThreadRowSchema = z.object({
  person_id: z.string(),
  reason: z.enum(["suppressed", "capped", "failed"]),
  created_at: z.string(),
});

/** The receipts that didn't go out in this thread; the caller is a member. */
export async function listUnsentThreadReceipts(
  storage: StoragePort,
  access: ThreadAccess,
): Promise<UnsentThreadReceipt[]> {
  const rows = await storage.query({
    sql: "SELECT person_id, reason, created_at FROM receipt_unsent WHERE thread_id = ? ORDER BY created_at",
    params: [access.thread.id],
  });
  return rows.map((row) => {
    const r = unsentThreadRowSchema.parse(row);
    return { personId: r.person_id, reason: r.reason, at: r.created_at };
  });
}

// --- Everyone agrees (DESIGN §10 rc42), as for an event (events/event.ts askEveryone) ----
//
// A verified thread stops verifying only when everyone in it agrees. A thread has no
// retention of its own and isn't deleted for good, so that is the one thing asked. Its
// members with an address must say yes: a guest can't answer in a verified thread, so a
// guest is never waited for.

export const THREAD_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** The members who must say yes: everyone in it but guests. */
const THREAD_MUST_AGREE = `SELECT m.person_id FROM plan_thread_member m JOIN person pp ON pp.id = m.person_id
  WHERE m.thread_id = ? AND pp.guest_at IS NULL`;

export interface ThreadRequestLink {
  readonly personId: string;
  readonly email: string;
  readonly token: string;
}

export type ThreadAskResult =
  | {
      readonly kind: "asked";
      readonly requestId: string;
      readonly links: readonly ThreadRequestLink[];
      readonly outcome: "agreed" | null;
    }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_verified" }
  | { readonly kind: "open" };

/** Ask everyone in a verified thread to agree to stop verifying. The asking is a yes. */
export async function askThreadEveryone(
  storage: StoragePort,
  access: ThreadAccess,
  input: {
    readonly now: string;
    readonly newId?: () => string;
    readonly newToken?: () => Promise<{ readonly token: string; readonly hash: string }>;
  },
): Promise<ThreadAskResult> {
  const me = access.members.find((m) => m.personId === access.personId);
  if (me === undefined || me.guest) return { kind: "forbidden" };
  if (access.thread.verifiedAt === null) return { kind: "not_verified" };
  const threadId = access.thread.id;
  const id = (input.newId ?? (() => uuidv7()))();
  const expiresAt = new Date(Date.parse(input.now) + THREAD_REQUEST_TTL_MS).toISOString();
  await storage.batch([
    {
      sql: `UPDATE verified_request SET closed_at = expires_at, outcome = 'lapsed'
            WHERE thread_id = ? AND closed_at IS NULL AND expires_at <= ?`,
      params: [threadId, input.now],
    },
    {
      sql: `INSERT INTO verified_request (id, thread_id, kind, asked_by, asked_at, expires_at)
            SELECT ?, ?, 'unverify', ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM verified_request WHERE thread_id = ? AND closed_at IS NULL)`,
      params: [id, threadId, access.personId, input.now, expiresAt, threadId],
    },
    {
      sql: `INSERT INTO verified_request_answer (request_id, person_id, answer, answered_at, answered_via)
            SELECT ?, ?, 'yes', ?, 'session' WHERE EXISTS (SELECT 1 FROM verified_request WHERE id = ?)`,
      params: [id, access.personId, input.now, id],
    },
  ]);
  const made = await storage.query({
    sql: "SELECT 1 AS ok FROM verified_request WHERE id = ?",
    params: [id],
  });
  if (made.length === 0) return { kind: "open" };
  const others = (
    await storage.query({
      sql: `SELECT m.person_id, p.email FROM plan_thread_member m JOIN person p ON p.id = m.person_id
            WHERE m.thread_id = ? AND m.person_id <> ? AND p.guest_at IS NULL AND p.erased_at IS NULL
            ORDER BY p.email`,
      params: [threadId, access.personId],
    })
  ).map((r) => z.object({ person_id: z.string(), email: z.string() }).parse(r));
  const links: ThreadRequestLink[] = [];
  const statements: SqlStatement[] = [];
  for (const o of others) {
    const issued = await (input.newToken ?? issueToken)();
    statements.push({
      sql: `INSERT INTO verified_request_token (token_hash, request_id, person_id, expires_at)
            VALUES (?, ?, ?, ?)`,
      params: [issued.hash, id, o.person_id, expiresAt],
    });
    links.push({ personId: o.person_id, email: o.email, token: issued.token });
  }
  if (statements.length > 0) await storage.batch(statements);
  const outcome = await decideThread(storage, threadId, id, input.now);
  return { kind: "asked", requestId: id, links, outcome: outcome === "agreed" ? "agreed" : null };
}

/** Answer a thread's request yes or no: signed in, or by the link mailed to you. */
export async function answerThreadRequest(
  storage: StoragePort,
  access: ThreadAccess,
  input: {
    readonly requestId: string;
    readonly answer: "yes" | "no";
    readonly via: "session" | "mailed";
    readonly now: string;
  },
): Promise<
  | { readonly kind: "recorded"; readonly outcome: "agreed" | "refused" | null }
  | { readonly kind: "forbidden" }
  | { readonly kind: "closed" }
> {
  const me = access.members.find((m) => m.personId === access.personId);
  if (me === undefined || me.guest) return { kind: "forbidden" };
  const written = await storage.query({
    sql: `INSERT INTO verified_request_answer (request_id, person_id, answer, answered_at, answered_via)
          SELECT r.id, ?, ?, ?, ? FROM verified_request r
          WHERE r.id = ? AND r.thread_id = ? AND r.closed_at IS NULL AND r.expires_at > ?
          ON CONFLICT (request_id, person_id) DO UPDATE
            SET answer = excluded.answer, answered_at = excluded.answered_at,
                answered_via = excluded.answered_via
          RETURNING request_id`,
    params: [
      access.personId,
      input.answer,
      input.now,
      input.via,
      input.requestId,
      access.thread.id,
      input.now,
    ],
  });
  if (written.length === 0) return { kind: "closed" };
  return {
    kind: "recorded",
    outcome: await decideThread(storage, access.thread.id, input.requestId, input.now),
  };
}

/** Close the request if decided; agreed, the thread stops verifying. Guarded, as for events. */
async function decideThread(
  storage: StoragePort,
  threadId: string,
  requestId: string,
  now: string,
): Promise<"agreed" | "refused" | null> {
  const refused = await storage.query({
    sql: `UPDATE verified_request SET closed_at = ?, outcome = 'refused'
          WHERE id = ? AND closed_at IS NULL
            AND EXISTS (SELECT 1 FROM verified_request_answer WHERE request_id = ? AND answer = 'no')
          RETURNING id`,
    params: [now, requestId, requestId],
  });
  if (refused.length > 0) return "refused";
  const agreed = await storage.query({
    sql: `UPDATE verified_request SET closed_at = ?, outcome = 'agreed'
          WHERE id = ? AND closed_at IS NULL
            AND NOT EXISTS (${THREAD_MUST_AGREE} AND NOT EXISTS (
              SELECT 1 FROM verified_request_answer a
              WHERE a.request_id = ? AND a.person_id = m.person_id AND a.answer = 'yes'))
          RETURNING id`,
    params: [now, requestId, threadId, requestId],
  });
  if (agreed.length === 0) return null;
  await storage.batch([
    { sql: "UPDATE plan_thread SET verified_at = NULL WHERE id = ?", params: [threadId] },
  ]);
  return "agreed";
}

export interface ThreadRequest {
  readonly id: string;
  readonly askedById: string | null;
  readonly askedAt: string;
  readonly expiresAt: string;
  readonly outcome: "agreed" | "refused" | "lapsed" | null;
  readonly closedAt: string | null;
  readonly answers: readonly {
    readonly personId: string;
    readonly answer: "yes" | "no";
    readonly via: "session" | "mailed";
    readonly at: string;
  }[];
  /** Who still has to say yes, while it is open. */
  readonly waitingFor: readonly string[];
}

/** Every request in this thread, oldest first, with its answers; the caller is a member. */
export async function listThreadRequests(
  storage: StoragePort,
  access: ThreadAccess,
  now: string,
): Promise<ThreadRequest[]> {
  const threadId = access.thread.id;
  const requests = (
    await storage.query({
      sql: `SELECT id, asked_by, asked_at, expires_at, closed_at, outcome FROM verified_request
            WHERE thread_id = ? ORDER BY asked_at, id`,
      params: [threadId],
    })
  ).map((r) =>
    z
      .object({
        id: z.string(),
        asked_by: z.string().nullable(),
        asked_at: z.string(),
        expires_at: z.string(),
        closed_at: z.string().nullable(),
        outcome: z.enum(["agreed", "refused", "lapsed"]).nullable(),
      })
      .parse(r),
  );
  const answers = (
    await storage.query({
      sql: `SELECT a.request_id, a.person_id, a.answer, a.answered_via, a.answered_at
            FROM verified_request_answer a JOIN verified_request r ON r.id = a.request_id
            WHERE r.thread_id = ? ORDER BY a.answered_at, a.person_id`,
      params: [threadId],
    })
  ).map((r) =>
    z
      .object({
        request_id: z.string(),
        person_id: z.string(),
        answer: z.enum(["yes", "no"]),
        answered_via: z.enum(["session", "mailed"]),
        answered_at: z.string(),
      })
      .parse(r),
  );
  const mustAgree = access.members.filter((m) => !m.guest).map((m) => m.personId);
  return requests.map((r) => {
    const mine = answers.filter((a) => a.request_id === r.id);
    const open = r.closed_at === null && r.expires_at > now;
    return {
      id: r.id,
      askedById: r.asked_by,
      askedAt: r.asked_at,
      expiresAt: r.expires_at,
      outcome: r.outcome ?? (open ? null : "lapsed"),
      closedAt: r.closed_at ?? (open ? null : r.expires_at),
      answers: mine.map((a) => ({
        personId: a.person_id,
        answer: a.answer,
        via: a.answered_via,
        at: a.answered_at,
      })),
      waitingFor: open
        ? mustAgree.filter((p) => !mine.some((a) => a.person_id === p && a.answer === "yes"))
        : [],
    };
  });
}

/** The thread and request a mailed request link is for, or null. Read-only. */
export async function resolveThreadRequestLink(
  storage: StoragePort,
  token: string,
  now: string,
): Promise<{ readonly access: ThreadAccess; readonly requestId: string } | null> {
  if (token === "") return null;
  const rows = await storage.query({
    sql: `SELECT t.request_id, t.person_id, r.thread_id
          FROM verified_request_token t JOIN verified_request r ON r.id = t.request_id
          WHERE t.token_hash = ? AND t.expires_at > ? AND r.thread_id IS NOT NULL`,
    params: [await hashToken(token), now],
  });
  if (rows[0] === undefined) return null;
  const r = z
    .object({ request_id: z.string(), person_id: z.string(), thread_id: z.string() })
    .parse(rows[0]);
  const access = await findThreadForMember(storage, r.thread_id, r.person_id);
  return access === null ? null : { access, requestId: r.request_id };
}
