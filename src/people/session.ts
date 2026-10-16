// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { timingSafeEqual } from "../oauth/pkce.js";
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
