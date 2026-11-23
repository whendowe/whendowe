// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { diff } from "../changelog.js";
import { type StoragePort, stmt } from "../db/port.js";
import {
  createEvent,
  type EventFields,
  eventFieldsSchema,
  fieldEditStatements,
  findEventForParticipant,
  flatten,
} from "../events/event.js";
import { followsFor } from "./follow.js";
import type { OnEvent } from "./whats-on.js";

// Going (DESIGN §10 *Following calendars*, rc56/rc59): a followed event made an ordinary event
// of yours, just you, nobody asked, remembering where it came from. One per person per followed
// event, which a unique index holds. It follows its source until you change it (F3b): a fetch
// that changes the followed event changes yours the same way, while its revision is still the
// one the source last wrote (`followed_until`).

/** Where an event you went to came from: its calendar's id (a UUID, no "/") first. */
export const followedKey = (e: Pick<OnEvent, "calendarId" | "uid">) => `${e.calendarId}/${e.uid}`;

/** Your event from a followed event: its id, and whether you have since cancelled it. */
export interface Going {
  readonly eventId: string;
  readonly cancelled: boolean;
}

const goingRow = z.object({ id: z.string(), followed_from: z.string(), status: z.string() });

/** Your events from followed events, by where they came from. */
export async function goingAll(
  storage: StoragePort,
  personId: string,
): Promise<ReadonlyMap<string, Going>> {
  const rows = await storage.query(
    stmt(
      `SELECT id, followed_from, status FROM canonical_event
       WHERE owner_id = ? AND followed_from IS NOT NULL`,
      personId,
    ),
  );
  return new Map(
    rows.map((row) => {
      const r = goingRow.parse(row);
      return [r.followed_from, { eventId: r.id, cancelled: r.status === "cancelled" }];
    }),
  );
}

/** Your event from one followed event, if you went. */
export async function goingTo(
  storage: StoragePort,
  personId: string,
  e: Pick<OnEvent, "calendarId" | "uid">,
): Promise<Going | null> {
  const [row] = await storage.query(
    stmt(
      `SELECT id, followed_from, status FROM canonical_event
       WHERE owner_id = ? AND followed_from = ?`,
      personId,
      followedKey(e),
    ),
  );
  if (row === undefined) return null;
  const r = goingRow.parse(row);
  return { eventId: r.id, cancelled: r.status === "cancelled" };
}

/**
 * The fields an event of yours takes from a followed one: title, place, description and time
 * (rc59). A time with no zone is read as UTC, as What's on reads it (rc58). Null where they
 * can't be an event — a moment with no length, as an event ends after it starts. The place
 * and description fit as read (read.ts caps them at 300 and 4000); a title is cut to an
 * event's 200, and one a feed left empty is "An event".
 */
export function goingFields(
  e: Pick<
    OnEvent,
    "title" | "location" | "description" | "allDay" | "startLocal" | "endLocal" | "tzid"
  >,
): EventFields | null {
  const parsed = eventFieldsSchema.safeParse({
    title: e.title.trim().slice(0, 200) || "An event",
    location: e.location,
    description: e.description,
    allDay: e.allDay,
    startLocal: e.startLocal,
    endLocal: e.endLocal,
    tzid: e.allDay ? null : (e.tzid ?? "UTC"),
  });
  return parsed.success ? parsed.data : null;
}

export type GoResult =
  | { readonly kind: "made" | "already"; readonly eventId: string }
  | { readonly kind: "moment" };

/**
 * Go to a followed event: an event of yours made from it, or the one you made before. Two at
 * once make one: the second insert breaks the unique index, and finds the first.
 */
export async function go(
  storage: StoragePort,
  input: {
    readonly personId: string;
    readonly event: OnEvent;
    readonly now: string;
  },
): Promise<GoResult> {
  const before = await goingTo(storage, input.personId, input.event);
  // A tap after the first finds yours here, without an insert the index refuses. (Without
  // this, the catch below would find it too: the same answer, by a failed write.)
  if (before !== null) return { kind: "already", eventId: before.eventId };
  const fields = goingFields(input.event);
  if (fields === null) return { kind: "moment" };
  try {
    const made = await createEvent(storage, {
      creatorId: input.personId,
      group: null,
      fields,
      now: input.now,
      followedFrom: followedKey(input.event),
    });
    return { kind: "made", eventId: made.id };
  } catch (error) {
    const raced = await goingTo(storage, input.personId, input.event);
    if (raced === null) throw error;
    return { kind: "already", eventId: raced.eventId };
  }
}

