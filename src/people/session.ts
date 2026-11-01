// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { timingSafeEqual } from "../oauth/pkce.js";
import { type Account, MAX_ACCOUNTS } from "./accounts.js";
import { csrfTokenFor, hashToken, issueToken } from "./tokens.js";

// Sessions (DESIGN §13). The cookie carries a random token; only its hash is stored.
//
// Fixed 30-day lifetime, NOT sliding. A sliding expiry writes on every request, and
// on D1 the daily write budget is the scarce resource (§6). Signing in again monthly
// via a magic link is cheap; a write per page view is not.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface NewSession {
  /** Goes into the cookie. Never stored. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly personId: string;
  /** Render into every form; verify on every mutating request. */
  readonly csrfToken: string;
}

export async function createSession(
  storage: StoragePort,
  personId: string,
  options: { readonly now: string; readonly newId?: () => string },
): Promise<NewSession> {
  const { token, hash } = await issueToken();
  const sessionId = (options.newId ?? (() => uuidv7()))();
  const t = new Date(options.now).getTime();
  if (Number.isNaN(t)) throw new Error("invalid `now`");
  const expiresAt = new Date(t + SESSION_TTL_MS).toISOString();
  await storage.batch([
    {
      sql: `INSERT INTO session (id, token_hash, person_id, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [sessionId, hash, personId, options.now, expiresAt],
    },
    // The first session marks the person as having signed in (rc24).
    {
      sql: "UPDATE person SET signed_in_at = ? WHERE id = ? AND signed_in_at IS NULL",
      params: [options.now, personId],
    },
  ]);
  return { token, sessionId, expiresAt };
}

const sessionRowSchema = z.object({ id: z.string(), person_id: z.string() });

/** The live session for a cookie token, or null if unknown, expired, or revoked. */
export async function resolveSession(
  storage: StoragePort,
  token: string,
  options: { readonly now: string },
): Promise<ResolvedSession | null> {
  const rows = await storage.query({
    sql: `SELECT id, person_id FROM session
          WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    params: [await hashToken(token), options.now],
  });
  if (rows[0] === undefined) return null;
  const row = sessionRowSchema.parse(rows[0]);
  return { sessionId: row.id, personId: row.person_id, csrfToken: await csrfTokenFor(token) };
}

// A fixed statement: one slot per account a cookie may hold. Constant text, so the
// query is still parameterised; this throws at load if the limit and the slots drift.
const SLOTS = "?, ?, ?, ?";
if (SLOTS.split("?").length - 1 !== MAX_ACCOUNTS) throw new Error("SLOTS must match MAX_ACCOUNTS");

const accountRowSchema = z.object({
  id: z.string(),
  person_id: z.string(),
  email: z.string(),
  token_hash: z.string(),
  erase_after: z.string().nullable(),
});

/**
 * The live sessions among a browser's tokens (DESIGN §13 rc18), in the order given,
 * with each one's person. Unknown, expired and revoked tokens are left out. One read,
 * whatever the count: the statement always has MAX_ACCOUNTS slots, and unused ones
 * hold an empty string, which no token hashes to.
 */
export async function resolveAccounts(
  storage: StoragePort,
  tokens: readonly string[],
  options: { readonly now: string },
): Promise<Account[]> {
  const wanted = tokens.slice(0, MAX_ACCOUNTS);
  if (wanted.length === 0) return [];
  const hashes = await Promise.all(wanted.map(hashToken));
  const slots = Array.from({ length: MAX_ACCOUNTS }, (_, i) => hashes[i] ?? "");
  const rows = await storage.query({
    sql: `SELECT session.id, session.person_id, person.email, session.token_hash,
                 account_deletion.erase_after
          FROM session JOIN person ON person.id = session.person_id
          LEFT JOIN account_deletion ON account_deletion.person_id = session.person_id
          WHERE session.token_hash IN (${SLOTS})
            AND session.revoked_at IS NULL AND session.expires_at > ?`,
    params: [...slots, options.now],
  });
  const byHash = new Map<string, z.infer<typeof accountRowSchema>>();
  for (const r of rows) {
    const row = accountRowSchema.parse(r);
    byHash.set(row.token_hash, row);
  }
  const accounts: Account[] = [];
  wanted.forEach((token, i) => {
    const row = byHash.get(hashes[i] ?? "");
    if (row !== undefined) {
      accounts.push({
        token,
        sessionId: row.id,
        personId: row.person_id,
        email: row.email,
        deletesAt: row.erase_after,
      });
    }
  });
  return accounts;
}

/** Constant-time check of a submitted CSRF token against the session's. */
export async function verifyCsrf(sessionToken: string, presented: string): Promise<boolean> {
  return timingSafeEqual(await csrfTokenFor(sessionToken), presented);
}

/** Sign out this browser. */
export async function revokeSession(
  storage: StoragePort,
  token: string,
  now: string,
): Promise<void> {
  await storage.batch([
    {
      sql: "UPDATE session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      params: [now, await hashToken(token)],
    },
  ]);
}

/** Sign out everywhere — the escape hatch for a lost or shared device. */
export async function revokeAllSessions(
  storage: StoragePort,
  personId: string,
  now: string,
): Promise<void> {
  await storage.batch([
    {
      sql: "UPDATE session SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL",
      params: [now, personId],
    },
  ]);
}
