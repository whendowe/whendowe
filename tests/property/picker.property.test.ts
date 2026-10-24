// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Temporal } from "temporal-polyfill";
import { describe, expect, test } from "vitest";
import { eventFieldsSchema } from "../../src/events/event.js";
import { validateCandidates } from "../../src/events/poll.js";
import { eventInputFromForm, pollInputFromForm } from "../../src/web/routes/events.js";
import { propertySettings } from "./budget.js";
import { loadPicker, type Pick, type Poll, type Row } from "./picker-script.js";

// The picker's properties (DESIGN §9 rc17), over the script exactly as it ships.
// - Calendar shape: whole Monday-to-Sunday weeks holding exactly the month, with ISO
//   week numbers, for any month from 1900 to 2200.
// - Pick and poll round-trips through the plain fields the form carries.
// - Client–server agreement: whatever the picker writes, the server's own form
//   parsing and validation accept, and read as the same event or candidates.

const picker = loadPicker();
const MAX_CANDIDATES = 10;
const ZONE = "Europe/Prague";
const FIRST = Temporal.PlainDate.from("1900-01-01");
const SPAN = FIRST.until(Temporal.PlainDate.from("2200-12-31")).days;

// Small draw helpers over the stable primitive (integers), as elsewhere in this suite.
function drawInt(tc: hegel.TestCase, min: number, max: number): number {
  return tc.draw(gs.integers({ minValue: min, maxValue: max }));
}
const pad = (n: number) => String(n).padStart(2, "0");
const day = (k: string) => Temporal.PlainDate.from(k);
function drawDate(tc: hegel.TestCase): string {
  return FIRST.add({ days: drawInt(tc, 0, SPAN) }).toString();
}
function drawTime(tc: hegel.TestCase): string {
  return `${pad(drawInt(tc, 0, 23))}:${pad(drawInt(tc, 0, 59))}`;
}
/** Picks as the picker itself holds them: an all-day pick carries the default time. */
function drawPick(tc: hegel.TestCase): Pick {
  const date = drawDate(tc);
  switch (drawInt(tc, 0, 2)) {
    case 0:
      return { date, to: date, time: drawTime(tc), length: drawInt(tc, 1, 3 * 1440) };
    case 1:
      return { date, to: date, time: "19:00", length: "allday" };
    default:
      return {
        date,
        to: day(date)
          .add({ days: drawInt(tc, 1, 60) })
          .toString(),
        time: "19:00",
        length: "days",
      };
  }
}

/** A poll as the picker can hold one: distinct options, at most the server's limit. */
function drawPoll(tc: hegel.TestCase): Poll {
  const n = drawInt(tc, 1, MAX_CANDIDATES);
  if (drawInt(tc, 0, 1) === 0) {
    const days = new Map<string, { from: string; to: string }>();
    for (let i = 0; i < n; i++) {
      const from = drawDate(tc);
      const to = day(from)
        .add({ days: drawInt(tc, 0, 14) })
        .toString();
      days.set(`${from}/${to}`, { from, to });
    }
    return { kind: "days", start: "19:00", length: 180, times: [], days: [...days.values()] };
  }
  const start = drawTime(tc);
  const times = new Map<string, { date: string; own: string | null }>();
  const base = drawDate(tc);
  for (let i = 0; i < n; i++) {
    // Close dates, so that several times on one day are common.
    const date = day(base)
      .add({ days: drawInt(tc, 0, 6) })
      .toString();
    const own = drawInt(tc, 0, 1) === 0 ? null : drawTime(tc);
    const effective = own ?? start;
    times.set(`${date}/${effective}`, { date, own: own === start ? null : own });
  }
  return {
    kind: "times",
    start,
    length: drawInt(tc, 15, 12 * 60),
    times: [...times.values()],
    days: [],
  };
}

function minutesBetween(a: string, b: string): number {
  return Temporal.PlainDateTime.from(a).until(Temporal.PlainDateTime.from(b), {
    largestUnit: "minutes",
  }).minutes;
}

/** The form as a browser submits it: a checked box sends "on", an unchecked one nothing. */
function form(allDay: boolean, fields: Record<string, string>): Record<string, unknown> {
  return {
    title: "Session",
    description: "",
    location: "",
    tzid: ZONE,
    repeat: "",
    until: "",
    ...(allDay ? { allDay: "on" } : {}),
    ...fields,
  };
}

/** What the server must store for a row: seconds on times, an exclusive end on days. */
function expected(allDay: boolean, row: Row) {
  return allDay
    ? {
        startLocal: row.start.slice(0, 10),
        endLocal: day(row.end.slice(0, 10)).add({ days: 1 }).toString(),
      }
    : { startLocal: `${row.start}:00`, endLocal: `${row.end}:00` };
}

