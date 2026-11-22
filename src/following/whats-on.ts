// SPDX-License-Identifier: AGPL-3.0-or-later
import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { stmt } from "../db/port.js";
import { type Busy, ownBusy } from "../feeds/busy.js";
import { type FollowColour, followsFor } from "./follow.js";

// What's on when you're free (DESIGN §10 rc58): the next two weeks of what the calendars you
// and your groups follow hold, at whatever time it is, each event once. What overlaps anything
// of yours is marked, and the page leaves it out unless clashes are shown. An overlap is
// between instants, so no zone is kept: a followed event's times are its calendar's wall clock
// in its own zone, and yours are asked for in UTC. An all-day event is days: it clashes with a
// whole day of yours and nothing shorter, and a timed one with a whole day of yours on its own
// date. A time a feed gives with no zone is read as UTC.

/** How far ahead the page looks (rc58: the next two weeks). */
export const WHATS_ON_DAYS = 14;

/** A followed event as someone who follows its calendar sees it. */
export interface OnEvent {
  readonly calendarId: string;
  readonly uid: string;
  readonly title: string;
  readonly location: string | null;
  readonly description: string | null;
  readonly url: string | null;
  /** Its calendar's wall clock, in `tzid`; an all-day one's midnight, its end the day after. */
  readonly startLocal: string;
  readonly endLocal: string;
  readonly tzid: string | null;
  readonly allDay: boolean;
  /** Timed: the instants it runs between. All-day: null. */
  readonly startUtc: string | null;
  readonly endUtc: string | null;
  /** What its calendar is called here, and its colour: your own follow's first. */
  readonly calendarName: string;
  readonly calendarUrl: string;
  readonly colour: FollowColour;
  /** It overlaps something of yours. */
  readonly clashes: boolean;
}

const rowSchema = z.object({
  calendar_id: z.string(),
  uid: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  start_local: z.string(),
  end_local: z.string(),
  tzid: z.string().nullable(),
  all_day: z.number(),
});

/** The instant a wall-clock time in `zone` is (no zone: UTC). */
function instant(local: string, zone: string | null): Temporal.Instant {
  // A time a zone skips or repeats is read as Temporal's "compatible" default reads it.
  return Temporal.PlainDateTime.from(local)
    .toZonedDateTime(zone ?? "UTC")
    .toInstant();
}

/** Dates `[from, to]` (both included) and `[a, b]` share a day. */
const daysMeet = (from: string, to: string, a: string, b: string) => from <= b && a <= to;

/**
 * Whether an event overlaps any of `busy` — times as UTC wall clock to the minute, days as
 * dates. Touching ends don't overlap: something until 19:00 leaves a 19:00 class free.
 */
export function clashes(
  e: Pick<OnEvent, "allDay" | "startLocal" | "endLocal" | "startUtc" | "endUtc">,
  busy: readonly Busy[],
): boolean {
  if (e.allDay || e.startUtc === null || e.endUtc === null) {
    const first = e.startLocal.slice(0, 10);
    // The end is the midnight after its last day; a day with no length is still its day.
    const end = Temporal.PlainDate.from(e.endLocal).subtract({ days: 1 }).toString();
    const last = end < first ? first : end;
    return busy.some((b) => b.allDay && daysMeet(b.from, b.to, first, last));
  }
  const start = Temporal.Instant.from(e.startUtc);
  const end = Temporal.Instant.from(e.endUtc);
  const date = e.startLocal.slice(0, 10);
  return busy.some((b) => {
    if (b.allDay) return daysMeet(b.from, b.to, date, date);
    const bs = Temporal.Instant.from(`${b.start}Z`);
    const be = Temporal.Instant.from(`${b.end}Z`);
    // A moment with no length clashes with what is going on at that moment.
    if (Temporal.Instant.compare(start, end) === 0)
      return Temporal.Instant.compare(bs, start) <= 0 && Temporal.Instant.compare(start, be) < 0;
    return Temporal.Instant.compare(bs, end) < 0 && Temporal.Instant.compare(start, be) < 0;
  });
}

interface Calendar {
  readonly name: string;
  readonly url: string;
  readonly colour: FollowColour;
}

/** Each calendar `personId` sees, once: their own follow's name and colour before a group's. */
async function calendarsOf(storage: StoragePort, personId: string): Promise<Map<string, Calendar>> {
  const calendars = new Map<string, Calendar>();
  for (const f of await followsFor(storage, personId)) {
    if (calendars.has(f.calendarId)) continue;
    calendars.set(f.calendarId, {
      name: f.name ?? new URL(f.url).hostname,
      url: f.url,
      colour: f.colour,
    });
  }
  return calendars;
}

function onEvent(r: z.infer<typeof rowSchema>, c: Calendar, busy: readonly Busy[]): OnEvent {
  const allDay = r.all_day === 1;
  const timed = allDay
    ? { startUtc: null, endUtc: null }
    : {
        startUtc: instant(r.start_local, r.tzid).toString(),
        endUtc: instant(r.end_local, r.tzid).toString(),
      };
  const e = {
    calendarId: r.calendar_id,
    uid: r.uid,
    title: r.title,
    location: r.location,
    description: r.description,
    url: r.url,
    startLocal: r.start_local,
    endLocal: r.end_local,
    tzid: r.tzid,
    allDay,
    ...timed,
    calendarName: c.name,
    calendarUrl: c.url,
    colour: c.colour,
  };
  return { ...e, clashes: clashes(e, busy) };
}

