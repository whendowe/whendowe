// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { handleSchema } from "../people/person.js";
import { hashToken, issueToken } from "../people/tokens.js";
import { listNotes, type PlanNote } from "./note.js";
import { listPlans, type Plan } from "./plan.js";
import {
  findThreadById,
  findThreadForMember,
  MAX_MEMBERS,
  memberName,
  type Thread,
  type ThreadAccess,
  ThreadInputError,
  type ThreadMember,
  threadMembers,
} from "./thread.js";

// Shared links (DESIGN §10 rc25, rc29; slice L1): one link for a whole question, pasted into
// a group chat. Signed in, opening it joins the thread; otherwise the person claims a name
// and becomes a guest — a person whose address is '<id>@guest.invalid', never mailed, unable
// to sign in. Like every token here, only hashes are stored, and the link is re-checked at
// the moment of acting (the statement that joins carries the check), never cached.
//
// Who the link is for (rc29): the people in the chat, answering in two taps. Nothing here
// gives a guest anything an account lacks.

export const SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Guests a question takes in a day (rc25): a pasted link is public to whoever sees it. */
export const GUESTS_PER_DAY = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export type IssueShareLinkResult =
  /** The raw token: show it to the organizer, never store or log it. */
  | { readonly kind: "issued"; readonly token: string; readonly expiresAt: string }
  | { readonly kind: "forbidden" }
  /** Nothing is on the table to vote on. */
  | { readonly kind: "closed" };

/**
 * Make the thread's shared link, replacing any it had (rc25: re-issuing kills the old one).
 * Only the organizer may. The first link also marks the thread shared, which hands the
 * decision to the organizer for good (rc29) — in the same batch, so no link exists for a
 * thread still deciding by consensus.
 */
export async function issueShareLink(
  storage: StoragePort,
  access: ThreadAccess,
  input: { readonly now: string; readonly newToken?: typeof issueToken },
): Promise<IssueShareLinkResult> {
  if (access.thread.organizerId !== access.personId) return { kind: "forbidden" };
  if (!(await anythingOnTable(storage, access.thread.id))) return { kind: "closed" };
  const issued = await (input.newToken ?? issueToken)();
  const expiresAt = new Date(Date.parse(input.now) + SHARE_LINK_TTL_MS).toISOString();
  await storage.batch([
    {
      sql: `INSERT INTO share_link (token_hash, thread_id, created_by, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (thread_id) DO UPDATE SET token_hash = excluded.token_hash,
              created_by = excluded.created_by, expires_at = excluded.expires_at,
              created_at = excluded.created_at`,
      params: [issued.hash, access.thread.id, access.personId, expiresAt, input.now],
    },
    {
      sql: "UPDATE plan_thread SET shared_at = ? WHERE id = ? AND shared_at IS NULL",
      params: [input.now, access.thread.id],
    },
  ]);
  return { kind: "issued", token: issued.token, expiresAt };
}

/** Turn the link off. The thread stays the organizer's to decide (rc29). */
export async function turnOffShareLink(
  storage: StoragePort,
  access: ThreadAccess,
): Promise<{ readonly kind: "off" | "forbidden" }> {
  if (access.thread.organizerId !== access.personId) return { kind: "forbidden" };
  await storage.batch([
    { sql: "DELETE FROM share_link WHERE thread_id = ?", params: [access.thread.id] },
  ]);
  return { kind: "off" };
}

/** Whether the thread has a live link, and until when — for the organizer's page. */
export async function shareLinkExpiry(
  storage: StoragePort,
  access: ThreadAccess,
  now: string,
): Promise<string | null> {
  const [row] = await storage.query({
    sql: "SELECT expires_at FROM share_link WHERE thread_id = ? AND expires_at > ?",
    params: [access.thread.id, now],
  });
  return row === undefined ? null : z.object({ expires_at: z.string() }).parse(row).expires_at;
}

/**
 * What a live link opens, before anyone has joined: the thread, and the names already in it
 * so a claim can't take one. Never an address (rc25: it shows nothing above DETAILS).
 */
export interface SharedQuestion {
  readonly thread: Thread;
  readonly names: readonly string[];
  /** Whether anything is still on the table; a decided question takes no one new. */
  readonly open: boolean;
  /** The link's hash, for the statements that act on it to re-check it. */
  readonly tokenHash: string;
}

