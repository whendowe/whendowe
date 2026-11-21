// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import ICAL from "ical.js";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
import { vtimezone } from "../../src/feeds/ics.js";
import { KEEP_DAYS, readFeed } from "../../src/following/read.js";
import { propertySettings } from "./budget.js";

// Reading a followed calendar (DESIGN §10 rc56/rc57) against an independent reader: Mozilla's
// ical.js, the parser in Thunderbird. For any feed of the shapes a public calendar uses —
// UTC, zoned and all-day times; weekly series with WKST, INTERVAL, COUNT or a UTC or local
// UNTIL; EXDATEs; dates of a series moved or cancelled — what readFeed keeps is exactly what
// ical.js says is on in the window: the same events, starting at the same instants. The window
// crosses a change of clocks (Europe 2027-03-28, America 2027-03-14).

const NOW = "2027-03-01T12:00:00Z";
const FEED_ZONE = "Europe/Prague";
const ZONES = ["Europe/Prague", "America/New_York", "Asia/Tokyo"] as const;
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

const basic = (t: Temporal.PlainDateTime) => t.toString().replaceAll(/[-:]/g, "");
const basicDate = (d: Temporal.PlainDate) => d.toString().replaceAll("-", "");
const utc = (i: Temporal.Instant) => `${basic(i.toZonedDateTimeISO("UTC").toPlainDateTime())}Z`;

function drawInt(tc: hegel.TestCase, min: number, max: number): number {
  return tc.draw(gs.integers({ minValue: min, maxValue: max }));
}

interface Drawn {
  readonly lines: string[][]; // VEVENT bodies
  readonly zones: Set<string>;
}

function drawEvent(tc: hegel.TestCase, i: number, out: Drawn): void {
  const uid = `e${i}@example`;
  const title = `Event ${i}`;
  const day = Temporal.PlainDate.from("2027-02-01").add({ days: drawInt(tc, 0, 90) });
  const start = day.toPlainDateTime({ hour: drawInt(tc, 0, 22), minute: drawInt(tc, 0, 3) * 15 });
  const kind = tc.draw(gs.sampledFrom(["utc", "zoned", "date"] as const));
  const zone = tc.draw(gs.sampledFrom(ZONES));
  const minutes = drawInt(tc, 0, 4) * 30;
  const days = drawInt(tc, 1, 2);
  const at = (t: Temporal.PlainDateTime, name: string) => {
    if (kind === "date") return `${name};VALUE=DATE:${basicDate(t.toPlainDate())}`;
    if (kind === "zoned") return `${name};TZID=${zone}:${basic(t)}`;
    return `${name}:${utc(t.toZonedDateTime(zone).toInstant())}`;
  };
  if (kind === "zoned") out.zones.add(zone);
  const end = kind === "date" ? start.add({ days }) : start.add({ minutes });
  const master = [`UID:${uid}`, at(start, "DTSTART"), at(end, "DTEND"), `SUMMARY:${title}`];

  if (tc.draw(gs.booleans())) {
    out.lines.push(master);
    return;
  }
  // A weekly series: on its start's weekday, or no BYDAY (the same, by RFC 5545).
  const rule = [`FREQ=WEEKLY`];
  if (tc.draw(gs.booleans())) rule.push(`WKST=${tc.draw(gs.sampledFrom(DAYS))}`);
  if (tc.draw(gs.booleans())) rule.push(`INTERVAL=${drawInt(tc, 1, 2)}`);
  // A series repeats in the frame its DTSTART is written in: a UTC start every week in UTC,
  // on its UTC weekday, so its local time moves when the clocks change.
  const written = kind === "utc" ? start.toZonedDateTime(zone).withTimeZone("UTC") : start;
  /** `start` moved by whole weeks in that frame, as wall clock in `zone`. */
  const later = (w: number) =>
    kind === "utc"
      ? start
          .toZonedDateTime(zone)
          .withTimeZone("UTC")
          .add({ weeks: w })
          .withTimeZone(zone)
          .toPlainDateTime()
      : start.add({ weeks: w });
  if (tc.draw(gs.booleans())) rule.push(`BYDAY=${DAYS[written.dayOfWeek % 7]}`);
  const ending = tc.draw(gs.sampledFrom(["count", "until", "none"] as const));
  const weeks = drawInt(tc, 1, 12);
  if (ending === "count") rule.push(`COUNT=${weeks}`);
  if (ending === "until") {
    const last = later(weeks);
    rule.push(
      kind === "date"
        ? `UNTIL=${basicDate(last.toPlainDate())}`
        : `UNTIL=${utc(last.toZonedDateTime(zone).toInstant())}`,
    );
  }
  master.push(`RRULE:${rule.join(";")}`);
  const step = rule.includes("INTERVAL=2") ? 2 : 1;
  const nth = (n: number) => later(n * step);
  if (tc.draw(gs.booleans())) master.push(at(nth(drawInt(tc, 0, 4)), "EXDATE"));
  out.lines.push(master);

  if (tc.draw(gs.booleans())) {
    // Perhaps a date the series has, perhaps one past its end or deleted: an override of a
    // date that isn't there names nothing, for both readers.
    const original = nth(drawInt(tc, 0, 4));
    const moved = original.add({ days: drawInt(tc, -2, 2) }).add({ hours: drawInt(tc, 0, 3) });
    const cancelled = tc.draw(gs.booleans());
    out.lines.push([
      `UID:${uid}`,
      at(original, "RECURRENCE-ID"),
      at(moved, "DTSTART"),
      at(moved.add(end.since(start)), "DTEND"),
      `SUMMARY:${title} moved`,
      ...(cancelled ? ["STATUS:CANCELLED"] : []),
    ]);
  }
}

