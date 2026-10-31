// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Temporal } from "temporal-polyfill";
import { test } from "vitest";
import { type EventForRetention, isEventDue, lastDay } from "../../src/privacy/retention.js";
import { expandOccurrences, formatRRule, MAX_OCCURRENCES } from "../../src/recurrence.js";
import { propertySettings } from "./budget.js";

// Retention's promise to the people in an event (DESIGN §10 rc21): their event is kept
// for its whole period, wherever they are. So whenever the pass says an event is due,
// in EVERY time zone — the furthest ahead and the furthest behind UTC — the period has
// already passed since the last day any occurrence touches.

/** Enough to cover every short series (COUNT ≤ 60), and cheap at the soak budget. */
const REFERENCE = 60;

const EXTREMES = ["Pacific/Kiritimati", "Etc/GMT+12", "UTC"]; // +14h, −12h

function drawInt(tc: hegel.TestCase, min: number, max: number): number {
  return tc.draw(gs.integers({ minValue: min, maxValue: max }));
}

function drawFrom<T>(tc: hegel.TestCase, items: readonly T[]): T {
  const item = items[drawInt(tc, 0, items.length - 1)];
  if (item === undefined) throw new Error("drawFrom: empty list");
  return item;
}

function drawEvent(tc: hegel.TestCase): EventForRetention {
  const pad = (n: number) => String(n).padStart(2, "0");
  const allDay = drawInt(tc, 0, 1) === 1;
  const day = Temporal.PlainDate.from(
    `${drawInt(tc, 2101, 2102)}-${pad(drawInt(tc, 1, 12))}-${pad(drawInt(tc, 1, 28))}`,
  );
  const start = allDay
    ? day.toString()
    : `${day}T${pad(drawInt(tc, 0, 23))}:${pad(drawInt(tc, 0, 59))}`;
  const end = allDay
    ? day.add({ days: drawInt(tc, 1, 10) }).toString()
    : Temporal.PlainDateTime.from(start)
        .add({ minutes: drawInt(tc, 15, 3000) })
        .toString();
  const freq = drawFrom(tc, ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const);
  const bound = drawInt(tc, 0, 3);
  const rrule =
    bound === 0
      ? null
      : formatRRule({
          freq,
          ...(drawInt(tc, 0, 1) === 1 ? { interval: drawInt(tc, 1, 4) } : {}),
          ...(bound === 1
            ? { count: drawInt(tc, 1, 60) }
            : bound === 2
              ? { count: drawInt(tc, MAX_OCCURRENCES + 1, 1000) }
              : { until: `${drawInt(tc, 2102, 2104)}-${pad(drawInt(tc, 1, 12))}-15T12:00:00` }),
        });
  return {
    startLocal: start,
    endLocal: end,
    allDay,
    tzid: allDay ? null : "Europe/Prague",
    rrule,
    status: "scheduled",
    updatedAt: "2101-01-01T00:00:00.000Z",
    retainDays: drawFrom(tc, [1, 30, 365]),
  };
}

test("never early: when an event is due, its period has passed in every time zone", () =>
  hegel.test((tc) => {
    const e = drawEvent(tc);
    const last = lastDay(e);
    if (last === null) throw new Error("a bounded event always has a last day");
    // Every occurrence we enumerate ends on or before that last day: all of a short
    // series, the start of a long one (the bound for those is by construction).
    const occurrences = expandOccurrences(
      { startLocal: e.startLocal, endLocal: e.endLocal, tzid: e.tzid, rrule: e.rrule, exdates: [] },
      REFERENCE,
    );
    // A COUNT series' true last occurrence, exactly: the generator draws no BYDAY and
    // days ≤ 28, so the n-th start is the first plus (n−1)·interval periods.
    if (e.rrule !== null && /COUNT=(\d+)/.test(e.rrule)) {
      const count = Number(/COUNT=(\d+)/.exec(e.rrule)?.[1]);
      const interval = Number(/INTERVAL=(\d+)/.exec(e.rrule)?.[1] ?? "1");
      const unit = { DAILY: "days", WEEKLY: "weeks", MONTHLY: "months", YEARLY: "years" } as const;
      const freq = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.exec(e.rrule)?.[1];
      if (freq === "DAILY" || freq === "WEEKLY" || freq === "MONTHLY" || freq === "YEARLY") {
        const step = { [unit[freq]]: (count - 1) * interval };
        // Step the START, then add the event's length: months differ in length, so
        // stepping the end instead would drift.
        const first = Temporal.PlainDateTime.from(e.startLocal);
        const length = first.until(Temporal.PlainDateTime.from(e.endLocal));
        const end = first.add(step).add(length).toPlainDate();
        const lastTouched = e.allDay ? end.subtract({ days: 1 }) : end;
        if (Temporal.PlainDate.compare(lastTouched, last) > 0) {
          throw new Error(
            `COUNT=${count}: the last occurrence touches ${lastTouched}, after ${last}: ${JSON.stringify(e)}`,
          );
        }
      }
    }
    for (const o of occurrences) {
      const touches = Temporal.PlainDateTime.from(o.endLocal).toPlainDate();
      const lastTouched = e.allDay ? touches.subtract({ days: 1 }) : touches;
      if (Temporal.PlainDate.compare(lastTouched, last) > 0) {
        throw new Error(`occurrence ending ${o.endLocal} is after the last day ${last}`);
      }
    }
    // A moment near the boundary, to the minute.
    const now = Temporal.PlainDateTime.from(`${last.add({ days: e.retainDays - 2 })}T00:00`)
      .add({ minutes: drawInt(tc, 0, 5 * 24 * 60) })
      .toZonedDateTime("UTC");
    const nowIso = now.toInstant().toString();
    if (!isEventDue(e, nowIso)) return;
    for (const zone of EXTREMES) {
      const today = now.withTimeZone(zone).toPlainDate();
      if (Temporal.PlainDate.compare(last.add({ days: e.retainDays }), today) >= 0) {
        throw new Error(
          `due at ${nowIso}, but in ${zone} it is ${today}: ${e.retainDays} days after ${last} haven't passed`,
        );
      }
    }
  }, propertySettings));
