// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  expandOccurrences,
  formatRRule,
  MAX_OCCURRENCES,
  MAX_SCAN,
  parseRRule,
  upcomingOccurrences,
} from "../../src/recurrence.js";

describe("parseRRule — validated subset boundary (§10)", () => {
  it("parses the full subset", () => {
    expect(parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10")).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byday: ["MO", "WE"],
      count: 10,
    });
  });

  it("parses UNTIL as a local (zone-less) datetime", () => {
    expect(parseRRule("FREQ=DAILY;UNTIL=20261231T090000")).toEqual({
      freq: "DAILY",
      until: "2026-12-31T09:00:00",
    });
    expect(parseRRule("FREQ=DAILY;UNTIL=20261231")).toEqual({
      freq: "DAILY",
      until: "2026-12-31T23:59:59",
    });
  });

  it("round-trips through formatRRule", () => {
    const text = "FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR;UNTIL=20271224T180000";
    expect(formatRRule(parseRRule(text))).toBe(text);
  });

  it.each([
    ["FREQ=HOURLY;COUNT=3", /outside the validated subset|invalid/i],
    ["FREQ=WEEKLY;BYSETPOS=1", /outside the validated subset/i],
    ["FREQ=DAILY;UNTIL=20261231T090000Z", /outside the validated subset/i],
    ["FREQ=DAILY;COUNT=3;UNTIL=20261231T090000", /mutually exclusive/i],
    ["FREQ=DAILY;COUNT=3;COUNT=4", /duplicate/i],
    ["FREQ=WEEKLY;BYDAY=1MO", /only valid with FREQ=MONTHLY/i],
    ["FREQ=WEEKLY;COUNT=abc", /malformed COUNT/i],
    ["JUNK", /malformed RRULE part/i],
  ])("rejects %s loudly", (text, message) => {
    expect(() => parseRRule(text)).toThrow(message);
  });
});

describe("expandOccurrences — DST correctness by construction (§9/§10)", () => {
  it("spring forward (Europe/Prague 2026-03-29): local time stays 09:00, offset changes", () => {
    const occ = expandOccurrences(
      {
        startLocal: "2026-03-22T09:00:00",
        endLocal: "2026-03-22T10:00:00",
        tzid: "Europe/Prague",
        rrule: "FREQ=WEEKLY;BYDAY=SU;COUNT=3",
        exdates: [],
      },
      10,
    );
    expect(occ.map((o) => o.startLocal)).toEqual([
      "2026-03-22T09:00:00",
      "2026-03-29T09:00:00",
      "2026-04-05T09:00:00",
    ]);
    expect(occ.map((o) => o.startUtc)).toEqual([
      "2026-03-22T08:00:00Z", // CET, +01:00
      "2026-03-29T07:00:00Z", // CEST, +02:00 — the wall clock held, the instant moved
      "2026-04-05T07:00:00Z",
    ]);
  });

  it("fall back (Europe/Prague 2026-10-25): same shape in reverse", () => {
    const occ = expandOccurrences(
      {
        startLocal: "2026-10-18T09:00:00",
        endLocal: "2026-10-18T09:30:00",
        tzid: "Europe/Prague",
        rrule: "FREQ=WEEKLY;BYDAY=SU;COUNT=2",
        exdates: [],
      },
      10,
    );
    expect(occ.map((o) => o.startUtc)).toEqual([
      "2026-10-18T07:00:00Z", // CEST
      "2026-10-25T08:00:00Z", // CET
    ]);
  });

  it("a start inside the spring-forward gap keeps its authoritative local time", () => {
    const occ = expandOccurrences(
      {
        startLocal: "2026-03-28T02:30:00",
        endLocal: "2026-03-28T03:00:00",
        tzid: "Europe/Prague",
        rrule: "FREQ=DAILY;COUNT=2",
        exdates: [],
      },
      10,
    );
    // 2026-03-29T02:30 does not exist in Prague; startLocal stays canonical,
    // the derived instant shifts forward by the gap ("compatible").
    expect(occ[1]?.startLocal).toBe("2026-03-29T02:30:00");
    expect(occ[1]?.startUtc).toBe("2026-03-29T01:30:00Z");
  });

  it("no rrule ⇒ exactly the single occurrence", () => {
    const occ = expandOccurrences(
      {
        startLocal: "2026-07-06T14:00:00",
        endLocal: "2026-07-06T15:00:00",
        tzid: "Europe/Prague",
        rrule: null,
        exdates: [],
      },
      10,
    );
    expect(occ).toEqual([
      {
        startLocal: "2026-07-06T14:00:00",
        endLocal: "2026-07-06T15:00:00",
        startUtc: "2026-07-06T12:00:00Z",
        endUtc: "2026-07-06T13:00:00Z",
      },
    ]);
  });

  it("null tzid ⇒ floating: no instants derived", () => {
    const occ = expandOccurrences(
      {
        startLocal: "2026-07-06T14:00:00",
        endLocal: "2026-07-06T15:00:00",
        tzid: null,
        rrule: null,
        exdates: [],
      },
      10,
    );
    expect(occ[0]?.startUtc).toBeNull();
    expect(occ[0]?.endUtc).toBeNull();
  });

  it("exdates cancel exactly their occurrence (§10 seam — read path only)", () => {
    const occ = expandOccurrences(
      {
        startLocal: "2026-07-06T09:00:00",
        endLocal: "2026-07-06T09:30:00",
        tzid: "Europe/Prague",
        rrule: "FREQ=DAILY;COUNT=3",
        exdates: ["2026-07-07T09:00:00"],
      },
      10,
    );
    expect(occ.map((o) => o.startLocal)).toEqual(["2026-07-06T09:00:00", "2026-07-08T09:00:00"]);
  });

  it("monthly ordinal BYDAY: first Monday", () => {
    const occ = expandOccurrences(
      {
        startLocal: "2026-08-03T08:00:00", // first Monday of August 2026
        endLocal: "2026-08-03T09:00:00",
        tzid: "Europe/Prague",
        rrule: "FREQ=MONTHLY;BYDAY=1MO;COUNT=3",
        exdates: [],
      },
      10,
    );
    expect(occ.map((o) => o.startLocal)).toEqual([
      "2026-08-03T08:00:00",
      "2026-09-07T08:00:00",
      "2026-10-05T08:00:00",
    ]);
  });

  it("an unbounded rule is cut off by limit and the MAX_OCCURRENCES seatbelt", () => {
    const input = {
      startLocal: "2026-01-01T12:00:00",
      endLocal: "2026-01-01T13:00:00",
      tzid: "Europe/Prague",
      rrule: "FREQ=DAILY",
      exdates: [],
    };
    expect(expandOccurrences(input, 7)).toHaveLength(7);
    expect(expandOccurrences(input, 10_000)).toHaveLength(MAX_OCCURRENCES);
    expect(() => expandOccurrences(input, 0)).toThrow(/positive integer/);
  });
});

