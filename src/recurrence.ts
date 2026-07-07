// SPDX-License-Identifier: AGPL-3.0-or-later
import rrulePkg from "rrule";
import { Temporal } from "temporal-polyfill";
import { z } from "zod";

// M1 recurrence spike (DESIGN.md §6/§15): rrule.js expands in FLOATING (naive) time
// only — it never sees a timezone, which is exactly the §10 wall-clock model — and
// temporal-polyfill localises each occurrence via tzid. UTC instants are derived
// here, never stored as truth.
//
// rrule ships a CJS bundle; the default-import + destructure below is the one shape
// that works at runtime in real Node ESM (cjs-module-lexer can't find named exports
// in its webpack build), under vitest, and when bundled by wrangler.
const { RRule } = rrulePkg;
type Weekday = InstanceType<typeof rrulePkg.Weekday>;

// ---------------------------------------------------------------------------
// Validated RRULE subset (§10): FREQ in {DAILY,WEEKLY,MONTHLY,YEARLY}, INTERVAL,
// BYDAY, COUNT|UNTIL. Reject everything else loudly; widen deliberately, with tests.
// ---------------------------------------------------------------------------

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const BYDAY = /^(-?[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/;

export const rruleSubsetSchema = z
  .object({
    freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    interval: z.number().int().min(1).max(366).optional(),
    byday: z.array(z.string().regex(BYDAY, "invalid BYDAY entry")).min(1).optional(),
    count: z.number().int().min(1).max(1000).optional(),
    /** RFC 5545 UNTIL, kept wall-clock (zone-less) like every §10 local time. */
    until: z.string().regex(LOCAL_DATETIME, "UNTIL must be a local datetime").optional(),
  })
  .refine((r) => r.count === undefined || r.until === undefined, {
    message: "COUNT and UNTIL are mutually exclusive (RFC 5545)",
  })
  .refine(
    (r) =>
      r.byday === undefined ||
      r.freq === "MONTHLY" ||
      r.freq === "YEARLY" ||
      r.byday.every((d) => d.length === 2),
    { message: "ordinal BYDAY (e.g. 1MO) is only valid with FREQ=MONTHLY or YEARLY" },
  );

export type RRuleSubset = z.infer<typeof rruleSubsetSchema>;

const KNOWN_KEYS = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"]);

/**
 * Parse a verbatim RFC 5545 RRULE value into the validated subset.
 * Anything outside the subset (BYSETPOS, FREQ=HOURLY, UTC UNTIL, …) throws loudly.
 */
export function parseRRule(text: string): RRuleSubset {
  const record: Record<string, string> = {};
  for (const part of text.split(";")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq < 1) throw new Error(`malformed RRULE part: "${part}"`);
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1);
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`RRULE key outside the validated subset (§10): ${key}`);
    }
    if (key in record) throw new Error(`duplicate RRULE key: ${key}`);
    record[key] = value;
  }

  const untilRaw = record.UNTIL;
  let until: string | undefined;
  if (untilRaw !== undefined) {
    if (untilRaw.endsWith("Z")) {
      // Widening this means defining which zone's wall clock it bounds — do it
      // deliberately with the provider mapping (M1), not silently here.
      throw new Error("UTC UNTIL (…Z) is outside the validated subset; use a local datetime");
    }
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/.exec(untilRaw);
    if (m === null) throw new Error(`malformed UNTIL: "${untilRaw}"`);
    until = `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "23"}:${m[5] ?? "59"}:${m[6] ?? "59"}`;
  }

  const parseIntStrict = (key: string): number | undefined => {
    const raw = record[key];
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) throw new Error(`malformed ${key}: "${raw}"`);
    return Number(raw);
  };

  return rruleSubsetSchema.parse({
    freq: record.FREQ,
    interval: parseIntStrict("INTERVAL"),
    byday: record.BYDAY?.split(","),
    count: parseIntStrict("COUNT"),
    until,
  });
}

