// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import type { MailMessage, MailPort } from "../mail/port.js";
import { hashToken, issueToken } from "../people/tokens.js";
import { eraseAccount } from "./erasure.js";

// Opt-outs (DESIGN §10 *People who never signed up*, rc24). An address someone else gave us
// can stop that person's mail, a group's, or everyone's. Only a hash of the address is
// kept, so the opt-out list itself holds no addresses.
//
// One seam: every send passes `suppressingMailPort`, ahead of the cap. It drops mail an
// opt-out covers, without an error (so a dropped send costs none of the cap, and no page
// can tell an opted-out address from any other), and adds the opt-out link to the rest. A
// caller can't forget either. Mail the address asked for itself is never stopped.

export const OPT_OUT_PATH = "/opt-out";

/** How long the link in one email works. Every email has its own. */
export const OPT_OUT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type SuppressionScope =
  | { readonly kind: "all" }
  | { readonly kind: "group"; readonly id: string }
  | { readonly kind: "person"; readonly id: string };

/** The hash an opt-out is kept by: SHA-256 of the normalised address. */
export function addressHash(email: string): Promise<string> {
  return hashToken(email);
}

/** Whether an opt-out on this address covers mail from this sender, through this group. */
export async function isSuppressed(
  storage: StoragePort,
  email: string,
  from: { readonly senderId: string; readonly groupId: string | null },
): Promise<boolean> {
  const rows = await storage.query({
    sql: `SELECT 1 FROM mail_suppression
          WHERE address_hash = ?
            AND (scope = 'all'
              OR (scope = 'person' AND scope_id = ?)
              OR (scope = 'group' AND scope_id = ?))
          LIMIT 1`,
    params: [await addressHash(email), from.senderId, from.groupId ?? ""],
  });
  return rows.length > 0;
}

export interface SuppressingOptions {
  readonly publicBaseUrl: string;
  readonly now: () => string;
}

export function suppressingMailPort(
  inner: MailPort,
  storage: StoragePort,
  options: SuppressingOptions,
): MailPort {
  return {
    async send(message: MailMessage): Promise<void> {
      // Guests and former members carry `.invalid` addresses (RFC 6761): nothing goes there,
      // whoever asked (rc25, rc21). Here, so no caller can forget it.
      if (message.to.endsWith(".invalid")) return;
      const cause = message.cause;
      if (cause.kind === "self") return inner.send(message);
      if (await isSuppressed(storage, message.to, cause)) return;
      const now = options.now();
      const issued = await issueToken();
      await storage.batch([
        {
          sql: `INSERT INTO opt_out_token (token_hash, email, sender_id, group_id, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: [
            issued.hash,
            message.to,
            cause.senderId,
            cause.groupId,
            now,
            new Date(Date.parse(now) + OPT_OUT_TTL_MS).toISOString(),
          ],
        },
      ]);
      const link = new URL(OPT_OUT_PATH, options.publicBaseUrl);
      link.searchParams.set("t", issued.token);
      return inner.send({
        ...message,
        text: [
          message.text,
          "",
          "--",
          `You got this because ${cause.why}.`,
          `Don't want these? ${link.toString()}`,
        ].join("\n"),
      });
    },
  };
}

const tokenRowSchema = z.object({
  email: z.string(),
  sender_id: z.string().nullable(),
  group_id: z.string().nullable(),
  signed_in: z.number(),
});

export interface OptOutLink {
  readonly email: string;
  readonly senderId: string | null;
  readonly groupId: string | null;
  /** True if no person has this address, or theirs has never signed in. */
  readonly neverSignedIn: boolean;
}

/** What a live opt-out link is for; null if it's unknown or expired. Reads only. */
export async function peekOptOut(
  storage: StoragePort,
  token: string,
  now: string,
): Promise<OptOutLink | null> {
  const rows = await storage.query({
    sql: `SELECT t.email, t.sender_id, t.group_id,
                 EXISTS (SELECT 1 FROM person p
                         WHERE p.email = t.email AND p.signed_in_at IS NOT NULL) AS signed_in
          FROM opt_out_token t
          WHERE t.token_hash = ? AND t.expires_at > ?`,
    params: [await hashToken(token), now],
  });
  if (rows[0] === undefined) return null;
  const r = tokenRowSchema.parse(rows[0]);
  return {
    email: r.email,
    senderId: r.sender_id,
    groupId: r.group_id,
    neverSignedIn: r.signed_in === 0,
  };
}

