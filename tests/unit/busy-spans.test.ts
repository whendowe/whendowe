// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { busyFromSpans, rangeOf } from "../../src/feeds/busy.js";

// Busy spans from elsewhere (Google's free/busy, DESIGN §10 rc41) become the picker's
// wall-clock spans in the asker's zone; the days asked become the instants to ask for.

it("asks from the first day's midnight to the midnight after the last, in the asker's zone", () => {
  expect(rangeOf({ from: "2026-09-14", to: "2026-09-20", tz: "Europe/Prague" })).toEqual({
    start: "2026-09-13T22:00:00Z",
    end: "2026-09-20T22:00:00Z",
  });
  // Across the clocks going back: the last day is 25 hours long.
  expect(rangeOf({ from: "2026-10-25", to: "2026-10-25", tz: "Europe/Prague" })).toEqual({
    start: "2026-10-24T22:00:00Z",
    end: "2026-10-25T23:00:00Z",
  });
});

it("puts each span in the asker's zone, to the minute, whatever offset Google wrote", () => {
  expect(
    busyFromSpans(
      [
        { start: "2026-09-15T08:00:00Z", end: "2026-09-15T09:30:45Z" },
        { start: "2026-09-15T23:00:00+02:00", end: "2026-09-16T01:00:00+02:00" },
      ],
      "America/New_York",
    ),
  ).toEqual([
    { allDay: false, start: "2026-09-15T04:00", end: "2026-09-15T05:30" },
    { allDay: false, start: "2026-09-15T17:00", end: "2026-09-15T19:00" },
  ]);
});

it("drops a span that isn't two times, or doesn't move forward", () => {
  expect(
    busyFromSpans(
      [
        { start: "tomorrow", end: "2026-09-15T09:00:00Z" },
        { start: "2026-09-15T08:00:00Z", end: "" },
        { start: "2026-09-15T09:00:00Z", end: "2026-09-15T09:00:00Z" },
        { start: "2026-09-15T10:00:00Z", end: "2026-09-15T09:00:00Z" },
        { start: "2026-09-15T10:00:00Z", end: "2026-09-15T10:01:00Z" },
      ],
      "UTC",
    ),
  ).toEqual([{ allDay: false, start: "2026-09-15T10:00", end: "2026-09-15T10:01" }]);
});
