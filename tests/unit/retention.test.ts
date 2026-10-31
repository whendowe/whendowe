// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  type EventForRetention,
  isEventDue,
  isPlanDue,
  isRetentionMinute,
  lastDay,
} from "../../src/privacy/retention.js";

// Which rows are due (DESIGN §10 rc21 *Retention*). The rule that matters: never early,
// in any zone. A period of N days is due once N whole days have passed after the last
// local day, plus one for zones.

const one: EventForRetention = {
  startLocal: "2101-11-20T18:00",
  endLocal: "2101-11-20T20:00",
  allDay: false,
  tzid: "Europe/Prague",
  rrule: null,
  status: "scheduled",
  updatedAt: "2101-11-01T10:00:00.000Z",
  retainDays: 30,
};

describe("the last day an event touches", () => {
  it("a one-off: its end; all-day ends are exclusive", () => {
    expect(lastDay(one)?.toString()).toBe("2101-11-20");
    expect(
      lastDay({
        ...one,
        allDay: true,
        startLocal: "2101-11-20",
        endLocal: "2101-11-22",
      })?.toString(),
    ).toBe("2101-11-21");
  });

  it("a series: its last occurrence, by COUNT or UNTIL", () => {
    expect(lastDay({ ...one, rrule: "FREQ=WEEKLY;COUNT=3" })?.toString()).toBe("2101-12-04");
    // The last start is on or before UNTIL; it ends an event-length later.
    expect(lastDay({ ...one, rrule: "FREQ=WEEKLY;UNTIL=21011231T230000" })?.toString()).toBe(
      "2102-01-01",
    );
  });

  it("a series too long to walk is bounded above, never below", () => {
    // 1000 weekly: the real last is 999 weeks on; the bound may be later, never earlier.
    const last = lastDay({ ...one, rrule: "FREQ=WEEKLY;COUNT=1000" });
    expect((last?.toString() ?? "") >= "2121-01-01").toBe(true);
  });

  it("an endless series never ends, until it is cancelled", () => {
    expect(lastDay({ ...one, rrule: "FREQ=WEEKLY" })).toBeNull();
    expect(lastDay({ ...one, rrule: "FREQ=WEEKLY", status: "cancelled" })?.toString()).toBe(
      "2101-11-01",
    );
  });
});

describe("when it's due", () => {
  it("not before its period plus a day for time zones, then at once", () => {
    // Last day Nov 20, 30 days: Dec 20 + 1 margin = Dec 21; due from Dec 22 (UTC).
    expect(isEventDue(one, "2101-12-21T23:59:59.000Z")).toBe(false);
    expect(isEventDue(one, "2101-12-22T00:00:00.000Z")).toBe(true);
    expect(isEventDue({ ...one, retainDays: 365 }, "2101-12-22T00:00:00.000Z")).toBe(false);
    expect(isEventDue({ ...one, rrule: "FREQ=WEEKLY" }, "2999-01-01T00:00:00.000Z")).toBe(false);
  });

  it("a plan: twelve months after its last day, and an accepted one only once its events have gone", () => {
    const plan = {
      lastEndLocal: "2101-11-14",
      allDay: true,
      createdAt: "2101-11-01T10:00:00.000Z",
      liveEvents: 0,
    };
    // Last day Nov 13 (exclusive end); + 365 + 1 = 2102-11-14.
    expect(isPlanDue(plan, "2102-11-14T12:00:00.000Z")).toBe(false);
    expect(isPlanDue(plan, "2102-11-15T00:00:00.000Z")).toBe(true);
    expect(isPlanDue({ ...plan, liveEvents: 1 }, "2999-01-01T00:00:00.000Z")).toBe(false);
    // No events: from the day it was made.
    expect(isPlanDue({ ...plan, lastEndLocal: null }, "2102-11-03T00:00:00.000Z")).toBe(true);
  });

  it("the retention pass runs once an hour", () => {
    expect(isRetentionMinute("2101-11-01T10:07:30.000Z")).toBe(true);
    expect(isRetentionMinute("2101-11-01T10:08:00.000Z")).toBe(false);
  });
});