/**
 * Opt the address out. From everyone, its opt-out links go too: there's nothing left for
 * them to do, and they hold the address.
 */
export async function suppress(
  storage: StoragePort,
  email: string,
  scope: SuppressionScope,
  now: string,
): Promise<void> {
  const id = scope.kind === "all" ? "" : scope.id;
  await storage.batch([
    {
      sql: `INSERT INTO mail_suppression (address_hash, scope, scope_id, created_at)
            VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      params: [await addressHash(email), scope.kind, id, now],
    },
    ...(scope.kind === "all"
      ? [{ sql: "DELETE FROM opt_out_token WHERE email = ?", params: [email] }]
      : []),
  ]);
}

/**
 * Delete everything about an address that has never signed in, at once (rc24): nobody
 * signed in to be warned, so there's no 7-day wait. It opts out from everyone first, or
 * the next invite would bring the address back. The person, if there is one, is erased as
 * an account is (tombstones, the ledger), which takes its invites and sign-in links with
 * it; with no person, those are deleted here. Refused — false, nothing written — once the
 * address has signed in: an account is deleted by signing in.
 */
export async function deleteEverything(
  storage: StoragePort,
  email: string,
  now: string,
): Promise<boolean> {
  const rows = await storage.query({
    sql: "SELECT id, signed_in_at FROM person WHERE email = ?",
    params: [email],
  });
  const person =
    rows[0] === undefined
      ? null
      : z.object({ id: z.string(), signed_in_at: z.string().nullable() }).parse(rows[0]);
  if (person !== null && person.signed_in_at !== null) return false;
  await suppress(storage, email, { kind: "all" }, now);
  if (person !== null) {
    await eraseAccount(storage, person.id, { now });
    return true;
  }
  await storage.batch([
    { sql: "DELETE FROM login_token WHERE email = ?", params: [email] },
    { sql: "DELETE FROM group_invite WHERE email = ?", params: [email] },
  ]);
  return true;
}

export interface OptOutView {
  readonly scope: "all" | "group" | "person";
  readonly scopeId: string;
  readonly createdAt: string;
  /** The group's name, for a group opt-out. A person is never named (see the account page). */
  readonly groupName: string | null;
}

const optOutRowSchema = z.object({
  scope: z.enum(["all", "group", "person"]),
  scope_id: z.string(),
  created_at: z.string(),
  group_name: z.string().nullable(),
});

/** The opt-outs on an address, for its own account page: everyone first. */
export async function optOutsOf(storage: StoragePort, email: string): Promise<OptOutView[]> {
  const rows = await storage.query({
    sql: `SELECT s.scope, s.scope_id, s.created_at, g.name AS group_name
          FROM mail_suppression s
          LEFT JOIN person_group g ON s.scope = 'group' AND g.id = s.scope_id
          WHERE s.address_hash = ?
          ORDER BY s.scope = 'all' DESC, s.created_at, s.scope_id`,
    params: [await addressHash(email)],
  });
  return rows.map((row) => {
    const r = optOutRowSchema.parse(row);
    return {
      scope: r.scope,
      scopeId: r.scope_id,
      createdAt: r.created_at,
      groupName: r.group_name,
    };
  });
}

/** Undo one opt-out on this address: only ever its own, since the caller passes its email. */
export async function undoOptOut(
  storage: StoragePort,
  email: string,
  scope: string,
  scopeId: string,
): Promise<void> {
  await storage.batch([
    {
      sql: "DELETE FROM mail_suppression WHERE address_hash = ? AND scope = ? AND scope_id = ?",
      params: [await addressHash(email), scope, scopeId],
    },
  ]);
}
