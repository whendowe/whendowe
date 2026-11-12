// SPDX-License-Identifier: AGPL-3.0-or-later
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import {
  escapeText,
  type FeedEntry,
  foldLine,
  serializeFeed,
  vtimezone,
} from "../../src/feeds/ics.js";

// The feed serializer (DESIGN §10 rc34) on values worked out by hand. The properties —
// no input adds a line, no tier sees more than canSee gives it — are in
// tests/property/ics.property.test.ts.

const ENTRY: FeedEntry = {
  id: "0190a000-0000-7000-8000-000000000001",
  revision: 3,
  updatedAt: "2026-11-01T10:00:00.000Z",
  status: "scheduled",
  visibility: "FULL",
  title: "Rope jam",
  description: "Bring water",
  location: "The hall",
  allDay: false,
  startLocal: "2026-11-21T18:00:00",
  endLocal: "2026-11-21T20:00:00",
  tzid: "Europe/Prague",
  rrule: null,
  url: "https://whendowe.example/events/0190a000-0000-7000-8000-000000000001",
};

const feed = (entries: FeedEntry[]) =>
  serializeFeed({
    name: "WhenDoWe",
    host: "whendowe.example",
    entries,
    now: "2026-11-06T00:00:00Z",
  });

/** The feed's lines, unfolded. */
const lines = (body: string) => body.replace(/\r\n /g, "").split("\r\n");

