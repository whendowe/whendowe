// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import type { Busy } from "../../src/feeds/busy.js";
import { clashes } from "../../src/following/whats-on.js";

// When a followed event clashes with something of yours (DESIGN §10 rc58): instants for times,
// days for all-day ones; touching ends don't overlap.

const timed = (startUtc: string, endUtc: string, date = startUtc.slice(0, 10)) => ({
  allDay: false,
  startLocal: `${date}T00:00:00`,
  endLocal: `${date}T00:00:00`,
  startUtc,
  endUtc,
});
const days = (first: string, afterLast: string) => ({
  allDay: true,
  startLocal: `${first}T00:00:00`,
  endLocal: `${afterLast}T00:00:00`,
  startUtc: null,
  endUtc: null,
});
const span = (start: string, end: string): Busy => ({ allDay: false, start, end });
const whole = (from: string, to: string): Busy => ({ allDay: true, from, to });

it("a time clashes with a time it overlaps, not one it only touches", () => {
  const social = timed("2026-11-26T18:00:00Z", "2026-11-26T21:00:00Z");
  expect(clashes(social, [span("2026-11-26T20:00", "2026-11-26T22:00")])).toBe(true);
  expect(clashes(social, [span("2026-11-26T17:00", "2026-11-26T18:01")])).toBe(true);
  expect(clashes(social, [span("2026-11-26T19:00", "2026-11-26T19:30")])).toBe(true);
  expect(clashes(social, [span("2026-11-26T17:00", "2026-11-26T18:00")])).toBe(false);
  expect(clashes(social, [span("2026-11-26T21:00", "2026-11-26T23:00")])).toBe(false);
  expect(clashes(social, [])).toBe(false);
});

it("a moment with no length clashes with what is going on then", () => {
  const moment = timed("2026-11-26T18:00:00Z", "2026-11-26T18:00:00Z");
  expect(clashes(moment, [span("2026-11-26T18:00", "2026-11-26T19:00")])).toBe(true);
  expect(clashes(moment, [span("2026-11-26T17:00", "2026-11-26T18:00")])).toBe(false);
  expect(clashes(moment, [span("2026-11-26T18:01", "2026-11-26T19:00")])).toBe(false);
});

it("a time clashes with a whole day of yours on its own date", () => {
  // 00:30 in Prague on the 27th is the 26th in UTC: its own date is what counts.
  const late = timed("2026-11-26T23:30:00Z", "2026-11-27T01:00:00Z", "2026-11-27");
  expect(clashes(late, [whole("2026-11-27", "2026-11-27")])).toBe(true);
  expect(clashes(late, [whole("2026-11-25", "2026-11-26")])).toBe(false);
  expect(clashes(late, [whole("2026-11-27", "2026-11-30")])).toBe(true);
});

it("an all-day event clashes with a whole day of yours, and nothing shorter", () => {
  const fest = days("2026-11-28", "2026-11-30"); // the 28th and 29th
  expect(clashes(fest, [whole("2026-11-29", "2026-11-29")])).toBe(true);
  expect(clashes(fest, [whole("2026-11-27", "2026-11-28")])).toBe(true);
  expect(clashes(fest, [whole("2026-11-30", "2026-12-01")])).toBe(false);
  expect(clashes(fest, [whole("2026-11-26", "2026-11-27")])).toBe(false);
  expect(clashes(fest, [span("2026-11-28T10:00", "2026-11-28T20:00")])).toBe(false);
  // A day given with no length is still its day.
  expect(clashes(days("2026-11-28", "2026-11-28"), [whole("2026-11-28", "2026-11-28")])).toBe(true);
});
