// SPDX-License-Identifier: AGPL-3.0-or-later
import { Temporal } from "temporal-polyfill";
import { expandOccurrences, MAX_OCCURRENCES, parseRRule } from "../recurrence.js";

// Retention (DESIGN §10 rc21 *Retention*, GDPR Art. 5(1)(e)): which rows are due. Pure —
// the purge pass (purge.ts) reads candidates, asks here, and deletes.
//
// Days, not instants. A period is counted in whole days after the last LOCAL day an
// event or plan touches, and is due once that many days have passed in UTC plus one more:
// no time zone is more than a day from UTC, so nothing goes early anywhere, and a year's
// retention needs no finer clock.

/** The default: twelve months. */
export const DEFAULT_RETAIN_DAYS = 365;

/** Expired rows, and how long the erasure ledger is kept: the backup window plus margin. */
export const LEDGER_KEEP_DAYS = 35;

export interface EventForRetention {
  readonly startLocal: string;
  readonly endLocal: string;
  readonly allDay: boolean;
  readonly tzid: string | null;
  readonly rrule: string | null;
  readonly status: string;
  /** When it last changed, ISO UTC: when an endless series was cancelled, if it was. */
  readonly updatedAt: string;
  readonly retainDays: number;
}

/** The plain date of a §10 local time ("2101-11-20T18:00" or "2101-11-20"). */
function dayOf(local: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(local.slice(0, 10));
}

/**
 * The last day an event touches, or null if it never ends: a series with neither COUNT
 * nor UNTIL, until it is cancelled (then the day it was cancelled). An all-day event's
 * end is exclusive (RFC 5545), so it last touches the day before.
 */
export function lastDay(e: EventForRetention): Temporal.PlainDate | null {
  const last = lastEndLocal(e);
  if (last === null) return null;
  const day = dayOf(last);
  return e.allDay ? day.subtract({ days: 1 }) : day;
}

/** Days one period of a rule can span at most: the bound when a series is too long to walk. */
const PERIOD_DAYS = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 } as const;

/** Never early: exact where it's cheap, an upper bound where it isn't. */
function lastEndLocal(e: EventForRetention): string | null {
  if (e.rrule === null) return e.endLocal;
  const rule = parseRRule(e.rrule);
  if (rule.count === undefined && rule.until === undefined) {
    return e.status === "cancelled" ? e.updatedAt.slice(0, 10) : null;
  }
  const length = Temporal.PlainDateTime.from(e.startLocal).until(
    Temporal.PlainDateTime.from(e.endLocal),
  );
  if (rule.until !== undefined) {
    // The last start is on or before UNTIL; it ends one event-length later.
    return Temporal.PlainDateTime.from(rule.until).add(length).toString();
  }
  const count = rule.count ?? 1;
  if (count <= MAX_OCCURRENCES) {
    const all = expandOccurrences(
      { startLocal: e.startLocal, endLocal: e.endLocal, tzid: e.tzid, rrule: e.rrule, exdates: [] },
      count,
    );
    return all.at(-1)?.endLocal ?? e.endLocal;
  }
  // Longer than expandOccurrences walks: every occurrence starts within one period of the last.
  const days = count * (rule.interval ?? 1) * PERIOD_DAYS[rule.freq];
  return Temporal.PlainDateTime.from(e.endLocal).add({ days }).toString();
}

/** Whether `days` whole days have passed since `last`, with a day's margin for zones. */
export function dueAfter(last: Temporal.PlainDate, days: number, nowIso: string): boolean {
  const today = dayOf(nowIso);
  return Temporal.PlainDate.compare(last.add({ days: days + 1 }), today) < 0;
}

export function isEventDue(e: EventForRetention, nowIso: string): boolean {
  const last = lastDay(e);
  return last !== null && dueAfter(last, e.retainDays, nowIso);
}

/**
 * A plan that was never accepted goes twelve months after its last day (rc19 plans
 * hold proposals, not facts). An accepted one became ordinary events, which follow
 * their own retention; it goes once they have. A plan with no events counts from the
 * day it was made.
 */
export function isPlanDue(
  p: {
    readonly lastEndLocal: string | null;
    readonly allDay: boolean;
    readonly createdAt: string;
    readonly liveEvents: number;
  },
  nowIso: string,
): boolean {
  if (p.liveEvents > 0) return false;
  const last =
    p.lastEndLocal === null
      ? dayOf(p.createdAt)
      : p.allDay
        ? dayOf(p.lastEndLocal).subtract({ days: 1 })
        : dayOf(p.lastEndLocal);
  return dueAfter(last, DEFAULT_RETAIN_DAYS, nowIso);
}

/** The cutoff before which a row's own timestamp makes it due: now minus `days`. */
export function cutoff(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) - days * 24 * 60 * 60 * 1000).toISOString();
}

/** The retention pass runs once an hour, at this minute, on the every-minute cron. */
export const RETENTION_MINUTE = 7;

export function isRetentionMinute(nowIso: string): boolean {
  return new Date(nowIso).getUTCMinutes() === RETENTION_MINUTE;
}