describe("TEXT escaping and folding (RFC 5545 §3.3.11, §3.1)", () => {
  it("escapes backslash, semicolon, comma and every kind of line break; drops other controls", () => {
    expect(escapeText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
    expect(escapeText("one\r\ntwo\rthree\nfour")).toBe("one\\ntwo\\nthree\\nfour");
    expect(escapeText("tab\tstays, bell\u0007 and nul\u0000 go")).toBe(
      "tab\tstays\\, bell and nul go",
    );
  });

  it("folds at 75 octets without splitting a character", () => {
    const long = `SUMMARY:${"é".repeat(60)}`;
    const folded = foldLine(long);
    const parts = folded.split("\r\n");
    for (const [i, part] of parts.entries()) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
      if (i > 0) expect(part.startsWith(" ")).toBe(true);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    expect(foldLine("SHORT:x")).toBe("SHORT:x");
  });
});

describe("an event in the feed", () => {
  it("a one-off timed event is in UTC, with its id, revision and fields", () => {
    const out = lines(feed([ENTRY]));
    expect(out).toEqual(
      expect.arrayContaining([
        "UID:0190a000-0000-7000-8000-000000000001@whendowe.example",
        "DTSTAMP:20261101T100000Z",
        "SEQUENCE:3",
        "DTSTART:20261121T170000Z", // Prague is UTC+1 in November
        "DTEND:20261121T190000Z",
        "SUMMARY:Rope jam",
        "LOCATION:The hall",
        "DESCRIPTION:Bring water",
        "URL:https://whendowe.example/events/0190a000-0000-7000-8000-000000000001",
        "STATUS:CONFIRMED",
      ]),
    );
    expect(out.some((l) => l.startsWith("BEGIN:VTIMEZONE"))).toBe(false); // nothing repeats
    expect(out.some((l) => /^(ATTENDEE|ORGANIZER)/.test(l))).toBe(false);
  });

  it("each tier sees what canSee gives it, and BUSY is just busy", () => {
    const details = lines(feed([{ ...ENTRY, visibility: "DETAILS" }]));
    expect(details).toContain("SUMMARY:Rope jam");
    expect(details).toContain("LOCATION:The hall");
    expect(details.join("\n")).not.toContain("Bring water");
    const busy = lines(feed([{ ...ENTRY, visibility: "BUSY" }])).join("\n");
    expect(busy).toContain("SUMMARY:Busy");
    for (const hidden of ["Rope jam", "The hall", "Bring water", "URL:"])
      expect(busy).not.toContain(hidden);
    expect(busy).toContain("DTSTART:20261121T170000Z");
  });

  it("all day is a date; cancelled says so", () => {
    const out = lines(
      feed([
        {
          ...ENTRY,
          allDay: true,
          startLocal: "2026-11-21",
          endLocal: "2026-11-23",
          tzid: null,
          status: "cancelled",
        },
      ]),
    );
    expect(out).toContain("DTSTART;VALUE=DATE:20261121");
    expect(out).toContain("DTEND;VALUE=DATE:20261123");
    expect(out).toContain("STATUS:CANCELLED");
  });

  it("a repeating event keeps its zone, and the zone is described", () => {
    const body = feed([{ ...ENTRY, rrule: "FREQ=WEEKLY;BYDAY=SA" }]);
    const out = lines(body);
    expect(out).toContain("DTSTART;TZID=Europe/Prague:20261121T180000");
    expect(out).toContain("DTEND;TZID=Europe/Prague:20261121T200000");
    expect(out).toContain("RRULE:FREQ=WEEKLY;BYDAY=SA");
    expect(out.filter((l) => l === "BEGIN:VTIMEZONE")).toHaveLength(1);
    expect(out.indexOf("BEGIN:VTIMEZONE")).toBeLessThan(out.indexOf("BEGIN:VEVENT"));
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("refuses a stored value that isn't the shape it must be, rather than write it", () => {
    expect(() => feed([{ ...ENTRY, rrule: "FREQ=WEEKLY\r\nATTENDEE:x" }])).toThrow(/rrule/);
    expect(() => feed([{ ...ENTRY, url: 'https://x/"\r\nX:y' }])).toThrow(/url/);
    expect(() => feed([{ ...ENTRY, id: "a\nb" }])).toThrow(/id/);
    expect(() => feed([{ ...ENTRY, rrule: "FREQ=DAILY", tzid: "Europe/Prague\nX" }])).toThrow(
      /tzid/,
    );
  });

  it("renders the same input to the same bytes, so an unchanged feed keeps its ETag", () => {
    expect(feed([ENTRY])).toBe(feed([ENTRY]));
  });
});

describe("VTIMEZONE (from the platform's zone data)", () => {
  it("Prague in 2026: CET from New Year, summer time from 29 March, back on 25 October", () => {
    expect(vtimezone("Europe/Prague", 2026, 2026)).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Prague",
      "BEGIN:STANDARD",
      "DTSTART:20260101T000000",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:20260329T020000",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "DTSTART:20261025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  it("a zone without changes is one observance; a half-hour and a negative offset are written right", () => {
    expect(
      vtimezone("Asia/Kathmandu", 2026, 2027).filter((l) => l.startsWith("TZOFFSETTO")),
    ).toEqual(["TZOFFSETTO:+0545"]);
    expect(vtimezone("America/Sao_Paulo", 2026, 2026)).toContain("TZOFFSETTO:-0300");
  });

  // Soak counterexample, 2026-11-10: a weekly event at 01:00 New York on 6 November 2101,
  // the hour that happens twice. RFC 5545 §3.3.5 says the first; what makes the feed say
  // so is the fall-back observance starting at 02:00 in the offset before it (-0400), so
  // 01:00 is still daylight time. ical.js reads it as the second; the property allows that.
  it("the fall-back hour: New York leaves -0400 at 02:00 local, so 01:00 is the first one", () => {
    const body = serializeFeed({
      name: "Feed",
      host: "whendowe.example",
      now: "2101-06-01T00:00:00Z",
      entries: [
        {
          ...ENTRY,
          tzid: "America/New_York",
          startLocal: "2101-11-06T01:00:00",
          endLocal: "2101-11-06T03:00:00",
          rrule: "FREQ=WEEKLY;COUNT=4",
        },
      ],
    }).split("\r\n");
    expect(body).toContain("DTSTART;TZID=America/New_York:21011106T010000");
    const fallBack = body.indexOf("DTSTART:21011106T020000");
    expect(body.slice(fallBack - 1, fallBack + 4)).toEqual([
      "BEGIN:STANDARD",
      "DTSTART:21011106T020000",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "END:STANDARD",
    ]);
  });
});

describe("the edges Stryker found", () => {
  it("drops DEL too", () => {
    expect(escapeText("a\u007fb")).toBe("ab");
  });

  it("75 octets is one line; 76 folds; a continuation holds 74 after its space", () => {
    expect(foldLine("x".repeat(75))).toBe("x".repeat(75));
    expect(foldLine("x".repeat(76))).toBe(`${"x".repeat(75)}\r\n x`);
    expect(foldLine("x".repeat(75 + 74 + 1)).split("\r\n")).toEqual([
      "x".repeat(75),
      ` ${"x".repeat(74)}`,
      " x",
    ]);
  });

  it("writes the calendar's own lines, and leaves out fields that are empty", () => {
    const out = lines(feed([{ ...ENTRY, location: null, description: null, url: null }]));
    expect(out.slice(0, 8)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//WhenDoWe//Calendar feed//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:WhenDoWe",
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      "X-PUBLISHED-TTL:PT1H",
    ]);
    expect(out.slice(-5)).toEqual([
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]);
    expect(out.some((l) => /^(LOCATION|DESCRIPTION|URL)[:;]/.test(l))).toBe(false);
  });

  it("DTSTAMP is whole seconds even when the change had milliseconds", () => {
    expect(lines(feed([{ ...ENTRY, updatedAt: "2026-11-01T10:00:00.123Z" }]))).toContain(
      "DTSTAMP:20261101T100000Z",
    );
  });

  it("UTC is +0000, never -0000", () => {
    expect(vtimezone("UTC", 2026, 2026)).toContain("TZOFFSETTO:+0000");
  });

  it("zones are sorted, each from its earliest repeating start, to ten years past now", () => {
    const body = feed([
      {
        ...ENTRY,
        id: "a1",
        rrule: "FREQ=WEEKLY",
        startLocal: "2028-01-05T18:00:00",
        endLocal: "2028-01-05T19:00:00",
      },
      {
        ...ENTRY,
        id: "a2",
        rrule: "FREQ=WEEKLY",
        tzid: "America/New_York",
        startLocal: "2030-01-05T18:00:00",
        endLocal: "2030-01-05T19:00:00",
      },
      { ...ENTRY, id: "a4", rrule: "FREQ=WEEKLY", tzid: "Asia/Tokyo" },
      { ...ENTRY, id: "a3", rrule: "FREQ=WEEKLY" }, // Prague again, from 2026
    ]);
    const out = lines(body);
    const zones = out.filter((l) => l.startsWith("TZID:"));
    expect(zones).toEqual(["TZID:America/New_York", "TZID:Asia/Tokyo", "TZID:Europe/Prague"]);
    // A series that starts after now is described ten years past its start.
    const york = out.slice(out.indexOf("TZID:America/New_York"), out.indexOf("TZID:Asia/Tokyo"));
    const yorkYears = york.filter((l) => l.startsWith("DTSTART:")).map((l) => l.slice(8, 12));
    expect(yorkYears[0]).toBe("2030");
    expect(yorkYears.at(-1)).toBe("2040");
    const prague = out.slice(out.indexOf("TZID:Europe/Prague"), out.lastIndexOf("END:VTIMEZONE"));
    const starts = prague.filter((l) => l.startsWith("DTSTART:")).map((l) => l.slice(8, 12));
    expect(starts[0]).toBe("2026"); // the earlier of 2028 and 2026
    expect(starts.at(-1)).toBe("2036"); // now is 2026: ten years on
    expect(starts).not.toContain("2037");
  });
});

describe("read back by an independent parser (ical.js)", () => {
  it("a weekly event across the March change keeps its wall clock, through the VTIMEZONE we wrote", () => {
    const body = feed([
      {
        ...ENTRY,
        rrule: "FREQ=WEEKLY;COUNT=3",
        startLocal: "2026-03-21T18:00:00",
        endLocal: "2026-03-21T20:00:00",
      },
    ]);
    const calendar = new ICAL.Component(ICAL.parse(body));
    ICAL.TimezoneService.reset();
    for (const zone of calendar.getAllSubcomponents("vtimezone"))
      ICAL.TimezoneService.register(zone);
    const vevent = calendar.getFirstSubcomponent("vevent");
    if (vevent === null) throw new Error("no event");
    const event = new ICAL.Event(vevent);
    expect(event.startDate.toJSDate().toISOString()).toBe("2026-03-21T17:00:00.000Z");
    // 18:00 in Prague each week: 17:00 UTC in winter, 16:00 after summer time starts on 29 March.
    const iterator = event.iterator();
    const dates: string[] = [];
    for (let i = 0; i < 10; i++) {
      const next = iterator.next();
      if (next === undefined || next === null) break;
      dates.push(next.toJSDate().toISOString());
    }
    expect(dates).toEqual([
      "2026-03-21T17:00:00.000Z",
      "2026-03-28T17:00:00.000Z",
      "2026-04-04T16:00:00.000Z",
    ]);
  });
});
