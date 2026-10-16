// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { normalizeEmail } from "./person.js";
import { hashToken, issueToken } from "./tokens.js";

// Magic-link login (DESIGN §13 token-link rules): single-purpose, short-lived,
// single-use. Sign-up and sign-in are the same flow — the first consumed link for an
// address creates its person (person.ts), and REQUESTING a link creates nothing, so
// typos and strangers leave no accounts behind.

/** Long enough to switch to a mail app; short enough that a stale link is useless. */
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Per-address requests allowed in the rate-limit window. */
export const LOGIN_REQUESTS_PER_WINDOW = 5;
export const LOGIN_RATE_WINDOW_MS = 60 * 60 * 1000;

function plusMs(iso: string, ms: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error("invalid `now`");
  return new Date(t + ms).toISOString();
}

export type IssueResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly email: string;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly reason: "rate_limited" };

/**
 * Issue a login token for an address, if it is under its rate limit.
 *
 * The rate limit and the insert are ONE statement (… WHERE recent count < limit
 * RETURNING id), the same reservation shape as the mail cap: concurrent requests
 * cannot each see room. It protects the person's inbox from being flooded by someone
 * else typing their address, and the mail cap from one address eating the budget.
 */
export async function issueLoginToken(
  storage: StoragePort,
  rawEmail: string,
  options: { readonly now: string; readonly newId?: () => string },
): Promise<IssueResult> {
  const email = normalizeEmail(rawEmail);
  const { token, hash } = await issueToken();
  const expiresAt = plusMs(options.now, LOGIN_TOKEN_TTL_MS);
  const windowStart = plusMs(options.now, -LOGIN_RATE_WINDOW_MS);
  const rows = await storage.query({
    sql: `INSERT INTO login_token (id, token_hash, email, expires_at, created_at)
          SELECT ?, ?, ?, ?, ?
          WHERE (SELECT count(*) FROM login_token WHERE email = ? AND created_at > ?) < ?
          RETURNING id`,
    params: [
      (options.newId ?? (() => uuidv7()))(),
      hash,
      email,
      expiresAt,
      options.now,
      email,
      windowStart,
      LOGIN_REQUESTS_PER_WINDOW,
    ],
  });
  return rows.length === 0
    ? { ok: false, reason: "rate_limited" }
    : { ok: true, token, email, expiresAt };
}

const consumedSchema = z.object({ email: z.string() });

/**
 * Consume a login token: the email it proves, or null.
 *
 * ONE statement — UPDATE … WHERE unconsumed AND unexpired RETURNING email — so a
 * link clicked twice at once (a double-click, or a mail scanner racing the human)
 * succeeds exactly once. Null for unknown, used and expired alike: the caller has no
 * need to know which, and telling an attacker would only help them.
 */
export async function consumeLoginToken(
  storage: StoragePort,
  token: string,
  options: { readonly now: string },
): Promise<string | null> {
  const rows = await storage.query({
    sql: `UPDATE login_token SET consumed_at = ?
          WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
          RETURNING email`,
    params: [options.now, await hashToken(token), options.now],
  });
  return rows[0] === undefined ? null : consumedSchema.parse(rows[0]).email;
}
