// SPDX-License-Identifier: AGPL-3.0-or-later
import { Temporal } from "temporal-polyfill";
import { isTimeZone } from "../events/event.js";
import { MAX_OCCURRENCES, parseRRule, upcomingOccurrences } from "../recurrence.js";

// Reading a followed calendar (DESIGN §10 rc56/rc57). Pure: RFC 5545 text -> the events in the
// window kept, today to KEEP_DAYS ahead, one row per occurrence. What comes back is data (§13):
// nothing here is obeyed, and every field is escaped where it is shown. Series go through
// recurrence.ts, as our own do; a feed's rule is read into that subset where it means the same
// (rc57). One event that can't be read is left out and counted; a feed with nothing readable,
// or that isn't a calendar at all, is unreadable — never half-applied.

/** How far ahead a followed calendar's events are kept (rc56). */
export const KEEP_DAYS = 60;

/** At most this many occurrences are kept per calendar; the rest count as left out. */
export const MAX_KEPT = 2000;

const MAX_TITLE = 300;
const MAX_LOCATION = 300;
const MAX_DESCRIPTION = 4000;
const MAX_URL = 2000;
const MAX_NAME = 200;

export interface FollowedEventRow {
  /** The feed's UID; for a date of a series, `UID/<its original start>`. */
  readonly uid: string;
  readonly title: string;
  readonly location: string | null;
  readonly description: string | null;
  readonly url: string | null;
  readonly startLocal: string;
  readonly endLocal: string;
  /** IANA zone; null = floating. A UTC time in the feed is kept in the feed's own zone. */
  readonly tzid: string | null;
  readonly allDay: boolean;
  readonly status: "confirmed" | "cancelled";
}

export type ReadFeed =
  | {
      readonly ok: true;
      readonly name: string | null;
      readonly events: readonly FollowedEventRow[];
      readonly leftOut: number;
    }
  | { readonly ok: false };

// ---------------------------------------------------------------------------
// Content lines
// ---------------------------------------------------------------------------

interface Line {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
}

/** RFC 5545 §3.1: a line starting with a space or tab continues the one before it. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const last = lines.length - 1;
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && last >= 0) {
      lines[last] += raw.slice(1);
    } else if (raw !== "") {
      lines.push(raw);
    }
  }
  return lines;
}

/** `NAME;P=v;Q="a:b":value` — a colon inside quotes is part of a parameter. */
function parseLine(raw: string): Line | null {
  let i = 0;
  while (i < raw.length && raw[i] !== ";" && raw[i] !== ":") i++;
  const name = raw.slice(0, i).toUpperCase();
  const params = new Map<string, string>();
  while (raw[i] === ";") {
    const eq = raw.indexOf("=", i);
    if (eq < 0) return null;
    const key = raw.slice(i + 1, eq).toUpperCase();
    let j = eq + 1;
    let value = "";
    if (raw[j] === '"') {
      const close = raw.indexOf('"', j + 1);
      if (close < 0) return null;
      value = raw.slice(j + 1, close);
      j = close + 1;
    } else {
      while (j < raw.length && raw[j] !== ";" && raw[j] !== ":") j++;
      value = raw.slice(eq + 1, j);
    }
    params.set(key, value);
    i = j;
  }
  if (raw[i] !== ":") return null;
  return { name, params, value: raw.slice(i + 1) };
}

/** RFC 5545 §3.3.11 TEXT: `\n`, `\,`, `\;`, `\\`. */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function capped(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const text = unescapeText(value).trim();
  return text === "" ? null : text.slice(0, max);
}

