// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import type { CapabilityConfig } from "./capability.js";
import { LOGIN_TOKEN_TTL_MS } from "./login.js";
import { handleSchema, normalizeEmail } from "./person.js";
import { hashToken, issueToken } from "./tokens.js";

// The first owner of an instance with no operator, and the shell's sign-in links (DESIGN §10
// rc60 *Running without email*). Both are made by a command run in the container, which prints
// the link to its own terminal: being able to run it is the proof of running the instance. No
// token is ever logged (§13/§14).

/** A setup link lasts this long; running the command again makes a new one. */
export const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000;

function plusMs(iso: string, ms: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error("invalid `now`");
  return new Date(t + ms).toISOString();
}

/** Whether the instance has an operator: one named in its configuration, or one it keeps. */
export async function hasOperator(
  storage: StoragePort,
  config: CapabilityConfig | undefined,
): Promise<boolean> {
  if (config !== undefined && config.operators.length > 0) return true;
  const rows = await storage.query({
    sql: "SELECT 1 AS one FROM instance_operator LIMIT 1",
    params: [],
  });
  return rows.length > 0;
}

/** Whether this person is one of the operators the instance keeps (rc60), beside rc43's list. */
export async function isKeptOperator(storage: StoragePort, personId: string): Promise<boolean> {
  const rows = await storage.query({
    sql: "SELECT 1 AS one FROM instance_operator WHERE person_id = ?",
    params: [personId],
  });
  return rows.length > 0;
}

const operatorRowSchema = z.object({ email: z.string() });

/** The operators the instance keeps, by address, for the operator page. */
export async function listKeptOperators(storage: StoragePort): Promise<string[]> {
  const rows = await storage.query({
    sql: `SELECT p.email FROM instance_operator o JOIN person p ON p.id = o.person_id
          ORDER BY o.added_at, p.email`,
    params: [],
  });
  return rows.map((r) => operatorRowSchema.parse(r).email);
}

export type SetupLinkResult =
  | { readonly ok: true; readonly token: string; readonly expiresAt: string }
  | { readonly ok: false; readonly reason: "has_operator" };

/**
 * Make the setup link, if the instance has no operator. Every other setup token goes in the
 * same batch, so only the newest works.
 */
export async function makeSetupLink(
  storage: StoragePort,
  config: CapabilityConfig | undefined,
  options: { readonly now: string; readonly newId?: () => string },
): Promise<SetupLinkResult> {
  if (await hasOperator(storage, config)) return { ok: false, reason: "has_operator" };
  const { token, hash } = await issueToken();
  const expiresAt = plusMs(options.now, SETUP_TOKEN_TTL_MS);
  await storage.batch([
    { sql: "DELETE FROM setup_token", params: [] },
    {
      sql: `INSERT INTO setup_token (id, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?)`,
      params: [(options.newId ?? (() => uuidv7()))(), hash, expiresAt, options.now],
    },
  ]);
  return { ok: true, token, expiresAt };
}

/** Whether a setup link would still work, WITHOUT using it: its GET page renders this. */
export async function setupLinkWorks(
  storage: StoragePort,
  config: CapabilityConfig | undefined,
  token: string,
  options: { readonly now: string },
): Promise<boolean> {
  if (await hasOperator(storage, config)) return false;
  const rows = await storage.query({
    sql: `SELECT 1 AS one FROM setup_token
          WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    params: [await hashToken(token), options.now],
  });
  return rows.length > 0;
}

export type ClaimResult =
  | { readonly ok: true; readonly personId: string }
  | { readonly ok: false; readonly reason: "expired" | "address_taken" };

const personIdSchema = z.object({ person_id: z.string() });

/**
 * Make the person who opened the setup link the instance's first owner: in ONE batch, the link
 * is used only if it is live, nobody is an operator yet and nobody has the address; then the
 * person is made, and made an operator, each only if the statement before it changed a row.
 * Two claims at once make one owner. An address someone already has is refused: claiming must
 * never sign anyone in as an account that exists.
 */
export async function claimInstance(
  storage: StoragePort,
  config: CapabilityConfig | undefined,
  input: {
    readonly token: string;
    readonly email: string;
    readonly name: string;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<ClaimResult> {
  if (config !== undefined && config.operators.length > 0) return { ok: false, reason: "expired" };
  const email = normalizeEmail(input.email);
  const name = handleSchema.parse(input.name);
  const personId = (input.newId ?? (() => uuidv7()))();
  await storage.batch([
    {
      sql: `UPDATE setup_token SET consumed_at = ?
            WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
              AND NOT EXISTS (SELECT 1 FROM instance_operator)
              AND NOT EXISTS (SELECT 1 FROM person WHERE email = ?)`,
      params: [input.now, await hashToken(input.token), input.now, email],
    },
    {
      sql: `INSERT INTO person (id, email, display_name, created_at)
            SELECT ?, ?, ?, ? WHERE changes() = 1`,
      params: [personId, email, name, input.now],
    },
    {
      sql: `INSERT INTO instance_operator (person_id, added_at, added_by)
            SELECT ?, ?, NULL WHERE changes() = 1`,
      params: [personId, input.now],
    },
  ]);
  const made = await storage.query({
    sql: "SELECT person_id FROM instance_operator WHERE person_id = ?",
    params: [personId],
  });
  if (made[0] !== undefined) return { ok: true, personId: personIdSchema.parse(made[0]).person_id };
  // Not claimed. Say it was the address only when the link would still have worked.
  const taken = await storage.query({
    sql: "SELECT 1 AS one FROM person WHERE email = ?",
    params: [email],
  });
  return taken.length > 0 &&
    (await setupLinkWorks(storage, config, input.token, { now: input.now }))
    ? { ok: false, reason: "address_taken" }
    : { ok: false, reason: "expired" };
}

export type ShellSignInResult =
  | { readonly ok: true; readonly token: string; readonly expiresAt: string }
  | { readonly ok: false; readonly reason: "no_account" };

/**
 * A sign-in link for an EXISTING account, made from a shell in the container (sign-in-link):
 * for someone who has lost every device, the operator included. It never makes an account —
 * the setup link and invites do that — and it is an ordinary login link, used once, in 15
 * minutes, recorded as `console`.
 */
export async function shellSignInLink(
  storage: StoragePort,
  rawEmail: string,
  options: { readonly now: string; readonly newId?: () => string },
): Promise<ShellSignInResult> {
  const email = normalizeEmail(rawEmail);
  const { token, hash } = await issueToken();
  const expiresAt = plusMs(options.now, LOGIN_TOKEN_TTL_MS);
  const rows = await storage.query({
    sql: `INSERT INTO login_token (id, token_hash, email, expires_at, created_at, via)
          SELECT ?, ?, ?, ?, ?, 'console'
          WHERE EXISTS (SELECT 1 FROM person WHERE email = ? AND erased_at IS NULL)
          RETURNING id`,
    params: [(options.newId ?? (() => uuidv7()))(), hash, email, expiresAt, options.now, email],
  });
  return rows.length === 0 ? { ok: false, reason: "no_account" } : { ok: true, token, expiresAt };
}