/** Canonical serialization of the subset — the inverse of parseRRule. */
export function formatRRule(rule: RRuleSubset): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== undefined) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byday !== undefined) parts.push(`BYDAY=${rule.byday.join(",")}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) parts.push(`UNTIL=${rule.until.replaceAll(/[-:]/g, "")}`);
  return parts.join(";");
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/** Hard ceiling on any single expansion, COUNT or not — a seatbelt, not a policy. */
export const MAX_OCCURRENCES = 500;

export interface ExpandInput {
  readonly startLocal: string; // §10 wall-clock, zone-less
  readonly endLocal: string;
  readonly tzid: string | null; // IANA TZID; null = floating (no instant derivable)
  readonly rrule: string | null;
  readonly exdates: readonly string[]; // cancelled occurrence starts, local datetimes
}

export interface Occurrence {
  readonly startLocal: string;
  readonly endLocal: string;
  /** Derived instant (ISO-8601 UTC), null when tzid is null. Never authoritative. */
  readonly startUtc: string | null;
  readonly endUtc: string | null;
}

const FREQ_MAP = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
} as const;

const WEEKDAY_MAP: Record<string, Weekday> = {
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
  SU: RRule.SU,
};

/** Wall-clock string → the naive Date rrule iterates on (UTC fields as plain fields). */
function toNaive(local: string): Date {
  const p = Temporal.PlainDateTime.from(local);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

/** The inverse: naive Date back to a §10 wall-clock string. */
function fromNaive(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function toByWeekday(byday: readonly string[]): Weekday[] {
  return byday.map((entry) => {
    const m = BYDAY.exec(entry);
    if (m === null || m[2] === undefined) throw new Error(`invalid BYDAY entry: "${entry}"`);
    const weekday = WEEKDAY_MAP[m[2]];
    if (weekday === undefined) throw new Error(`invalid BYDAY weekday: "${entry}"`);
    return m[1] === undefined ? weekday : weekday.nth(Number(m[1]));
  });
}

/**
 * Expand an event into its first `limit` occurrences (capped at MAX_OCCURRENCES).
 *
 * DST correctness by construction (§10): iteration happens on naive local
 * datetimes, so every occurrence keeps the series' local time-of-day; each is
 * then localised via tzid ("compatible" disambiguation: a start falling into a
 * spring-forward gap keeps its authoritative startLocal, and its derived
 * instant shifts forward by the gap).
 */
export function expandOccurrences(input: ExpandInput, limit: number): Occurrence[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }
  const cap = Math.min(limit, MAX_OCCURRENCES);

  const start = Temporal.PlainDateTime.from(input.startLocal);
  const duration = start.until(Temporal.PlainDateTime.from(input.endLocal));
  const exdates = new Set(input.exdates);

  let starts: Temporal.PlainDateTime[];
  if (input.rrule === null) {
    starts = [start];
  } else {
    const rule = parseRRule(input.rrule);
    const rrule = new RRule({
      freq: FREQ_MAP[rule.freq],
      dtstart: toNaive(input.startLocal),
      interval: rule.interval ?? 1,
      byweekday: rule.byday === undefined ? null : toByWeekday(rule.byday),
      count: rule.count ?? null,
      until: rule.until === undefined ? null : toNaive(rule.until),
    });
    starts = rrule.all((_, i) => i < cap).map((d) => Temporal.PlainDateTime.from(fromNaive(d)));
  }

  const occurrences: Occurrence[] = [];
  for (const occStart of starts) {
    if (occurrences.length >= cap) break;
    const startLocal = occStart.toString();
    if (exdates.has(startLocal)) continue;
    const occEnd = occStart.add(duration);
    let startUtc: string | null = null;
    let endUtc: string | null = null;
    if (input.tzid !== null) {
      startUtc = occStart
        .toZonedDateTime(input.tzid, { disambiguation: "compatible" })
        .toInstant()
        .toString();
      endUtc = occEnd
        .toZonedDateTime(input.tzid, { disambiguation: "compatible" })
        .toInstant()
        .toString();
    }
    occurrences.push({ startLocal, endLocal: occEnd.toString(), startUtc, endUtc });
  }
  return occurrences;
}