/** The question a link opens, or null — for unknown, replaced and expired links alike. Read-only. */
export async function resolveShareLink(
  storage: StoragePort,
  token: string,
  now: string,
): Promise<SharedQuestion | null> {
  if (token === "") return null;
  const tokenHash = await hashToken(token);
  const [row] = await storage.query({
    sql: "SELECT thread_id FROM share_link WHERE token_hash = ? AND expires_at > ?",
    params: [tokenHash, now],
  });
  if (row === undefined) return null;
  const threadId = z.object({ thread_id: z.string() }).parse(row).thread_id;
  const thread = await findThreadById(storage, threadId);
  if (thread === null) return null;
  const names = (await threadMembers(storage, threadId)).map(memberName);
  return { thread, names, open: await anythingOnTable(storage, threadId), tokenHash };
}

/**
 * What someone not yet in the thread may see from a live link: the plans on the table and the
 * public notes, as any member sees them (rc25: nothing above DETAILS — and no draft, since
 * nobody is its author). The link is the proof; there is no person yet, so no access is
 * handed out.
 */
export async function questionAsOutsider(
  storage: StoragePort,
  question: SharedQuestion,
): Promise<{
  readonly onTable: readonly Plan[];
  readonly notes: readonly PlanNote[];
  readonly members: readonly ThreadMember[];
}> {
  // An address a member shows to the thread is not shown to whoever holds the link.
  const members = (await threadMembers(storage, question.thread.id)).map((m) => ({
    ...m,
    shown: { ...m.shown, email: null },
  }));
  const nobody: ThreadAccess = { thread: question.thread, personId: "", members };
  const onTable = (await listPlans(storage, nobody)).filter((p) => p.status === "on_table");
  return { onTable, notes: await listNotes(storage, nobody), members };
}

export type JoinResult =
  | { readonly kind: "joined"; readonly access: ThreadAccess }
  /** The link went, or the question closed, between the page and the tap. */
  | { readonly kind: "gone" }
  | { readonly kind: "full" };

/**
 * A signed-in person joins from the link (rc25: one tap). Already a member, it is a no-op
 * that answers "joined". The insert carries the link, the open question and the member cap,
 * so a link turned off a moment ago adds nobody.
 */
export async function joinByShareLink(
  storage: StoragePort,
  question: SharedQuestion,
  personId: string,
  now: string,
): Promise<JoinResult> {
  const threadId = question.thread.id;
  await storage.batch([
    {
      sql: `INSERT INTO plan_thread_member (thread_id, person_id, created_at)
            SELECT ?, ?, ? WHERE ${LIVE} AND ${ROOM}
            ON CONFLICT DO NOTHING`,
      params: [threadId, personId, now, ...liveParams(question, now), threadId, MAX_MEMBERS],
    },
  ]);
  const access = await findThreadForMember(storage, threadId, personId);
  if (access !== null) return { kind: "joined", access };
  return (await stillLive(storage, question, now)) ? { kind: "full" } : { kind: "gone" };
}

export type ClaimResult =
  | {
      readonly kind: "claimed";
      readonly access: ThreadAccess;
      /** The claim link's token ("keep this link"): show it once, never store or log it. */
      readonly token: string;
    }
  | { readonly kind: "taken" }
  /** GUESTS_PER_DAY guests joined in the last day. */
  | { readonly kind: "busy" }
  | { readonly kind: "full" }
  | { readonly kind: "gone" };

/** A name compared the way people read it: trimmed, spaces collapsed, case ignored. */
const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Claim a name from the link: a new guest, a member with that handle, and its claim token,
 * in one batch. Throws ThreadInputError for a name no handle may be.
 *
 * The name must differ from everyone's shown name (rc29). That is checked here against the
 * names as shown, and again by the INSERT against every handle in the thread, so two guests
 * racing for one name can't both have it (the SQL's lower() folds ASCII only; the check
 * before it folds the rest). Each later statement runs only if the guest row went in.
 */