describe("upcomingOccurrences — what's coming up, however old the series", () => {
  const weekly = {
    startLocal: "2026-01-05T19:00:00",
    endLocal: "2026-01-05T21:00:00",
    tzid: "Europe/Prague",
    rrule: "FREQ=WEEKLY",
    exdates: [],
  };

  it("skips what has ended and returns the next ones, in order", () => {
    const next = upcomingOccurrences(weekly, "2026-03-01T12:00:00", 3);
    expect(next.map((o) => o.startLocal)).toEqual([
      "2026-03-02T19:00:00",
      "2026-03-09T19:00:00",
      "2026-03-16T19:00:00",
    ]);
  });

  it("an occurrence still under way counts as upcoming", () => {
    const [now] = upcomingOccurrences(weekly, "2026-03-02T20:00:00", 1);
    expect(now?.startLocal).toBe("2026-03-02T19:00:00");
  });

  it("respects exdates, the end of the rule, and single events", () => {
    const next = upcomingOccurrences(
      { ...weekly, rrule: "FREQ=WEEKLY;COUNT=3", exdates: ["2026-01-12T19:00:00"] },
      "2026-01-01T00:00:00",
      10,
    );
    expect(next.map((o) => o.startLocal)).toEqual(["2026-01-05T19:00:00", "2026-01-19T19:00:00"]);
    expect(
      upcomingOccurrences({ ...weekly, rrule: "FREQ=WEEKLY;COUNT=3" }, "2027-01-01T00:00:00", 5),
    ).toEqual([]);
    expect(upcomingOccurrences({ ...weekly, rrule: null }, "2026-01-01T00:00:00", 5)).toHaveLength(
      1,
    );
    expect(upcomingOccurrences({ ...weekly, rrule: null }, "2026-02-01T00:00:00", 5)).toEqual([]);
  });

  it(`walks at most MAX_SCAN (${MAX_SCAN}) starts: bounded work for any series`, () => {
    const daily = { ...weekly, rrule: "FREQ=DAILY" };
    // 2000 days from 2026-01-05 is 2031-06-28: past it, nothing, rather than unbounded work.
    expect(upcomingOccurrences(daily, "2031-07-01T00:00:00", 1)).toEqual([]);
    expect(upcomingOccurrences(daily, "2031-06-01T00:00:00", 1)).toHaveLength(1);
  });
});
