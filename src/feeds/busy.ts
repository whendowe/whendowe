// SPDX-License-Identifier: AGPL-3.0-or-later
import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { isTimeZone } from "../events/event.js";
import { MAX_OCCURRENCES, upcomingOccurrences } from "../recurrence.js";
import { feedEntries } from "./feed.js";

// Busy times while you pick (DESIGN §10 rc41): when the person choosing a time is
// already committed. Here, the agreed events their feed holds (rc34) — one rule, so
// the picker and the feed never disagree. Times only: the picker shades, it doesn't
// describe, so no title, place or link leaves this module.

/** The widest range one request may ask for; a month in whole weeks is at most 42 days. */
export const MAX_BUSY_DAYS = 62;

/** Days, the last one included; or a wall-clock span in the asker's zone, to the minute. */
export type Busy =
  | { readonly allDay: true; readonly from: string; readonly to: string }
  | { readonly allDay: false; readonly start: string; readonly end: string };

const isoDate = z.string().refine((s) => {
  try {
    return Temporal.PlainDate.from(s, { overflow: "reject" }).toString() === s;
  } catch {
    return false;
  }
}, "a date");

export const busyQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    tz: z.string().max(64).refine(isTimeZone, "a time zone"),
    /** An event being edited: its own time isn't something you're busy with. */
    except: z.string().max(64).optional(),
  })
  .refine((q) => {
    // zod runs this even when a field above failed, so a bad date must not throw here.
    try {
      const days = Temporal.PlainDate.from(q.from).until(q.to).days;
      return days >= 0 && days < MAX_BUSY_DAYS;
    } catch {
      return false;
    }
  }, "a range of up to MAX_BUSY_DAYS days");

export type BusyQuery = z.infer<typeof busyQuerySchema>;

const minute = (t: Temporal.PlainDateTime) => t.toString({ smallestUnit: "minute" });

/** What `personId` is busy with from `from` to `to` (dates, both included), in `tz`. */
export async function ownBusy(
  storage: StoragePort,
  personId: string,
  query: BusyQuery,
  now: string,
): Promise<Busy[]> {
  const first = Temporal.PlainDate.from(query.from);
  const afterLast = Temporal.PlainDate.from(query.to).add({ days: 1 });
  const rangeStart = first.toZonedDateTime(query.tz).toInstant();
  const rangeEnd = afterLast.toZonedDateTime(query.tz).toInstant();
  const entries = await feedEntries(
    storage,
    { personId, groupId: null },
    { now, eventUrl: () => "" },
  );
  const busy: Busy[] = [];
  for (const e of entries) {
    if (e.status !== "scheduled" || e.id === query.except) continue;
    const series = { ...e, exdates: [] };
    if (e.allDay) {
      // A floating date: the same days wherever you are.
      const occurrences = upcomingOccurrences(series, `${query.from}T00:00`, MAX_OCCURRENCES);
      for (const o of occurrences) {
        const from = o.startLocal.slice(0, 10);
        if (from >= afterLast.toString()) break;
        const to = Temporal.PlainDate.from(o.endLocal.slice(0, 10)).subtract({ days: 1 });
        busy.push({ allDay: true, from, to: to.toString() });
      }
    } else {
      // Timed events always carry a zone (createEvent refuses one without); the asker's is
      // only a fallback for a row that somehow has none.
      const zone = e.tzid ?? query.tz;
      const fromLocal = rangeStart.toZonedDateTimeISO(zone).toPlainDateTime().toString();
      for (const o of upcomingOccurrences({ ...series, tzid: zone }, fromLocal, MAX_OCCURRENCES)) {
        if (o.startUtc === null || o.endUtc === null) continue;
        const start = Temporal.Instant.from(o.startUtc);
        if (Temporal.Instant.compare(start, rangeEnd) >= 0) break;
        const inTz = (i: Temporal.Instant) =>
          minute(i.toZonedDateTimeISO(query.tz).toPlainDateTime());
        busy.push({
          allDay: false,
          start: inTz(start),
          end: inTz(Temporal.Instant.from(o.endUtc)),
        });
      }
    }
  }
  return busy;
}