export async function claimName(
  storage: StoragePort,
  question: SharedQuestion,
  input: {
    readonly name: string;
    readonly now: string;
    readonly newId?: () => string;
    readonly newToken?: typeof issueToken;
  },
): Promise<ClaimResult> {
  const parsed = handleSchema.safeParse(input.name);
  if (!parsed.success)
    throw new ThreadInputError(parsed.error.issues[0]?.message ?? "Choose a name.");
  const name = parsed.data.replace(/\s+/g, " ");
  const threadId = question.thread.id;
  const names = (await threadMembers(storage, threadId)).map(memberName);
  if (names.some((n) => nameKey(n) === nameKey(name))) return { kind: "taken" };
  const dayAgo = new Date(Date.parse(input.now) - DAY_MS).toISOString();
  const [count] = await storage.query({
    sql: "SELECT count(*) AS n FROM guest_claim WHERE thread_id = ? AND created_at > ?",
    params: [threadId, dayAgo],
  });
  if (Number(count?.n ?? 0) >= GUESTS_PER_DAY) return { kind: "busy" };

  const guestId = (input.newId ?? (() => uuidv7()))();
  const issued = await (input.newToken ?? issueToken)();
  const guestExists = "EXISTS (SELECT 1 FROM person WHERE id = ?)";
  await storage.batch([
    {
      sql: `INSERT INTO person (id, email, display_name, created_at, guest_at)
            SELECT ?, ?, NULL, ?, ? WHERE ${LIVE} AND ${ROOM}
              AND NOT EXISTS (SELECT 1 FROM plan_thread_member
                              WHERE thread_id = ? AND lower(handle) = lower(?))`,
      params: [
        guestId,
        `${guestId}@guest.invalid`,
        input.now,
        input.now,
        ...liveParams(question, input.now),
        threadId,
        MAX_MEMBERS,
        threadId,
        name,
      ],
    },
    {
      sql: `INSERT INTO plan_thread_member (thread_id, person_id, created_at, handle)
            SELECT ?, ?, ?, ? WHERE ${guestExists}`,
      params: [threadId, guestId, input.now, name, guestId],
    },
    {
      sql: `INSERT INTO guest_claim (token_hash, person_id, thread_id, created_at)
            SELECT ?, ?, ?, ? WHERE ${guestExists}`,
      params: [issued.hash, guestId, threadId, input.now, guestId],
    },
  ]);
  const access = await findThreadForMember(storage, threadId, guestId);
  if (access !== null) return { kind: "claimed", access, token: issued.token };
  if (!(await stillLive(storage, question, input.now))) return { kind: "gone" };
  const now = (await threadMembers(storage, threadId)).map(memberName);
  return now.length >= MAX_MEMBERS ? { kind: "full" } : { kind: "taken" };
}

/**
 * The thread as a claim's guest sees it, or null — for an unknown claim, one for another
 * thread, and a guest who has left or been removed. Read-only.
 */
export async function resolveClaim(
  storage: StoragePort,
  token: string,
  threadId: string,
): Promise<ThreadAccess | null> {
  if (token === "") return null;
  const [row] = await storage.query({
    sql: "SELECT person_id FROM guest_claim WHERE token_hash = ? AND thread_id = ?",
    params: [await hashToken(token), threadId],
  });
  if (row === undefined) return null;
  const personId = z.object({ person_id: z.string() }).parse(row).person_id;
  return findThreadForMember(storage, threadId, personId);
}

// The conditions every join carries, so it is decided at the moment of writing.
const LIVE = `EXISTS (SELECT 1 FROM share_link WHERE token_hash = ? AND thread_id = ? AND expires_at > ?)
  AND EXISTS (SELECT 1 FROM plan WHERE thread_id = ? AND status = 'on_table')`;
const liveParams = (q: SharedQuestion, now: string) => [q.tokenHash, q.thread.id, now, q.thread.id];
const ROOM = "(SELECT count(*) FROM plan_thread_member WHERE thread_id = ?) < ?";

async function stillLive(storage: StoragePort, q: SharedQuestion, now: string): Promise<boolean> {
  const rows = await storage.query({
    sql: `SELECT 1 AS ok WHERE ${LIVE}`,
    params: liveParams(q, now),
  });
  return rows.length > 0;
}

async function anythingOnTable(storage: StoragePort, threadId: string): Promise<boolean> {
  const rows = await storage.query({
    sql: "SELECT 1 AS ok FROM plan WHERE thread_id = ? AND status = 'on_table' LIMIT 1",
    params: [threadId],
  });
  return rows.length > 0;
}

// --- Moving a guest's answers (rc30, slice L2) ------------------------------------------

export type MoveGuestResult =
  | { readonly kind: "moved"; readonly threadIds: readonly string[] }
  /** No such guest any more — removed, collected, or already moved — or no such account. */
  | { readonly kind: "gone" };

/**
 * Move everything a guest is to an account, then delete the guest (rc30): confirming by
 * email and signing in over a claim both end here. The guest's answers win where both
 * answered; the account takes the guest's place, and its name in a thread the account
 * wasn't in; anything else the guest became passes over, the account's own row kept
 * where both have one. What a guest can become is what the shared page lets it: a member
 * who votes and notes, the organizer after a hand-over (leaveThread), and a participant of
 * the event its thread agreed. Anything more would need a page a guest doesn't have; the
 * guest's deletion would take it, as for any person.
 *
 * One batch, and every statement carries the same guard (the guest is a guest, the
 * account is not), so a second move of the same guest — a double-click, or the mail
 * link racing the shared page — finds no guest and changes nothing. (Both callers hear
 * "moved" then; the one that lost the race moved nothing, and its page says nothing more.)
 */
