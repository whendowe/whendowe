// SPDX-License-Identifier: AGPL-3.0-or-later
import { Temporal } from "temporal-polyfill";
import { canSee } from "../events/participation.js";
import type { Visibility } from "../people/group.js";

// A calendar feed as RFC 5545 text (DESIGN §10 rc34 *Calendar feeds*). Pure: events at
// the reader's tier in, the feed's body out. Serializing is an injection surface (§13):
// every TEXT value is escaped and every line folded, so no title, place or note can add
// a property line, and whatever isn't TEXT is checked against the shape it must have.
//
// The output depends only on its input and the year `now` falls in, so a feed that
// hasn't changed renders to the same bytes and its ETag holds (§10 rc34).

/** One event as a feed shows it: the reader's tier decides which fields appear. */
export interface FeedEntry {
  readonly id: string;
  readonly revision: number;
  /** ISO instant, UTC: the last change, which is also DTSTAMP. */
  readonly updatedAt: string;
  readonly status: "scheduled" | "cancelled";
  /** The reader's tier; a HIDDEN event is never an entry. */
  readonly visibility: Exclude<Visibility, "HIDDEN">;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly allDay: boolean;
  /** Wall clock as stored (§10): `YYYY-MM-DD` all day, else `YYYY-MM-DDTHH:mm:ss`. */
  readonly startLocal: string;
  readonly endLocal: string;
  readonly tzid: string | null;
  readonly rrule: string | null;
  /** The event's page, for a tier that sees its title; null for BUSY. */
  readonly url: string | null;
}

export interface Feed {
  /** The feed's own name, shown by calendar apps: "WhenDoWe", "WhenDoWe · Rope jam". */
  readonly name: string;
  /** The instance's host, for UIDs: `<event id>@<host>`. */
  readonly host: string;
  readonly entries: readonly FeedEntry[];
  /** ISO instant: only its year is used, for how far ahead time zones are described. */
  readonly now: string;
}

/** What a BUSY reader sees as the title (as on the site, events.ts BUSY_LABEL). */
export const BUSY_SUMMARY = "Busy";

/** Years of time-zone changes described past the later of a series' start and now. */
export const TZ_YEARS_AHEAD = 10;

const CRLF = "\r\n";

/**
 * RFC 5545 §3.3.11 TEXT: backslash, semicolon and comma escaped, every line break as
 * `\n`. Other control characters can't be written in TEXT at all, so they are dropped.
 */
export function escapeText(value: string): string {
  return [...value.replace(/\r\n|\r|\n/g, "\n")]
    .filter((c) => c === "\t" || c === "\n" || !isControl(c))
    .join("")
    .replace(/[\\;,\n]/g, (c) => (c === "\n" ? "\\n" : `\\${c}`));
}

