// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { goingFields } from "../../src/following/going.js";
import type { OnEvent } from "../../src/following/whats-on.js";

// Going (DESIGN §10 rc59): the fields an event of yours takes from a followed one. Going itself,
// on both drivers, is in tests/contract/whats-on.suite.ts.

const social: OnEvent = {
  calendarId: "cal",
  uid: "social",
  title: "Social",
  location: "Hall",
  description: "Bring shoes.",
  url: "https://club.example/s",
  startLocal: "2026-11-26T19:00:00",
  endLocal: "2026-11-26T22:00:00",
  tzid: "Europe/Prague",
  allDay: false,
  startUtc: "2026-11-26T18:00:00Z",
  endUtc: "2026-11-26T21:00:00Z",
  calendarName: "Lindy Hop",
  calendarUrl: "https://club.example/c.ics",
  colour: "f1",
  clashes: false,
  going: null,
};

it("takes the title, place, description and time; not the link", () => {
  expect(goingFields(social)).toEqual({
    title: "Social",
    location: "Hall",
    description: "Bring shoes.",
    allDay: false,
    startLocal: "2026-11-26T19:00:00",
    endLocal: "2026-11-26T22:00:00",
    tzid: "Europe/Prague",
    rrule: null,
  });
});

it("reads a time with no zone as UTC, and whole days as days", () => {
  expect(goingFields({ ...social, tzid: null })?.tzid).toBe("UTC");
  expect(
    goingFields({
      ...social,
      allDay: true,
      startLocal: "2026-11-28T00:00:00",
      endLocal: "2026-11-30T00:00:00",
      tzid: "Europe/Prague",
    }),
  ).toMatchObject({ allDay: true, startLocal: "2026-11-28", endLocal: "2026-11-30", tzid: null });
});

it("a title cut to an event's 200, and an empty one named", () => {
  expect(goingFields({ ...social, title: `  ${"T".repeat(300)}` })?.title).toBe("T".repeat(200));
  // Cut, then trimmed: no space left at the end.
  expect(goingFields({ ...social, title: `${"T".repeat(199)} more` })?.title).toBe("T".repeat(199));
  expect(goingFields({ ...social, title: "" })?.title).toBe("An event");
  expect(goingFields({ ...social, title: "   " })?.title).toBe("An event");
});

it("nothing for a moment with no length, as an event ends after it starts", () => {
  expect(goingFields({ ...social, endLocal: social.startLocal })).toBeNull();
  expect(goingFields({ ...social, endLocal: "2026-11-26T19:00:30" })?.endLocal).toBe(
    "2026-11-26T19:00:30",
  );
});