function webUrl(value: string | undefined): string | null {
  if (value === undefined || value.length > MAX_URL) return null;
  try {
    const url = new URL(value); // the parser trims spaces itself
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/** Why an event is left out, said where it is refused; any error in one event leaves it out. */
class Unreadable extends Error {}

type Moment =
  | { readonly kind: "date"; readonly date: Temporal.PlainDate }
  | { readonly kind: "local"; readonly at: Temporal.PlainDateTime; readonly tzid: string | null }
  | { readonly kind: "utc"; readonly at: Temporal.Instant };

const DATE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

function moment(value: string, params: ReadonlyMap<string, string>): Moment {
  const d = DATE.exec(value);
  if (d !== null || params.get("VALUE") === "DATE") {
    if (d === null) throw new Unreadable("a date that isn't one");
    return {
      kind: "date",
      date: Temporal.PlainDate.from(
        { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]) },
        { overflow: "reject" },
      ),
    };
  }
  const t = DATE_TIME.exec(value);
  if (t === null) throw new Unreadable("not a date-time");
  const at = Temporal.PlainDateTime.from(
    {
      year: Number(t[1]),
      month: Number(t[2]),
      day: Number(t[3]),
      hour: Number(t[4]),
      minute: Number(t[5]),
      second: Math.min(Number(t[6]), 59), // a leap second is the second before it
    },
    { overflow: "reject" },
  );
  if (t[7] === "Z") return { kind: "utc", at: at.toZonedDateTime("UTC").toInstant() };
  const tzid = params.get("TZID") ?? null;
  if (tzid !== null && !isTimeZone(tzid)) throw new Unreadable("a zone we don't know");
  return { kind: "local", at, tzid };
}

/** The zone an event's times are kept in: its own, or the feed's for a UTC time. */
function zoneOf(start: Moment, feedZone: string): string | null {
  if (start.kind === "local") return start.tzid;
  return start.kind === "utc" ? feedZone : null;
}

/** A moment as wall clock in `zone` (null = floating: a local time is kept as it is). */
function wallClock(m: Moment, zone: string | null): Temporal.PlainDateTime {
  switch (m.kind) {
    case "date":
      return m.date.toPlainDateTime();
    case "utc":
      return m.at.toZonedDateTimeISO(zone ?? "UTC").toPlainDateTime();
    case "local":
      if (m.tzid === null || zone === null || m.tzid === zone) return m.at;
      return m.at
        .toZonedDateTime(m.tzid, { disambiguation: "compatible" })
        .withTimeZone(zone)
        .toPlainDateTime();
  }
}

/** Wall clock in one zone as wall clock in another; a floating time stays as it is. */
function rezone(
  t: Temporal.PlainDateTime,
  from: string | null,
  to: string | null,
): Temporal.PlainDateTime {
  if (from === null || to === null || from === to) return t;
  return t
    .toZonedDateTime(from, { disambiguation: "compatible" })
    .withTimeZone(to)
    .toPlainDateTime();
}

/**
 * rezone for a wall clock as text, as occurrences come, for one read of a feed. One that stays
 * in its zone is used as it is, unparsed; one that moves is worked out once per time and zones,
 * as a feed's series share their times (40 daily classes at 19:00 are 60 times, not 2400) and a
 * zone's offset costs the polyfill most of a millisecond. It keeps up to 2000 occurrences.
 */
function rezoneText(
  local: string,
  from: string | null,
  to: string | null,
  seen: Map<string, string>,
): string {
  if (from === null || to === null || from === to) return local;
  const key = `${from} ${to} ${local}`;
  let found = seen.get(key);
  if (found === undefined) {
    found = rezone(Temporal.PlainDateTime.from(local), from, to).toString();
    seen.set(key, found);
  }
  return found;
}

