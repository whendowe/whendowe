// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { RESPONSE_RESEND_INTERVAL_MS } from "../events/response.js";
import { hashToken, issueToken } from "../people/tokens.js";
import { findThreadForMember, type ThreadAccess } from "./thread.js";

// Voting without an account (DESIGN §10 rc26; WORKFLOWS §2): one link per person per
// thread, emailed by the organizer. The link shows the plans on the table and records
// votes; it never signs anyone in. Like the response links (events/response.ts), only
// the hash is stored, re-issuing replaces the old link, and the person's membership is
// re-checked on every use, never cached in the link.

export const VOTE_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface IssuedVoteLink {
  readonly threadId: string;
  readonly personId: string;
  readonly email: string;
  /** The raw token: put it in the email, never store or log it. */
  readonly token: string;
}

export type IssueVoteLinksResult =
  | {
      readonly kind: "issued";
      readonly links: readonly IssuedVoteLink[];
      readonly throttled: number;
    }
  | { readonly kind: "forbidden" }
  /** Nothing is on the table to vote on. */
  | { readonly kind: "closed" };

const recipientRowSchema = z.object({ person_id: z.string(), email: z.string() });

/**
 * Issue a link to every member but the organizer asking, and but guests and former
 * members, who have no address to send it to (rc25, rc21). Only the organizer may: the
 * mail goes out in their name. Per member ONE upsert, replacing a link older than the
 * resend interval (rotate on resend); RETURNING says whether a fresh token was stored,
 * and only then is it handed out, so a throttled member is never sent a dead link.
 */
export async function issueVoteLinks(
  storage: StoragePort,
  access: ThreadAccess,
  input: {
    readonly now: string;
    readonly newToken?: typeof issueToken;
    /** Just this member (rc36: copying their link). */
    readonly only?: string;
    /** To copy, not to email (rc36): replace their link even within the resend hour. */
    readonly copy?: boolean;
  },
): Promise<IssueVoteLinksResult> {
  if (access.thread.organizerId !== access.personId) return { kind: "forbidden" };
  const open = await storage.query({
    sql: "SELECT 1 AS ok FROM plan WHERE thread_id = ? AND status = 'on_table' LIMIT 1",
    params: [access.thread.id],
  });
  if (open.length === 0) return { kind: "closed" };

  const now = Date.parse(input.now);
  const expiresAt = new Date(now + VOTE_LINK_TTL_MS).toISOString();
  const resendCutoff =
    input.copy === true ? input.now : new Date(now - RESPONSE_RESEND_INTERVAL_MS).toISOString();
  const recipients = (
    await storage.query({
      sql: `SELECT m.person_id, p.email FROM plan_thread_member m JOIN person p ON p.id = m.person_id
            WHERE m.thread_id = ? AND m.person_id <> ? AND p.guest_at IS NULL AND p.erased_at IS NULL
              AND (? IS NULL OR m.person_id = ?)
            ORDER BY p.email`,
      params: [access.thread.id, access.personId, input.only ?? null, input.only ?? null],
    })
  ).map((row) => recipientRowSchema.parse(row));

  const links: IssuedVoteLink[] = [];
  for (const r of recipients) {
    const issued = await (input.newToken ?? issueToken)();
    const stored = await storage.query({
      sql: `INSERT INTO plan_vote_token (token_hash, thread_id, person_id, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (thread_id, person_id) DO UPDATE
              SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, created_at = excluded.created_at
              WHERE plan_vote_token.created_at <= ?
            RETURNING person_id`,
      params: [issued.hash, access.thread.id, r.person_id, expiresAt, input.now, resendCutoff],
    });
    if (stored.length === 1)
      links.push({
        threadId: access.thread.id,
        personId: r.person_id,
        email: r.email,
        token: issued.token,
      });
  }
  return { kind: "issued", links, throttled: recipients.length - links.length };
}

/**
 * Withdraw a link that couldn't be delivered, so a retry isn't throttled for someone who
 * never got it. Matches on the hash: it can only remove that undelivered link.
 */
export async function revokeUndeliveredVoteLink(
  storage: StoragePort,
  link: IssuedVoteLink,
): Promise<void> {
  await storage.batch([
    {
      sql: "DELETE FROM plan_vote_token WHERE thread_id = ? AND person_id = ? AND token_hash = ?",
      params: [link.threadId, link.personId, await hashToken(link.token)],
    },
  ]);
}

const tokenRowSchema = z.object({ thread_id: z.string(), person_id: z.string() });

/**
 * The thread as the link's person sees it, or null — for unknown, replaced and expired
 * links alike, and for someone no longer in the thread. Read-only: the page (GET) and
 * the vote (POST) both call this, so the POST re-checks at the moment of acting.
 */
export async function resolveVoteLink(
  storage: StoragePort,
  token: string,
  now: string,
): Promise<ThreadAccess | null> {
  if (token === "") return null;
  const rows = await storage.query({
    sql: "SELECT thread_id, person_id FROM plan_vote_token WHERE token_hash = ? AND expires_at > ?",
    params: [await hashToken(token), now],
  });
  if (rows[0] === undefined) return null;
  const row = tokenRowSchema.parse(rows[0]);
  return findThreadForMember(storage, row.thread_id, row.person_id);
}
