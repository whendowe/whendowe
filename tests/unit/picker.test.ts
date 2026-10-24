// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { pickerAssets } from "../../src/web/picker.js";
import { loadPicker, type Pick, type Poll } from "../property/picker-script.js";

// The picker's date logic, by example. The shipped script is loaded by
// tests/property/picker-script.ts; the properties over the same logic live in
// tests/property/picker.property.test.ts (DESIGN §9 rc17).

const picker = loadPicker();

describe("the shipped script", () => {
  it("holds nothing a tagged template would cook (backslash, backtick, dollar-brace)", () => {
    const assets = pickerAssets().value;
    expect(assets).not.toMatch(/[\\`]|\$\{/);
  });
});

describe("monthGrid: whole Monday-to-Sunday weeks", () => {
  it("every month of 2026–2030 starts on a Monday, ends on a Sunday and contains all its days", () => {
    for (let year = 2026; year <= 2030; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const weeks = picker.monthGrid(year, month);
        const days = weeks.flatMap((w) => w.days);
        expect(weeks.every((w) => w.days.length === 7)).toBe(true);
        const first = days[0];
        const last = days[days.length - 1];
        if (first === undefined || last === undefined) throw new Error("empty grid");
        expect(new Date(`${first.key}T00:00:00Z`).getUTCDay()).toBe(1);
        expect(new Date(`${last.key}T00:00:00Z`).getUTCDay()).toBe(0);
        const inMonth = days.filter((d) => d.inMonth).map((d) => d.key);
        const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        expect(inMonth).toHaveLength(length);
        expect(inMonth[0]).toBe(`${year}-${String(month + 1).padStart(2, "0")}-01`);
        // consecutive days, no gaps and no repeats across the borrowed edges
        for (let i = 1; i < days.length; i += 1) {
          const prev = days[i - 1];
          const cur = days[i];
          if (prev === undefined || cur === undefined) throw new Error("hole");
          expect(Date.parse(cur.key) - Date.parse(prev.key)).toBe(86_400_000);
        }
      }
    }
  });

  it("fills the edges from the neighbouring months: October 2026", () => {
    const weeks = picker.monthGrid(2026, 9);
    const keys = weeks.flatMap((w) => w.days.map((d) => d.key));
    expect(keys[0]).toBe("2026-09-28");
    expect(keys[keys.length - 1]).toBe("2026-11-01");
    expect(weeks.map((w) => w.week)).toEqual([40, 41, 42, 43, 44]);
  });

  it("numbers weeks by ISO 8601, including week 53 and the turn of the year", () => {
    expect(picker.isoWeek("2026-12-28")).toBe(53);
    expect(picker.isoWeek("2027-01-03")).toBe(53);
    expect(picker.isoWeek("2027-01-04")).toBe(1);
    expect(picker.isoWeek("2024-12-30")).toBe(1);
  });
});

describe("picks and the plain fields the server reads", () => {
  const cases: readonly {
    name: string;
    pick: Pick;
    fields: { allDay: boolean; start: string; end: string };
  }[] = [
    {
      name: "an evening",
      pick: { date: "2026-10-30", to: "2026-10-30", time: "19:00", length: 180 },
      fields: { allDay: false, start: "2026-10-30T19:00", end: "2026-10-30T22:00" },
    },
    {
      name: "past midnight",
      pick: { date: "2026-10-30", to: "2026-10-30", time: "22:30", length: 120 },
      fields: { allDay: false, start: "2026-10-30T22:30", end: "2026-10-31T00:30" },
    },
    {
      name: "a length that is not a preset",
      pick: { date: "2026-10-30", to: "2026-10-30", time: "18:15", length: 75 },
      fields: { allDay: false, start: "2026-10-30T18:15", end: "2026-10-30T19:30" },
    },
    {
      name: "one whole day",
      pick: { date: "2026-10-31", to: "2026-10-31", time: "19:00", length: "allday" },
      fields: { allDay: true, start: "2026-10-31T00:00", end: "2026-10-31T00:00" },
    },
    {
      name: "a stretch across the month boundary",
      pick: { date: "2026-10-31", to: "2026-11-02", time: "19:00", length: "days" },
      fields: { allDay: true, start: "2026-10-31T00:00", end: "2026-11-02T00:00" },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: writes the fields, and reads them back as the same pick`, () => {
      expect(picker.toFields(c.pick)).toEqual(c.fields);
      expect(picker.fromFields(c.fields, "2026-01-01")).toEqual(c.pick);
    });
  }

  it("an empty form starts today at 19:00 for an hour", () => {
    expect(picker.fromFields({ allDay: false, start: "", end: "" }, "2026-10-24")).toEqual({
      date: "2026-10-24",
      to: "2026-10-24",
      time: "19:00",
      length: 60,
    });
  });

  it("an end before the start falls back to an hour instead of a negative length", () => {
    const p = picker.fromFields(
      { allDay: false, start: "2026-10-30T19:00", end: "2026-10-30T18:00" },
      "2026-01-01",
    );
    expect(p.length).toBe(60);
  });
});

describe("summary", () => {
  it("names the weekday, the times and the length", () => {
    expect(
      picker.summary({ date: "2026-10-30", to: "2026-10-30", time: "19:00", length: 180 }),
    ).toEqual({ main: "Fri 30 Oct · 19:00–22:00", sub: "3 h" });
  });
  it("says which day an evening ends on when it runs past midnight", () => {
    expect(
      picker.summary({ date: "2026-10-30", to: "2026-10-30", time: "23:00", length: 90 }).main,
    ).toBe("Fri 30 Oct · 23:00–00:30 (ends Sat 31 Oct)");
  });
  it("counts days and nights for a stretch", () => {
    expect(
      picker.summary({ date: "2026-10-30", to: "2026-11-01", time: "19:00", length: "days" }),
    ).toEqual({ main: "Fri 30 Oct – Sun 1 Nov", sub: "3 days, 2 nights, all day" });
  });
});

describe("polls and the numbered rows the server reads", () => {
  it("times: several on one day, sorted, each from the shared start unless it has its own", () => {
    const poll: Poll = {
      kind: "times",
      start: "18:00",
      length: 180,
      times: [
        { date: "2026-10-31", own: null },
        { date: "2026-10-30", own: "20:30" },
        { date: "2026-10-30", own: null },
      ],
      days: [],
    };
    const rows = picker.pollRows(poll);
    expect(rows).toEqual([
      { start: "2026-10-30T18:00", end: "2026-10-30T21:00" },
      { start: "2026-10-30T20:30", end: "2026-10-30T23:30" },
      { start: "2026-10-31T18:00", end: "2026-10-31T21:00" },
    ]);
    expect(picker.pollRows(picker.pollFromRows(false, rows))).toEqual(rows);
  });

  it("days: overlapping stretches survive, ordered by first then last day", () => {
    const poll: Poll = {
      kind: "days",
      start: "19:00",
      length: 180,
      times: [],
      days: [
        { from: "2026-11-07", to: "2026-11-15" }, // the whole camp
        { from: "2026-11-11", to: "2026-11-15" }, // Wednesday to Sunday
        { from: "2026-11-07", to: "2026-11-11" }, // Saturday to Wednesday
      ],
    };
    const rows = picker.pollRows(poll);
    expect(rows).toEqual([
      { start: "2026-11-07T00:00", end: "2026-11-11T00:00" },
      { start: "2026-11-07T00:00", end: "2026-11-15T00:00" },
      { start: "2026-11-11T00:00", end: "2026-11-15T00:00" },
    ]);
    const back = picker.pollFromRows(true, [...rows, { start: "", end: "" }]);
    expect(back.kind).toBe("days");
    expect(back.days).toHaveLength(3);
    expect(picker.pollRows(back)).toEqual(rows);
  });

  it("empty rows are not options", () => {
    const back = picker.pollFromRows(false, [
      { start: "", end: "" },
      { start: "2026-10-30T19:00", end: "2026-10-30T22:00" },
    ]);
    expect(back.times).toEqual([{ date: "2026-10-30", own: null }]);
    expect(back.start).toBe("19:00");
    expect(back.length).toBe(180);
  });
});