function instantOf(local: Temporal.PlainDateTime, zone: string): Temporal.Instant {
  return local.toZonedDateTime(zone, { disambiguation: "compatible" }).toInstant();
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const RULE_DATE_TIME = /^(\d{8})T(\d{6})Z$/;

/**
 * A feed's RRULE in the recurrence subset, where it means the same (rc57): WKST is dropped
 * when it can't move a date — not weekly, INTERVAL=1, or at most one BYDAY — and a UTC UNTIL
 * becomes the series' wall clock. Anything else is left to parseRRule to refuse.
 */
export function feedRule(raw: string, zone: string | null): string {
  const parts = raw.split(";").filter((p) => p !== "");
  const get = (key: string) =>
    parts.find((p) => p.toUpperCase().startsWith(`${key}=`))?.slice(key.length + 1);
  const weekly = get("FREQ")?.toUpperCase() === "WEEKLY";
  const interval = get("INTERVAL");
  const days = get("BYDAY")?.split(",").length ?? 0;
  const wkstHarmless = !weekly || interval === undefined || interval === "1" || days <= 1;
  const kept: string[] = [];
  for (const part of parts) {
    const key = part.split("=", 1)[0]?.toUpperCase();
    if (key === "WKST" && wkstHarmless) continue;
    if (key === "UNTIL") {
      const value = part.slice("UNTIL=".length);
      const utc = RULE_DATE_TIME.exec(value);
      if (utc !== null) {
        const local = wallClock(moment(value, new Map()), zone);
        kept.push(`UNTIL=${local.toString().replaceAll(/[-:]/g, "")}`);
        continue;
      }
    }
    kept.push(part);
  }
  const rule = kept.join(";");
  parseRRule(rule); // throws for a rule outside the subset
  return rule;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type Props = ReadonlyMap<string, readonly Line[]>;

interface Read {
  readonly uid: string;
  readonly recurrenceId: Moment | null;
  readonly rrule: string | null;
  readonly exdates: readonly Moment[];
  /** The zone its rows are kept in: its own, or the feed's for a UTC time. */
  readonly zone: string | null;
  /**
   * The zone its rule repeats in, and its times there: a series given in UTC repeats in UTC
   * (RFC 5545 §3.3.10), so across a change of clocks its local time moves.
   */
  readonly ruleZone: string | null;
  readonly ruleStart: Temporal.PlainDateTime;
  readonly ruleEnd: Temporal.PlainDateTime;
  readonly allDay: boolean;
  readonly start: Temporal.PlainDateTime;
  readonly end: Temporal.PlainDateTime;
  readonly fields: Omit<FollowedEventRow, "uid" | "startLocal" | "endLocal" | "tzid" | "allDay">;
}

function one(props: Props, name: string): Line | undefined {
  return props.get(name)?.[0];
}

function readEvent(props: Props, feedZone: string): Read {
  const uid = one(props, "UID")?.value.trim();
  if (uid === undefined || uid === "" || uid.length > 500) throw new Unreadable("no UID");
  if (props.has("RDATE")) throw new Unreadable("RDATE");
  const dtstart = one(props, "DTSTART");
  if (dtstart === undefined) throw new Unreadable("no start");
  const startMoment = moment(dtstart.value, dtstart.params);
  const allDay = startMoment.kind === "date";
  const zone = zoneOf(startMoment, feedZone);
  const ruleZone = startMoment.kind === "utc" ? "UTC" : zone;
  const ruleStart = wallClock(startMoment, ruleZone);

  const dtend = one(props, "DTEND");
  const duration = one(props, "DURATION");
  let ruleEnd: Temporal.PlainDateTime;
  if (dtend !== undefined) {
    const endMoment = moment(dtend.value, dtend.params);
    if ((endMoment.kind === "date") !== allDay)
      throw new Unreadable("start and end differ in kind");
    ruleEnd = wallClock(endMoment, ruleZone);
  } else if (duration !== undefined) {
    ruleEnd = ruleStart.add(Temporal.Duration.from(duration.value.replace(/^\+/, "")));
  } else {
    ruleEnd = allDay ? ruleStart.add({ days: 1 }) : ruleStart;
  }
  if (Temporal.PlainDateTime.compare(ruleEnd, ruleStart) < 0) {
    throw new Unreadable("ends before it starts");
  }

  const recurrence = one(props, "RECURRENCE-ID");
  if (recurrence?.params.get("RANGE") !== undefined) throw new Unreadable("RANGE");
  const rule = one(props, "RRULE");
  const exdates = (props.get("EXDATE") ?? []).flatMap((line) =>
    line.value.split(",").map((v) => moment(v.trim(), line.params)),
  );

  return {
    uid,
    recurrenceId: recurrence === undefined ? null : moment(recurrence.value, recurrence.params),
    rrule: rule === undefined ? null : feedRule(rule.value, ruleZone),
    exdates,
    zone,
    ruleZone,
    ruleStart,
    ruleEnd,
    allDay,
    start: rezone(ruleStart, ruleZone, zone),
    end: rezone(ruleEnd, ruleZone, zone),
    fields: {
      title: capped(one(props, "SUMMARY")?.value, MAX_TITLE) ?? "",
      location: capped(one(props, "LOCATION")?.value, MAX_LOCATION),
      description: capped(one(props, "DESCRIPTION")?.value, MAX_DESCRIPTION),
      url: webUrl(one(props, "URL")?.value),
      status:
        one(props, "STATUS")?.value.trim().toUpperCase() === "CANCELLED"
          ? "cancelled"
          : "confirmed",
    },
  };
}

interface Window {
  readonly from: Temporal.Instant;
  readonly before: Temporal.Instant;
  /** Wall clocks already moved between zones in this read (rezoneText). */
  readonly rezoned: Map<string, string>;
}

function inWindow(
  start: Temporal.PlainDateTime,
  end: Temporal.PlainDateTime,
  zone: string,
  w: Window,
): boolean {
  const s = instantOf(start, zone);
  const e = instantOf(end, zone);
  if (Temporal.Instant.compare(s, w.before) >= 0) return false;
  // Not over yet; an event with no length is kept until the moment it starts.
  return Temporal.Instant.compare(e, w.from) > 0 || Temporal.Instant.compare(s, w.from) >= 0;
}

function row(
  e: Read,
  uid: string,
  start: Temporal.PlainDateTime | string,
  end: Temporal.PlainDateTime | string,
  status: FollowedEventRow["status"],
): FollowedEventRow {
  return {
    uid,
    ...e.fields,
    status,
    startLocal: start.toString(),
    endLocal: end.toString(),
    tzid: e.zone,
    allDay: e.allDay,
  };
}

/** A series' occurrences in the window, less its EXDATEs and the dates overridden. */
function occurrences(
  master: Read,
  rrule: string,
  overridden: ReadonlySet<string>,
  feedZone: string,
  w: Window,
): FollowedEventRow[] {
  const zone = master.ruleZone ?? feedZone;
  const local = (i: Temporal.Instant) => i.toZonedDateTimeISO(zone).toPlainDateTime().toString();
  const exdates = master.exdates.map((m) => wallClock(m, master.ruleZone).toString());
  const found = upcomingOccurrences(
    {
      startLocal: master.ruleStart.toString(),
      endLocal: master.ruleEnd.toString(),
      tzid: master.ruleZone,
      rrule,
      exdates,
    },
    local(w.from),
    MAX_OCCURRENCES,
    local(w.before),
  );
  return found
    .filter((o) => !overridden.has(o.startLocal))
    .map((o) =>
      row(
        master,
        `${master.uid}/${o.startLocal}`,
        rezoneText(o.startLocal, master.ruleZone, master.zone, w.rezoned),
        rezoneText(o.endLocal, master.ruleZone, master.zone, w.rezoned),
        master.fields.status,
      ),
    );
}

/** Whether a series has a date starting at `at` (its rule's wall clock), not deleted. */
function hasDate(master: Read, at: Temporal.PlainDateTime): boolean {
  if (master.rrule === null) return false;
  const [found] = upcomingOccurrences(
    {
      startLocal: master.ruleStart.toString(),
      // A minute long, so a date with no length still counts as not over at its own start.
      endLocal: master.ruleStart.add({ minutes: 1 }).toString(),
      tzid: master.ruleZone,
      rrule: master.rrule,
      exdates: master.exdates.map((m) => wallClock(m, master.ruleZone).toString()),
    },
    at.toString(),
    1,
    at.add({ seconds: 1 }).toString(),
  );
  return found?.startLocal === at.toString();
}

/** The feed's own zone, for its UTC times: X-WR-TIMEZONE when it is one we know, else UTC. */
function feedZoneOf(value: string | undefined): string {
  const zone = value?.trim();
  return zone !== undefined && isTimeZone(zone) ? zone : "UTC";
}

/** RFC 5545 text -> the events kept, now to KEEP_DAYS ahead (`now` an ISO instant). */
export function readFeed(text: string, now: string): ReadFeed {
  const lines = unfold(text);
  if (lines[0]?.toUpperCase() !== "BEGIN:VCALENDAR") return { ok: false };

  const stack: string[] = [];
  const events: Map<string, Line[]>[] = [];
  const calendar = new Map<string, string>();
  for (const raw of lines) {
    const line = parseLine(raw);
    if (line === null) continue; // a line that isn't one is skipped, as RFC 5545 readers do
    if (line.name === "BEGIN") {
      const what = line.value.trim().toUpperCase();
      stack.push(what);
      if (what === "VEVENT" && stack.length === 2) events.push(new Map());
      continue;
    }
    if (line.name === "END") {
      stack.pop();
      continue;
    }
    if (stack.length === 1) calendar.set(line.name, line.value);
    const current = events[events.length - 1];
    if (stack.length === 2 && stack[1] === "VEVENT" && current !== undefined) {
      current.set(line.name, [...(current.get(line.name) ?? []), line]);
    }
  }

  const feedZone = feedZoneOf(calendar.get("X-WR-TIMEZONE"));
  const from = Temporal.Instant.from(now);
  const w: Window = { from, before: from.add({ hours: 24 * KEEP_DAYS }), rezoned: new Map() };

  let leftOut = 0;
  const masters = new Map<string, Read>();
  const overrides: { readonly e: Read; readonly recurrenceId: Moment }[] = [];
  for (const props of events) {
    // Whatever one event of untrusted text does wrong — a refusal here, or a value Temporal or
    // the rule reader won't take — it is that event that is left out, never the feed.
    try {
      const e = readEvent(props, feedZone);
      if (e.recurrenceId !== null) overrides.push({ e, recurrenceId: e.recurrenceId });
      else if (!masters.has(e.uid)) masters.set(e.uid, e);
    } catch {
      leftOut++;
    }
  }
  if (events.length > 0 && leftOut === events.length) return { ok: false };

  const kept: FollowedEventRow[] = [];
  const overriddenBy = new Map<string, Set<string>>();
  for (const { e: o, recurrenceId } of overrides) {
    const master = masters.get(o.uid);
    // The date it replaces, in its series' zone: that is the key its own occurrence had.
    const original = wallClock(recurrenceId, master?.ruleZone ?? o.ruleZone);
    const key = original.toString();
    // An override counts only for a date its series has: one it doesn't (or has deleted) names
    // nothing, as Thunderbird's reader has it. With no series in the feed at all, it stands alone.
    if (master !== undefined && !hasDate(master, original)) continue;
    overriddenBy.set(o.uid, (overriddenBy.get(o.uid) ?? new Set()).add(key));
    if (inWindow(o.start, o.end, o.zone ?? feedZone, w)) {
      kept.push(row(o, `${o.uid}/${key}`, o.start, o.end, o.fields.status));
    }
  }
  for (const master of masters.values()) {
    if (master.rrule === null) {
      if (inWindow(master.start, master.end, master.zone ?? feedZone, w)) {
        kept.push(row(master, master.uid, master.start, master.end, master.fields.status));
      }
    } else {
      const overridden = overriddenBy.get(master.uid) ?? new Set();
      kept.push(...occurrences(master, master.rrule, overridden, feedZone, w));
    }
  }

  // One row per key: a feed that names one date twice keeps the first it gave.
  const unique = [...new Map(kept.reverse().map((r) => [r.uid, r])).values()];
  unique.sort((a, b) =>
    a.startLocal < b.startLocal ? -1 : a.startLocal > b.startLocal ? 1 : a.uid < b.uid ? -1 : 1,
  );
  const name = capped(calendar.get("X-WR-CALNAME"), MAX_NAME);
  return {
    ok: true,
    name,
    events: unique.slice(0, MAX_KEPT),
    leftOut: leftOut + Math.max(0, unique.length - MAX_KEPT),
  };
}