export async function moveGuest(
  storage: StoragePort,
  input: { readonly guestId: string; readonly personId: string },
): Promise<MoveGuestResult> {
  const g = input.guestId;
  const a = input.personId;
  const guard = `EXISTS (SELECT 1 FROM person WHERE id = ? AND guest_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM person WHERE id = ? AND guest_at IS NULL AND erased_at IS NULL)`;
  const both = [g, a];
  if (
    g === a ||
    (await storage.query({ sql: `SELECT 1 AS ok WHERE ${guard}`, params: both })).length === 0
  )
    return { kind: "gone" };
  const threads = await storage.query({
    sql: "SELECT thread_id FROM plan_thread_member WHERE person_id = ?",
    params: [g],
  });
  await storage.batch([
    // Its place in each thread: the guest's name and join time, unless the account is in.
    {
      sql: `INSERT INTO plan_thread_member (thread_id, person_id, created_at, handle)
            SELECT m.thread_id, ?, m.created_at, m.handle FROM plan_thread_member m
            WHERE m.person_id = ? AND ${guard}
              AND NOT EXISTS (SELECT 1 FROM plan_thread_member o
                              WHERE o.thread_id = m.thread_id AND o.person_id = ?)`,
      params: [a, g, ...both, a],
    },
    // The guest's answers win: the account's answer to the same plan goes first.
    {
      sql: `DELETE FROM plan_vote WHERE person_id = ?
              AND plan_id IN (SELECT plan_id FROM plan_vote WHERE person_id = ?) AND ${guard}`,
      params: [a, g, ...both],
    },
    {
      sql: `UPDATE plan_vote SET person_id = ? WHERE person_id = ? AND ${guard}`,
      params: [a, g, ...both],
    },
    {
      sql: `UPDATE plan_note SET author_id = ? WHERE author_id = ? AND ${guard}`,
      params: [a, g, ...both],
    },
    {
      sql: `UPDATE plan_thread SET organizer_id = ? WHERE organizer_id = ? AND ${guard}`,
      params: [a, g, ...both],
    },
    // An event the thread agreed: the account's own participation kept where it has one.
    {
      sql: `UPDATE event_participation SET person_id = ? WHERE person_id = ? AND ${guard}
              AND canonical_event_id NOT IN
                (SELECT canonical_event_id FROM event_participation WHERE person_id = ?)`,
      params: [a, g, ...both, a],
    },
    // Last, the guest itself: what is left of it (its claim, its membership) goes with it.
    { sql: `DELETE FROM person WHERE id = ? AND ${guard}`, params: [g, ...both] },
  ]);
  return {
    kind: "moved",
    threadIds: threads.map((r) => z.object({ thread_id: z.string() }).parse(r).thread_id),
  };
}

// --- Removing a guest (rc30, slice L2) --------------------------------------------------

export type RemoveGuestResult =
  | { readonly kind: "removed"; readonly name: string }
  | { readonly kind: "forbidden" }
  /** Not a guest in this thread any more: moved to an account, collected or removed. */
  | { readonly kind: "gone" };

/**
 * The organizer removes a guest (rc30): the guest is deleted, its answers, notes and claim
 * with it, and its name is free again. Only a guest of this thread, and only by whoever
 * organizes it when the statement runs, so a hand-over meanwhile refuses it. A guest that
 * organizes a thread is never deleted here: the thread would go with it.
 */
export async function removeGuest(
  storage: StoragePort,
  access: ThreadAccess,
  guestId: string,
): Promise<RemoveGuestResult> {
  if (access.thread.organizerId !== access.personId) return { kind: "forbidden" };
  const guest = access.members.find((m) => m.personId === guestId && m.guest);
  if (guest === undefined) return { kind: "gone" };
  const threadId = access.thread.id;
  const rows = await storage.query({
    sql: `DELETE FROM person WHERE id = ? AND guest_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM plan_thread_member WHERE thread_id = ? AND person_id = ?)
            AND EXISTS (SELECT 1 FROM plan_thread WHERE id = ? AND organizer_id = ?)
            AND NOT EXISTS (SELECT 1 FROM plan_thread WHERE organizer_id = ?)
          RETURNING id`,
    params: [guestId, threadId, guestId, threadId, access.personId, guestId],
  });
  return rows.length > 0 ? { kind: "removed", name: memberName(guest) } : { kind: "gone" };
}
