// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { type StoragePort, stmt } from "../db/port.js";
import { shownEmailSql } from "../events/participation.js";
import { type Shown, shownAs, shownRowSchema } from "./person.js";

// Who you already know (DESIGN §10 *Asking when*, the people picker, rc48): everyone you share
// a group, an event or a thread with now. They are suggested where you name people, each shown
// as they are shown in the place you most recently shared — a handle, and an address only where
// they show it there (rc21). An event counts only where you see who takes part (FULL): what you
// may not see on its page, the picker doesn't show either. Guests and former members have no
// address to send to, so they are never suggested.
//
// Choosing a suggestion puts a person id in a form, never an address. When the form is sent,
// knownAddresses checks again that you still share somewhere with them, so no other id works.

export type PlaceKind = "group" | "event" | "thread";

export interface Place {
  readonly kind: PlaceKind;
  readonly id: string;
  readonly name: string;
}

export interface KnownPerson {
  readonly personId: string;
  /** As they are shown in the place you most recently shared. */
  readonly shown: Shown;
  /** Every place you share, most recent first. */
  readonly places: readonly Place[];
}

const rowSchema = shownRowSchema.extend({
  kind: z.enum(["group", "event", "thread"]),
  place_id: z.string(),
  place_name: z.string(),
  person_id: z.string(),
  at: z.string(),
});

// Someone with an address to send to: not a guest, not a former member's tombstone (rc21).
const SENDABLE = "p.guest_at IS NULL AND p.email NOT LIKE '%.invalid'";

const IN_GROUPS = `SELECT 'group' AS kind, g.id AS place_id, g.name AS place_name, o.person_id,
    p.email, p.display_name, o.handle, o.show_email, MAX(o.joined_at, mine.joined_at) AS at
  FROM group_member mine
  JOIN person_group g ON g.id = mine.group_id
  JOIN group_member o ON o.group_id = mine.group_id AND o.person_id <> mine.person_id
  JOIN person p ON p.id = o.person_id
  WHERE mine.person_id = ? AND ${SENDABLE}`;

const IN_EVENTS = `SELECT 'event' AS kind, e.id AS place_id, e.title AS place_name, o.person_id,
    p.email, p.display_name, o.handle, ${shownEmailSql("o")} AS show_email,
    MAX(o.created_at, mine.created_at) AS at
  FROM event_participation mine
  JOIN canonical_event e ON e.id = mine.canonical_event_id
  JOIN event_participation o ON o.canonical_event_id = mine.canonical_event_id
    AND o.person_id <> mine.person_id
  JOIN person p ON p.id = o.person_id
  WHERE mine.person_id = ? AND mine.visibility = 'FULL' AND o.visibility <> 'HIDDEN' AND ${SENDABLE}`;

const IN_THREADS = `SELECT 'thread' AS kind, t.id AS place_id, t.name AS place_name, o.person_id,
    p.email, p.display_name, o.handle,
    CASE WHEN t.verified_at IS NULL THEN o.show_email ELSE 1 END AS show_email,
    MAX(o.created_at, mine.created_at) AS at
  FROM plan_thread_member mine
  JOIN plan_thread t ON t.id = mine.thread_id
  JOIN plan_thread_member o ON o.thread_id = mine.thread_id AND o.person_id <> mine.person_id
  JOIN person p ON p.id = o.person_id
  WHERE mine.person_id = ? AND ${SENDABLE}`;

type Row = z.infer<typeof rowSchema>;

async function sharedRows(storage: StoragePort, me: string): Promise<Row[]> {
  const sets = await Promise.all(
    [IN_GROUPS, IN_EVENTS, IN_THREADS].map((sql) => storage.query(stmt(sql, me))),
  );
  return sets.flat().map((r) => rowSchema.parse(r));
}

/** Everyone you share a group, event or thread with now: one each, most recent first. */
export async function listKnownPeople(storage: StoragePort, me: string): Promise<KnownPerson[]> {
  const rows = (await sharedRows(storage, me)).sort(
    (a, b) =>
      b.at.localeCompare(a.at) ||
      a.kind.localeCompare(b.kind) ||
      a.place_id.localeCompare(b.place_id),
  );
  // Rows come newest first, so a person's first row is the place you most recently shared;
  // each place holds a person once (its primary key), so no place repeats.
  const byPerson = new Map<string, KnownPerson & { places: Place[] }>();
  for (const r of rows) {
    const place: Place = { kind: r.kind, id: r.place_id, name: r.place_name };
    const known = byPerson.get(r.person_id);
    if (known === undefined)
      byPerson.set(r.person_id, {
        personId: r.person_id,
        shown: shownAs(r.person_id, r, r.place_id),
        places: [place],
      });
    else known.places.push(place);
  }
  return [...byPerson.values()];
}

/**
 * The addresses to send to, for ids chosen from the suggestions — only of people you still
 * share somewhere with. An id missing from the result is not someone you know: refuse it.
 * The addresses are for mail alone; they are never drawn on a page.
 */
export async function knownAddresses(
  storage: StoragePort,
  me: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const wanted = new Set(ids);
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;
  for (const r of await sharedRows(storage, me))
    if (wanted.has(r.person_id)) out.set(r.person_id, r.email);
  return out;
}