/** The actor of a change a followed calendar made to an event you went to (rc59). */
export const calendarActor = (calendarId: string) => `calendar:${calendarId}`;

const followingRow = z.object({
  id: z.string(),
  owner_id: z.string(),
  revision: z.number(),
  followed_until: z.string().nullable(),
});

/**
 * A followed event changed in a fetch (F3b, rc59): each event gone to from it that its source
 * still has — whose revision is the one its source last wrote — changes the same way, by the
 * same optimistic edit as yours, logged as taken in from the calendar. An edit of yours landing
 * first wins, and the event is only yours from then on. A cancelled source changes nothing, nor
 * does a change that leaves nothing an event could be. Returns how many it changed.
 */
export async function followSource(
  storage: StoragePort,
  input: {
    readonly calendarId: string;
    readonly source: Parameters<typeof goingFields>[0] & {
      readonly uid: string;
      readonly status: string;
    };
    readonly now: string;
  },
): Promise<number> {
  if (input.source.status !== "confirmed") return 0;
  const fields = goingFields(input.source);
  if (fields === null) return 0;
  const rows = await storage.query(
    stmt(
      `SELECT id, owner_id, revision, followed_until FROM canonical_event
       WHERE followed_from = ? ORDER BY id`,
      followedKey({ calendarId: input.calendarId, uid: input.source.uid }),
    ),
  );
  let moved = 0;
  for (const row of rows) {
    const r = followingRow.parse(row);
    if (r.followed_until !== String(r.revision)) continue;
    const access = await findEventForParticipant(storage, r.id, r.owner_id);
    if (access === null) continue;
    const change = diff(flatten(access.event), flatten(fields));
    if (Object.keys(change).length === 0) continue;
    try {
      await storage.batch(
        fieldEditStatements({
          eventId: r.id,
          expected: r.revision,
          fields,
          change,
          actorId: calendarActor(input.calendarId),
          now: input.now,
          source: "inbound_sync",
          afterLog: [
            stmt(
              "UPDATE canonical_event SET followed_until = ? WHERE id = ? AND changes() = 1",
              String(r.revision + 1),
              r.id,
            ),
          ],
        }),
      );
    } catch {
      continue; // UNIQUE(event, revision): an edit of yours landed first, and it is yours now
    }
    // An edit of yours that landed since the read leaves the UPDATE matching nothing, and so
    // nothing written after it: who wrote the next revision says whose it was.
    const [written] = await storage.query(
      stmt(
        "SELECT actor FROM change_log WHERE canonical_event_id = ? AND revision = ?",
        r.id,
        r.revision + 1,
      ),
    );
    if (written?.actor === calendarActor(input.calendarId)) moved++;
  }
  return moved;
}

/**
 * The calendar that cancelled an event `personId` went to (rc59), by the name they follow it
 * under: only while they follow it and the source is there, cancelled. Null otherwise —
 * an event not gone to, a calendar no longer followed, or a source that simply dropped out of
 * the feed, which may only have ended.
 */
export async function cancelledBy(
  storage: StoragePort,
  personId: string,
  eventId: string,
): Promise<string | null> {
  const [row] = await storage.query(
    stmt(
      `SELECT e.followed_from, s.calendar_id, s.status FROM canonical_event e
       JOIN followed_event s ON e.followed_from = s.calendar_id || '/' || s.uid
       WHERE e.id = ?`,
      eventId,
    ),
  );
  if (row === undefined) return null;
  const r = z.object({ calendar_id: z.string(), status: z.string() }).parse(row);
  if (r.status !== "cancelled") return null;
  return calendarNameFor(storage, personId, r.calendar_id);
}

/** A calendar's name for the history (rc59): as `personId` follows it, or null if they don't. */
export async function calendarNameFor(
  storage: StoragePort,
  personId: string,
  calendarId: string,
): Promise<string | null> {
  const follow = (await followsFor(storage, personId)).find((f) => f.calendarId === calendarId);
  return follow === undefined ? null : (follow.name ?? new URL(follow.url).hostname);
}