/** C0 controls and DEL. */
function isControl(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/**
 * RFC 5545 §3.1: lines of at most 75 octets, continued on lines that start with one
 * space. Never splits a UTF-8 character.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = out.length === 0 ? 75 : 74; // a continuation's leading space counts
    if (octets + size > limit) {
      out.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  out.push(current);
  return out.join(`${CRLF} `);
}

// Values that are not TEXT are written as they are, so each is checked against the
// shape it must have: a stored value that doesn't fit would be a bug, not a feed line.
const SAFE = {
  id: /^[0-9A-Za-z-]{1,64}$/,
  host: /^[0-9A-Za-z.-]{1,253}(:\d{1,5})?$/,
  tzid: /^[A-Za-z0-9_+\-/]{1,64}$/,
  rrule: /^[A-Z0-9=;,:+-]{1,500}$/,
  url: /^https:\/\/[^\s"<>\\]{1,2000}$/,
} as const;

function checked(kind: keyof typeof SAFE, value: string): string {
  if (!SAFE[kind].test(value)) throw new Error(`feed: not a valid ${kind}`);
  return value;
}

const basic = (s: string) => s.replace(/[-:]/g, "");

/** `2101-11-21T18:00:00` → `21011121T180000`; `2101-11-21` → `21011121`. */
function localStamp(local: string): string {
  return basic(local.slice(0, 19));
}

/** An instant as `YYYYMMDDTHHMMSSZ`. */
function utcStamp(instant: Temporal.Instant): string {
  return `${basic(instant.toZonedDateTimeISO("UTC").toPlainDateTime().toString({ smallestUnit: "second" }))}Z`;
}

/** `+01:00` → `+0100`; `+05:45` → `+0545`. */
function offsetValue(nanoseconds: number): string {
  const sign = nanoseconds < 0 ? "-" : "+";
  const total = Math.abs(Math.round(nanoseconds / 1e9));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${sign}${pad(h)}${pad(m)}${s === 0 ? "" : pad(s)}`;
}

/**
 * A VTIMEZONE for one zone, from the platform's own zone data (§10 rc34): one
 * observance for the offset in force on 1 January of `fromYear`, then one per change
 * up to the end of `toYear`. Each observance's DTSTART is in the offset before it.
 */
export function vtimezone(tzid: string, fromYear: number, toYear: number): string[] {
  const zone = checked("tzid", tzid);
  let at = Temporal.ZonedDateTime.from({ year: fromYear, month: 1, day: 1, timeZone: zone });
  const end = Temporal.ZonedDateTime.from({ year: toYear + 1, month: 1, day: 1, timeZone: zone });
  const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
  const observance = (kind: "STANDARD" | "DAYLIGHT", start: string, from: number, to: number) =>
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${start}`,
      `TZOFFSETFROM:${offsetValue(from)}`,
      `TZOFFSETTO:${offsetValue(to)}`,
      `END:${kind}`,
    );
  observance(
    "STANDARD",
    localStamp(at.toPlainDateTime().toString({ smallestUnit: "second" })),
    at.offsetNanoseconds,
    at.offsetNanoseconds,
  );
  for (;;) {
    const next = at.getTimeZoneTransition("next");
    if (next === null || Temporal.ZonedDateTime.compare(next, end) >= 0) break;
    const before = next.subtract({ nanoseconds: 1 }).offsetNanoseconds;
    const wall = next.toInstant().toZonedDateTimeISO("UTC").add({ nanoseconds: before });
    observance(
      next.offsetNanoseconds > before ? "DAYLIGHT" : "STANDARD",
      localStamp(wall.toPlainDateTime().toString({ smallestUnit: "second" })),
      before,
      next.offsetNanoseconds,
    );
    at = next;
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

/** The DTSTART/DTEND pair (§10 rc34): dates all day, UTC once, TZID when it repeats. */
function times(e: FeedEntry): string[] {
  if (e.allDay)
    return [
      `DTSTART;VALUE=DATE:${localStamp(e.startLocal)}`,
      `DTEND;VALUE=DATE:${localStamp(e.endLocal)}`,
    ];
  const zone = checked("tzid", e.tzid ?? "");
  if (e.rrule !== null)
    return [
      `DTSTART;TZID=${zone}:${localStamp(e.startLocal)}`,
      `DTEND;TZID=${zone}:${localStamp(e.endLocal)}`,
    ];
  const instant = (local: string) =>
    Temporal.PlainDateTime.from(local).toZonedDateTime(zone).toInstant();
  return [`DTSTART:${utcStamp(instant(e.startLocal))}`, `DTEND:${utcStamp(instant(e.endLocal))}`];
}

function vevent(e: FeedEntry, host: string): string[] {
  const see = (part: Parameters<typeof canSee>[1]) => canSee(e.visibility, part);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${checked("id", e.id)}@${host}`,
    `DTSTAMP:${utcStamp(Temporal.Instant.from(e.updatedAt))}`,
    `SEQUENCE:${Math.max(0, Math.trunc(e.revision))}`,
    ...times(e),
  ];
  if (e.rrule !== null) lines.push(`RRULE:${checked("rrule", e.rrule)}`);
  lines.push(`SUMMARY:${escapeText(see("title") ? e.title : BUSY_SUMMARY)}`);
  if (see("location") && e.location !== null) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (see("description") && e.description !== null)
    lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (see("title") && e.url !== null) lines.push(`URL:${checked("url", e.url)}`);
  lines.push(
    `STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    // BUSY is still busy: the time is taken, whatever is in it.
    "TRANSP:OPAQUE",
    "END:VEVENT",
  );
  return lines;
}

/** The whole feed: zones the repeating events need, then the events, CRLF throughout. */
export function serializeFeed(feed: Feed): string {
  const host = checked("host", feed.host);
  const nowYear = Temporal.Instant.from(feed.now).toZonedDateTimeISO("UTC").year;
  // A zone is described from the earliest repeating start in it; one-off events are UTC.
  const zones = new Map<string, number>();
  for (const e of feed.entries) {
    if (e.allDay || e.rrule === null || e.tzid === null) continue;
    const year = Temporal.PlainDateTime.from(e.startLocal).year;
    zones.set(e.tzid, Math.min(zones.get(e.tzid) ?? year, year));
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WhenDoWe//Calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(feed.name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    // Sorted by name (code units: zone names are ASCII), so the bytes don't depend on order.
    ...[...zones.keys()].sort().flatMap((tzid) => {
      const from = zones.get(tzid) ?? nowYear;
      return vtimezone(tzid, from, Math.max(from, nowYear) + TZ_YEARS_AHEAD);
    }),
    ...feed.entries.flatMap((e) => vevent(e, host)),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