describe("calendar shape", () => {
  test("any month 1900–2200: whole Monday-to-Sunday weeks, consecutive, exactly the month", () =>
    hegel.test((tc) => {
      const year = drawInt(tc, 1900, 2200);
      const month = drawInt(tc, 0, 11);
      const weeks = picker.monthGrid(year, month);
      const keys = weeks.flatMap((w) => w.days.map((d) => d.key));
      expect(weeks.every((w) => w.days.length === 7)).toBe(true);
      expect(day(keys[0] ?? "").dayOfWeek).toBe(1);
      expect(day(keys[keys.length - 1] ?? "").dayOfWeek).toBe(7);
      for (let i = 1; i < keys.length; i++) {
        expect(
          day(keys[i - 1] ?? "")
            .add({ days: 1 })
            .toString(),
        ).toBe(keys[i]);
      }
      const first = Temporal.PlainDate.from({ year, month: month + 1, day: 1 });
      const inMonth = weeks.flatMap((w) => w.days.filter((d) => d.inMonth).map((d) => d.key));
      expect(inMonth).toEqual(
        Array.from({ length: first.daysInMonth }, (_, i) => first.add({ days: i }).toString()),
      );
      // No week is borrowed whole: the grid is the fewest weeks that hold the month.
      for (const w of weeks) expect(w.days.some((d) => d.inMonth)).toBe(true);
      // A borrowed day is never marked as the month's, and vice versa.
      for (const d of weeks.flatMap((w) => w.days)) {
        expect(d.inMonth).toBe(day(d.key).month === month + 1);
      }
      for (const w of weeks) expect(w.week).toBe(day(w.days[0]?.key ?? "").weekOfYear);
    }, propertySettings));

  test("week numbers equal ISO 8601's for any day 1900–2200", () =>
    hegel.test((tc) => {
      const key = drawDate(tc);
      expect(picker.isoWeek(key)).toBe(day(key).weekOfYear);
    }, propertySettings));
});

describe("event picks and the plain fields", () => {
  test("any pick → fields → the same pick", () =>
    hegel.test((tc) => {
      const pick = drawPick(tc);
      const fields = picker.toFields(pick);
      expect(picker.fromFields(fields, drawDate(tc))).toEqual(pick);
    }, propertySettings));

  test("a timed pick ends exactly its length later, and the summary names a later end day", () =>
    hegel.test((tc) => {
      const pick = drawPick(tc);
      if (typeof pick.length !== "number") return;
      const fields = picker.toFields(pick);
      expect(fields.allDay).toBe(false);
      expect(minutesBetween(fields.start, fields.end)).toBe(pick.length);
      const endDay = fields.end.slice(0, 10);
      const { main } = picker.summary(pick);
      expect(main.includes("(ends ")).toBe(endDay > pick.date);
    }, propertySettings));

  test("whatever the event picker writes, the server accepts and reads as the same event", () =>
    hegel.test((tc) => {
      const pick = drawPick(tc);
      const f = picker.toFields(pick);
      const parsed = eventFieldsSchema.safeParse(
        eventInputFromForm(form(f.allDay, { start: f.start, end: f.end })),
      );
      if (!parsed.success) {
        throw new Error(`refused ${JSON.stringify(f)}: ${parsed.error.issues[0]?.message}`);
      }
      expect(parsed.data.allDay).toBe(f.allDay);
      expect({ startLocal: parsed.data.startLocal, endLocal: parsed.data.endLocal }).toEqual(
        expected(f.allDay, f),
      );
    }, propertySettings));
});

describe("polls and the numbered rows", () => {
  test("any poll → rows: one per option, sorted, distinct; rows → poll → the same rows", () =>
    hegel.test((tc) => {
      const poll = drawPoll(tc);
      const rows = picker.pollRows(poll);
      const options = poll.kind === "days" ? poll.days.length : poll.times.length;
      expect(rows).toHaveLength(options);
      const keys = rows.map((r) => `${r.start}/${r.end}`);
      expect(new Set(keys).size).toBe(rows.length);
      expect(keys).toEqual([...keys].sort());
      expect(picker.pollRows(picker.pollFromRows(poll.kind === "days", rows))).toEqual(rows);
    }, propertySettings));

  test("whatever the poll picker writes, the server accepts and reads as the same candidates", () =>
    hegel.test((tc) => {
      const poll = drawPoll(tc);
      const rows = picker.pollRows(poll);
      tc.assume(rows.length >= 2); // the server's minimum; one option is not a poll
      const allDay = poll.kind === "days";
      const slots: Record<string, string> = {};
      rows.forEach((r, i) => {
        slots[`start_${i}`] = r.start;
        slots[`end_${i}`] = r.end;
      });
      const input = pollInputFromForm(form(allDay, slots));
      let candidates: ReturnType<typeof validateCandidates>;
      try {
        candidates = validateCandidates(input.fields, input.candidates);
      } catch (error) {
        throw new Error(`refused ${JSON.stringify(rows)}: ${String(error)}`);
      }
      expect(candidates.map((c) => ({ startLocal: c.startLocal, endLocal: c.endLocal }))).toEqual(
        rows.map((r) => expected(allDay, r)),
      );
    }, propertySettings));
});
