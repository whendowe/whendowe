// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";

// People (DESIGN §10 rc7). One person per verified email address: the identity key
// shared by every login method, so a later "Sign in with Google" (MVP-4) with the same
// address lands on the same person.

export interface Person {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly createdAt: string;
}

const emailSchema = z.email();

/**
 * Trimmed and lowercased. Strictly, the local part of an address is case-sensitive
 * (RFC 5321), but no mainstream provider treats it so, and treating "Ann@x.org" and
 * "ann@x.org" as two people would split one human into two accounts. Lowercasing is
 * the practical choice and is applied at every boundary that takes an address.
 */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) {
    throw new Error("not a valid email address");
  }
  return email;
}

const personRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  created_at: z.string(),
});

function toPerson(row: unknown): Person {
  const r = personRowSchema.parse(row);
  return { id: r.id, email: r.email, displayName: r.display_name, createdAt: r.created_at };
}

export async function findPersonById(storage: StoragePort, id: string): Promise<Person | null> {
  const rows = await storage.query({
    sql: "SELECT id, email, display_name, created_at FROM person WHERE id = ?",
    params: [id],
  });
  return rows[0] === undefined ? null : toPerson(rows[0]);
}

export async function findPersonByEmail(
  storage: StoragePort,
  email: string,
): Promise<Person | null> {
  const rows = await storage.query({
    sql: "SELECT id, email, display_name, created_at FROM person WHERE email = ?",
    params: [normalizeEmail(email)],
  });
  return rows[0] === undefined ? null : toPerson(rows[0]);
}

/**
 * The person for a verified address, created on first sight.
 *
 * INSERT … ON CONFLICT DO NOTHING then SELECT: two first logins racing for the same
 * new address both insert-or-skip against UNIQUE(email) and both read the single
 * row that won. A select-then-insert would let both see "absent" and one would fail.
 * Called after an address is proven (a consumed magic link), or when an event's editor
 * adds an address to it (DESIGN rc15, §2: a person exists with zero connections). Never
 * on a sign-in REQUEST: asking for a link creates no one.
 */
export async function findOrCreatePerson(
  storage: StoragePort,
  rawEmail: string,
  options: { readonly now: string; readonly newId?: () => string },
): Promise<Person> {
  const email = normalizeEmail(rawEmail);
  await storage.batch([
    {
      sql: `INSERT INTO person (id, email, created_at) VALUES (?, ?, ?)
            ON CONFLICT(email) DO NOTHING`,
      params: [(options.newId ?? (() => uuidv7()))(), email, options.now],
    },
  ]);
  const person = await findPersonByEmail(storage, email);
  if (person === null) {
    throw new Error("person vanished between insert and read");
  }
  return person;
}