/** Your busy times over the days around `now` that the page can reach, in UTC. */
async function busyAround(storage: StoragePort, personId: string, now: string): Promise<Busy[]> {
  const today = Temporal.Instant.from(now).toZonedDateTimeISO("UTC").toPlainDate();
  return ownBusy(
    storage,
    personId,
    {
      // A day either side: an event's own date may be a day off UTC's.
      from: today.subtract({ days: 1 }).toString(),
      to: today.add({ days: WHATS_ON_DAYS + 1 }).toString(),
      tz: "UTC",
    },
    now,
  );
}

const EVENT_COLUMNS = `e.calendar_id, e.uid, e.title, e.location, e.description, e.url,
       e.start_local, e.end_local, e.tzid, e.all_day`;

/** The calendars `personId` follows, themselves or through a group they're in. */
const FOLLOWED = `SELECT f.calendar_id FROM calendar_follow f
       LEFT JOIN group_member m ON m.group_id = f.group_id AND m.person_id = ?
       WHERE f.person_id = ? OR m.person_id IS NOT NULL`;

/**
 * What's on from `now` for WHATS_ON_DAYS, from what `personId` follows, by start; each event
 * once; cancelled ones left out. Reads only.
 */
export async function whatsOn(
  storage: StoragePort,
  personId: string,
  now: string,
): Promise<OnEvent[]> {
  const from = Temporal.Instant.from(now);
  const until = from.add({ hours: 24 * WHATS_ON_DAYS });
  // Wall clocks differ by at most a day across zones, so a day's margin each way finds every
  // candidate by its stored text; each is then checked by its own instants.
  const utc = (i: Temporal.Instant) => i.toZonedDateTimeISO("UTC").toPlainDate();
  const [calendars, busy, rows] = await Promise.all([
    calendarsOf(storage, personId),
    busyAround(storage, personId, now),
    storage.query(
      stmt(
        `SELECT ${EVENT_COLUMNS} FROM followed_event e
         WHERE e.calendar_id IN (${FOLLOWED})
           AND e.status = 'confirmed'
           AND e.start_local < ? AND e.end_local >= ?
         ORDER BY e.start_local, e.calendar_id, e.uid`,
        personId,
        personId,
        utc(until).add({ days: 2 }).toString(),
        utc(from).subtract({ days: 1 }).toString(),
      ),
    ),
  ]);
  const today = from.toZonedDateTimeISO("UTC").toPlainDate();
  const lastDay = until.toZonedDateTimeISO("UTC").toPlainDate();
  const events: OnEvent[] = [];
  for (const row of rows) {
    const r = rowSchema.parse(row);
    const calendar = calendars.get(r.calendar_id);
    if (calendar === undefined) continue;
    const e = onEvent(r, calendar, busy);
    if (e.startUtc !== null && e.endUtc !== null) {
      const s = Temporal.Instant.from(e.startUtc);
      const end = Temporal.Instant.from(e.endUtc);
      if (Temporal.Instant.compare(s, until) >= 0) continue;
      // Over already; one with no length is on until the moment it starts.
      if (Temporal.Instant.compare(end, from) <= 0 && Temporal.Instant.compare(s, from) < 0)
        continue;
    } else {
      // Days: over once its last day is past, and not yet if it starts after the last one.
      const ends = Temporal.PlainDate.from(e.endLocal);
      const starts = Temporal.PlainDate.from(e.startLocal);
      if (Temporal.PlainDate.compare(ends, today) <= 0) continue;
      if (Temporal.PlainDate.compare(starts, lastDay) > 0) continue;
    }
    events.push(e);
  }
  return events.sort((a, b) => order(a).localeCompare(order(b)));
}

/** By its own day; within a day, all-day first, then by the moment it starts. */
const order = (e: OnEvent) =>
  `${e.startLocal.slice(0, 10)}${e.allDay ? "0" : `1${e.startUtc ?? ""}`}${e.calendarId}${e.uid}`;

/**
 * One followed event, for its sheet: only to someone who follows its calendar, themselves or
 * through a group; otherwise null. A cancelled one is still found, and says so on its sheet.
 */
export async function followedEvent(
  storage: StoragePort,
  personId: string,
  calendarId: string,
  uid: string,
  now: string,
): Promise<(OnEvent & { readonly cancelled: boolean }) | null> {
  const calendars = await calendarsOf(storage, personId);
  const calendar = calendars.get(calendarId);
  if (calendar === undefined) return null;
  const [row] = await storage.query(
    stmt(
      `SELECT ${EVENT_COLUMNS}, e.status FROM followed_event e
       WHERE e.calendar_id = ? AND e.uid = ?`,
      calendarId,
      uid,
    ),
  );
  if (row === undefined) return null;
  const r = rowSchema.extend({ status: z.enum(["confirmed", "cancelled"]) }).parse(row);
  const busy = await busyAround(storage, personId, now);
  return { ...onEvent(r, calendar, busy), cancelled: r.status === "cancelled" };
}
