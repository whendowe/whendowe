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
  // `.invalid` can never be a real address (RFC 6761), and it is what tombstones of erased
  // people carry (§10 rc21): refusing it here means nobody can sign in as, invite or add one.
  if (!emailSchema.safeParse(email).success || email.endsWith(".invalid")) {
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

// --- How a person appears to others (DESIGN §10 rc21 *Privacy basics*) -----------------
//
// Others see a HANDLE, never an address, unless the person turned on "show my email" in
// that one group, event or thread (§16: never show an address to anyone but its owner
// otherwise). Queries return Shown, not raw addresses, so a view can't leak what it was
// never given.

/** A person as others see them in one container: a name, and an address only if shown. */
export interface Shown {
  readonly name: string;
  readonly email: string | null;
}

/** The columns every "who" query reads alongside a person: theirs, and their row here. */
export const shownRowSchema = z.object({
  email: z.string(),
  display_name: z.string().nullable(),
  /** NULL for someone with no row in this container (a removed participant in history). */
  handle: z.string().nullable(),
  show_email: z.number().nullable(),
});

export type ShownRow = z.infer<typeof shownRowSchema>;

/** The container's handle, else the account's, else a guest name; the address only if shown. */
export function shownAs(personId: string, row: ShownRow, containerId: string): Shown {
  const name = row.handle ?? row.display_name ?? guestName(containerId, personId);
  return { name, email: row.show_email === 1 ? row.email : null };
}

/**
 * "Guest 4821": someone with no handle yet, who has never signed in. Stable for one person
 * in one container, and different in another, so it can't follow them between the two.
 * FNV-1a is enough: this is a label, not a secret, and nothing of the address goes in.
 */
export function guestName(containerId: string, personId: string): string {
  let h = 0x811c9dc5;
  for (const ch of `${containerId}:${personId}`) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `Guest ${1000 + (h % 9000)}`;
}

/** A handle: what others see. Trimmed, 1–40 characters, no control characters. */
export const handleSchema = z
  .string()
  .trim()
  .min(1, "Choose a name.")
  .max(40, "Keep it under 40 characters.")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "Use letters, numbers and spaces.");

/** Set the account's handle: the default name in every container (§10 rc21). */
export async function setAccountHandle(
  storage: StoragePort,
  personId: string,
  handle: string,
): Promise<void> {
  await storage.batch([
    {
      sql: "UPDATE person SET display_name = ? WHERE id = ?",
      params: [handleSchema.parse(handle), personId],
    },
  ]);
}

/** Where someone appears: a group, an event or a plan thread (§10 rc21). */
export interface Container {
  readonly kind: "group" | "event" | "thread";
  readonly id: string;
}

// One fixed statement per kind: the table is chosen by a switch over constants, never
// by building SQL from input (§13).
const APPEARANCE_UPDATE: Readonly<Record<Container["kind"], string>> = {
  group:
    "UPDATE group_member SET handle = ?, show_email = ? WHERE group_id = ? AND person_id = ? RETURNING person_id",
  event:
    "UPDATE event_participation SET handle = ?, show_email = ? WHERE canonical_event_id = ? AND person_id = ? RETURNING person_id",
  thread:
    "UPDATE plan_thread_member SET handle = ?, show_email = ? WHERE thread_id = ? AND person_id = ? RETURNING person_id",
};

const APPEARANCE_READ: Readonly<Record<Container["kind"], string>> = {
  group: `SELECT p.email, p.display_name, x.handle, x.show_email
          FROM group_member x JOIN person p ON p.id = x.person_id
          WHERE x.group_id = ? AND x.person_id = ?`,
  event: `SELECT p.email, p.display_name, x.handle, x.show_email
          FROM event_participation x JOIN person p ON p.id = x.person_id
          WHERE x.canonical_event_id = ? AND x.person_id = ?`,
  thread: `SELECT p.email, p.display_name, x.handle, x.show_email
           FROM plan_thread_member x JOIN person p ON p.id = x.person_id
           WHERE x.thread_id = ? AND x.person_id = ?`,
};

export interface Appearance {
  /** This container's own handle; null means the account's. */
  readonly handle: string | null;
  readonly accountHandle: string | null;
  readonly showEmail: boolean;
  /** As the others see them. */
  readonly shown: Shown;
}

/** How a member appears in a container, for their own settings form and for mail they cause. */
export async function appearanceIn(
  storage: StoragePort,
  container: Container,
  personId: string,
): Promise<Appearance | null> {
  const rows = await storage.query({
    sql: APPEARANCE_READ[container.kind],
    params: [container.id, personId],
  });
  if (rows[0] === undefined) return null;
  const r = shownRowSchema.parse(rows[0]);
  return {
    handle: r.handle,
    accountHandle: r.display_name,
    showEmail: r.show_email === 1,
    shown: shownAs(personId, r, container.id),
  };
}

/**
 * Set how a member appears in one container. An empty handle means "use my account's".
 * Returns false when they are not a member of it (the caller has already checked access;
 * this is the backstop).
 */
export async function setAppearance(
  storage: StoragePort,
  container: Container,
  personId: string,
  input: { readonly handle: string; readonly showEmail: boolean },
): Promise<boolean> {
  const handle = input.handle.trim() === "" ? null : handleSchema.parse(input.handle);
  const rows = await storage.query({
    sql: APPEARANCE_UPDATE[container.kind],
    params: [handle, input.showEmail ? 1 : 0, container.id, personId],
  });
  return rows.length > 0;
}
