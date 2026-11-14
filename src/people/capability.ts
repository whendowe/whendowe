// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { findOrCreatePerson, normalizeEmail } from "./person.js";

// Capabilities (DESIGN §10 rc43): an instance may give some features to some accounts only.
// A capability gates starting to use something, never taking part: answering, receipts and
// asking everyone to agree are open to all. Losing one stops new use and deletes nothing.
// Why an instance limits anything is its own business (§18), never this code's.

export const capabilitySchema = z.enum(["verify", "calendar_sync", "long_history"]);
export type Capability = z.infer<typeof capabilitySchema>;
export const CAPABILITIES: readonly Capability[] = capabilitySchema.options;

/** The instance's settings, from its configuration (config.ts capabilityConfigOf). */
export interface CapabilityConfig {
  /** `all`: everyone has every capability. `granted`: only accounts an operator granted. */
  readonly default: "all" | "granted";
  /** Operators, by normalised address. None: there is no operator page. */
  readonly operators: readonly string[];
}

/** Absent configuration means everything for everyone: a self-hosted instance meets no gate. */
export const EVERYTHING: CapabilityConfig = { default: "all", operators: [] };

export async function hasCapability(
  storage: StoragePort,
  config: CapabilityConfig,
  personId: string,
  capability: Capability,
): Promise<boolean> {
  if (config.default === "all") return true;
  const rows = await storage.query({
    sql: "SELECT 1 AS ok FROM account_capability WHERE person_id = ? AND capability = ?",
    params: [personId, capability],
  });
  return rows.length > 0;
}

/** Whether this address is one of the instance's operators. */
export function isOperator(config: CapabilityConfig, email: string): boolean {
  return config.operators.includes(normalizeEmail(email));
}

export interface Grant {
  readonly personId: string;
  readonly email: string;
  readonly capabilities: readonly Capability[];
}

/** Every account holding a capability, by address; for the operator page only. */
export async function listGrants(storage: StoragePort): Promise<Grant[]> {
  const rows = (
    await storage.query({
      sql: `SELECT c.person_id, p.email, c.capability FROM account_capability c
            JOIN person p ON p.id = c.person_id ORDER BY p.email, c.capability`,
      params: [],
    })
  ).map((r) =>
    z.object({ person_id: z.string(), email: z.string(), capability: capabilitySchema }).parse(r),
  );
  const out: Grant[] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last?.personId === r.person_id)
      out[out.length - 1] = { ...last, capabilities: [...last.capabilities, r.capability] };
    else out.push({ personId: r.person_id, email: r.email, capabilities: [r.capability] });
  }
  return out;
}

export interface CapabilityChange {
  readonly email: string | null;
  readonly capability: Capability;
  readonly action: "granted" | "revoked";
  readonly actorEmail: string | null;
  readonly at: string;
}

/** The log of grants and revokes, newest first. */
export async function listCapabilityChanges(
  storage: StoragePort,
  limit = 100,
): Promise<CapabilityChange[]> {
  return (
    await storage.query({
      sql: `SELECT p.email, c.capability, c.action, a.email AS actor_email, c.created_at
            FROM capability_change c
              LEFT JOIN person p ON p.id = c.person_id
              LEFT JOIN person a ON a.id = c.actor_id
            ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
      params: [limit],
    })
  ).map((r) => {
    const x = z
      .object({
        email: z.string().nullable(),
        capability: capabilitySchema,
        action: z.enum(["granted", "revoked"]),
        actor_email: z.string().nullable(),
        created_at: z.string(),
      })
      .parse(r);
    return {
      email: x.email,
      capability: x.capability,
      action: x.action,
      actorEmail: x.actor_email,
      at: x.created_at,
    };
  });
}

/**
 * Grant a capability to an address, creating the person if there is none yet, as an invite
 * does — so a capability can be lined up before the first sign-in. Logged; granting what is
 * already held changes nothing and logs nothing.
 */
export async function grantCapability(
  storage: StoragePort,
  input: {
    readonly email: string;
    readonly capability: Capability;
    readonly actorId: string;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<"granted" | "already"> {
  const person = await findOrCreatePerson(storage, input.email, { now: input.now });
  const done = await storage.query({
    sql: `INSERT INTO account_capability (person_id, capability, granted_at, granted_by)
          VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING person_id`,
    params: [person.id, input.capability, input.now, input.actorId],
  });
  if (done.length === 0) return "already";
  await storage.batch([
    {
      sql: `INSERT INTO capability_change (id, person_id, capability, action, actor_id, created_at)
            VALUES (?, ?, ?, 'granted', ?, ?)`,
      params: [
        (input.newId ?? (() => uuidv7()))(),
        person.id,
        input.capability,
        input.actorId,
        input.now,
      ],
    },
  ]);
  return "granted";
}

/** Revoke one. Nothing it gated is deleted (rc43). Logged; revoking what isn't held is a no-op. */
export async function revokeCapability(
  storage: StoragePort,
  input: {
    readonly personId: string;
    readonly capability: Capability;
    readonly actorId: string;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<"revoked" | "absent"> {
  const done = await storage.query({
    sql: "DELETE FROM account_capability WHERE person_id = ? AND capability = ? RETURNING person_id",
    params: [input.personId, input.capability],
  });
  if (done.length === 0) return "absent";
  await storage.batch([
    {
      sql: `INSERT INTO capability_change (id, person_id, capability, action, actor_id, created_at)
            VALUES (?, ?, ?, 'revoked', ?, ?)`,
      params: [
        (input.newId ?? (() => uuidv7()))(),
        input.personId,
        input.capability,
        input.actorId,
        input.now,
      ],
    },
  ]);
  return "revoked";
}
