// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Temporal } from "temporal-polyfill";
import { test } from "vitest";
import {
  expandOccurrences,
  formatRRule,
  parseRRule,
  type RRuleSubset,
} from "../../src/recurrence.js";
import { propertySettings } from "./budget.js";

// The §9 recurrence properties, scoped to the M1 spike:
// - Wall-clock stability: every expanded occurrence keeps the series' local
//   time-of-day in its TZID, across DST transitions.
// - Time-model round-trip: subset-rule → RRULE text → subset-rule is the identity.
// The full canonical → provider/ICS → canonical round-trip lands with the
// provider mapping (M1) and ICS serialization (post-M5).

const ZONES = ["Europe/Prague", "America/New_York", "Australia/Sydney", "Asia/Kolkata", "UTC"];
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

// Small draw helpers over the stable primitive (integers) so the suite is
// insulated from generator-API churn in the beta (DESIGN.md §6).
function drawInt(tc: hegel.TestCase, min: number, max: number): number {
  return tc.draw(gs.integers({ minValue: min, maxValue: max }));
}

function drawFrom<T>(tc: hegel.TestCase, items: readonly T[]): T {
  const item = items[drawInt(tc, 0, items.length - 1)];
  if (item === undefined) throw new Error("drawFrom: empty list");
  return item;
}

function drawSubsetRule(tc: hegel.TestCase): RRuleSubset {
  const freq = drawFrom(tc, ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const);
  const rule: {
    freq: typeof freq;
    interval?: number;
    byday?: string[];
    count?: number;
    until?: string;
  } = { freq };

  if (drawInt(tc, 0, 1) === 1) rule.interval = drawInt(tc, 1, 6);

  if ((freq === "WEEKLY" || freq === "MONTHLY") && drawInt(tc, 0, 1) === 1) {
    const days = new Set<string>();
    const n = drawInt(tc, 1, 3);
    for (let i = 0; i < n; i++) days.add(drawFrom(tc, WEEKDAYS));
    rule.byday =
      freq === "MONTHLY" && drawInt(tc, 0, 1) === 1
        ? [...days].map((d) => `${drawInt(tc, 1, 4)}${d}`)
        : [...days];
  }

  // COUNT|UNTIL are mutually exclusive; sometimes neither (unbounded).
  const bound = drawInt(tc, 0, 2);
  if (bound === 0) rule.count = drawInt(tc, 1, 40);
  if (bound === 1) rule.until = `${drawInt(tc, 2027, 2030)}-06-15T12:00:00`;
  return rule;
}

function drawStartLocal(tc: hegel.TestCase): string {
  // Day clamped ≤ 28 so MONTHLY/YEARLY rules never skip months; minutes/seconds
  // exercised so time-of-day is a real (not round) value.
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = drawInt(tc, 2025, 2027);
  const mo = drawInt(tc, 1, 12);
  const d = drawInt(tc, 1, 28);
  const h = drawInt(tc, 0, 23);
  const mi = drawInt(tc, 0, 59);
  const s = drawInt(tc, 0, 59);
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
}

test("round-trip: subset-rule → RRULE text → subset-rule is the identity", () =>
  hegel.test((tc) => {
    const rule = drawSubsetRule(tc);
    const text = formatRRule(rule);
    const reparsed = parseRRule(text);
    if (JSON.stringify(reparsed) !== JSON.stringify(rule)) {
      throw new Error(
        `round-trip drift: ${JSON.stringify(rule)} → "${text}" → ${JSON.stringify(reparsed)}`,
      );
    }
    // And serialization is canonical: a second trip is bit-identical.
    if (formatRRule(reparsed) !== text) {
      throw new Error(`non-canonical serialization: "${text}" vs "${formatRRule(reparsed)}"`);
    }
  }, propertySettings));

test("wall-clock stability: every occurrence keeps the local time-of-day, across DST", () =>
  hegel.test((tc) => {
    const rule = drawSubsetRule(tc);
    const startLocal = drawStartLocal(tc);
    const tzid = drawFrom(tc, ZONES);
    const start = Temporal.PlainDateTime.from(startLocal);

    const occurrences = expandOccurrences(
      {
        startLocal,
        endLocal: start.add({ minutes: drawInt(tc, 15, 480) }).toString(),
        tzid,
        rrule: formatRRule(rule),
        exdates: [],
      },
      50,
    );

    if (rule.count !== undefined && occurrences.length > rule.count) {
      throw new Error(`COUNT=${rule.count} exceeded: ${occurrences.length}`);
    }

    let previousInstant: Temporal.Instant | null = null;
    for (const occ of occurrences) {
      const local = Temporal.PlainDateTime.from(occ.startLocal);
      // THE §9 property: same local time-of-day as the series start, in every zone,
      // straddling every DST transition the expansion crosses.
      if (
        local.hour !== start.hour ||
        local.minute !== start.minute ||
        local.second !== start.second
      ) {
        throw new Error(
          `local time-of-day drifted: series starts ${startLocal}, occurrence at ${occ.startLocal} (${tzid})`,
        );
      }
      if (occ.startUtc === null) throw new Error("tzid was set; expected a derived instant");
      const instant = Temporal.Instant.from(occ.startUtc);
      if (previousInstant !== null && Temporal.Instant.compare(instant, previousInstant) <= 0) {
        throw new Error(`derived instants not strictly increasing at ${occ.startLocal} (${tzid})`);
      }
      previousInstant = instant;
    }
  }, propertySettings));