function serialize(d: Drawn): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `X-WR-TIMEZONE:${FEED_ZONE}`,
    ...[...d.zones].flatMap((z) => vtimezone(z, 2026, 2028)),
    ...d.lines.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");
}

/** What ical.js says is on in the window: "start instant (or date) | title | status". */
function oracle(text: string): string[] {
  ICAL.TimezoneService.reset();
  const calendar = new ICAL.Component(ICAL.parse(text));
  for (const tz of calendar.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);
  const from = Temporal.Instant.from(NOW);
  const before = from.add({ hours: 24 * KEEP_DAYS });
  // ical.js reads a date as midnight floating; readFeed keeps it floating too, and the window
  // places floating times in the feed's zone. Everything else is an instant already.
  const instant = (t: ICAL.Time) => {
    if (t.isDate || t.zone === ICAL.Timezone.localTimezone) {
      return Temporal.PlainDateTime.from(t.toString().replace("Z", ""))
        .toZonedDateTime(FEED_ZONE)
        .toInstant();
    }
    // A wall-clock time the clocks skip (02:30 the night summer time starts) is read, by
    // RFC 5545 §3.3.5, with the offset from before the change; ical.js reads it with the one
    // after, an hour early (found at soak budget). Only there is the RFC's reading used.
    const tzid = t.zone?.tzid;
    if (tzid !== undefined && tzid !== "UTC" && tzid !== "Z") {
      const local = Temporal.PlainDateTime.from(t.toString());
      try {
        local.toZonedDateTime(tzid, { disambiguation: "reject" });
      } catch {
        return local.toZonedDateTime(tzid, { disambiguation: "compatible" }).toInstant();
      }
    }
    return Temporal.Instant.fromEpochMilliseconds(t.toUnixTime() * 1000);
  };
  const key = (s: ICAL.Time, title: string, status: string) =>
    `${s.isDate ? s.toString() : instant(s).toString()} | ${title} | ${status}`;
  const on = (s: ICAL.Time, e: ICAL.Time) => {
    const a = instant(s);
    const b = instant(e);
    return (
      Temporal.Instant.compare(a, before) < 0 &&
      (Temporal.Instant.compare(b, from) > 0 || Temporal.Instant.compare(a, from) >= 0)
    );
  };
  const out: string[] = [];
  const vevents = calendar.getAllSubcomponents("vevent");
  for (const v of vevents) {
    if (v.hasProperty("recurrence-id")) continue;
    // Its own overrides only: left to itself, ical.js's Event takes every RECURRENCE-ID in
    // the calendar, whatever its UID (found at soak budget).
    const uid = v.getFirstPropertyValue("uid");
    const exceptions = vevents.filter(
      (x) => x.hasProperty("recurrence-id") && x.getFirstPropertyValue("uid") === uid,
    );
    const ev = new ICAL.Event(v, { exceptions, strictExceptions: true });
    const status = (c: ICAL.Component) =>
      String(c.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED"
        ? "cancelled"
        : "confirmed";
    if (!ev.isRecurring()) {
      if (on(ev.startDate, ev.endDate)) out.push(key(ev.startDate, ev.summary, status(v)));
      continue;
    }
    const it = ev.iterator();
    for (let n = 0; n < 200; n++) {
      const next = it.next(); // null or undefined once the rule ends
      if (next === null || next === undefined) break;
      const o = ev.getOccurrenceDetails(next);
      if (on(o.startDate, o.endDate)) {
        out.push(key(o.startDate, o.item.summary, status(o.item.component)));
      }
    }
  }
  return out.sort();
}

test("readFeed keeps exactly what an independent reader says is on in the window", () =>
  hegel.test((tc) => {
    const drawn: Drawn = { lines: [], zones: new Set() };
    const count = drawInt(tc, 1, 4);
    for (let i = 0; i < count; i++) drawEvent(tc, i, drawn);
    const text = serialize(drawn);
    const read = readFeed(text, NOW);
    if (!read.ok) throw new Error("unreadable");
    expect(read.leftOut).toBe(0);
    const ours = read.events
      .map((e) => {
        const at = Temporal.PlainDateTime.from(e.startLocal);
        const when = e.allDay
          ? at.toPlainDate().toString()
          : at
              .toZonedDateTime(e.tzid ?? FEED_ZONE, { disambiguation: "compatible" })
              .toInstant()
              .toString();
        return `${when} | ${e.title} | ${e.status}`;
      })
      .sort();
    expect(ours, text).toEqual(oracle(text));
  }, propertySettings));
