// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { type StoragePort, stmt } from "../db/port.js";
import { createEvent, type EventFields, eventFieldsSchema } from "../events/event.js";
import type { OnEvent } from "./whats-on.js";

// Going (DESIGN §10 *Following calendars*, rc56/rc59): a followed event made an ordinary event
// of yours, just you, nobody asked, remembering where it came from. One per person per followed
// event, which a unique index holds. Following its source until you change it is slice F3b.

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
export function goingFields(e: OnEvent): EventFields | null {
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
