// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { feedRule, KEEP_DAYS, readFeed } from "../../src/following/read.js";

// Reading a followed calendar (DESIGN §10 rc56/rc57) on feeds written by hand. The shapes are
// the ones a real Google public calendar uses: UTC times, TZID times, dates, weekly series
// with WKST and a UTC UNTIL, EXDATEs, and dates of a series moved or cancelled.

const NOW = "2026-11-21T12:00:00Z"; // a Saturday; Prague is UTC+1

const feed = (...events: string[][]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "X-WR-CALNAME:Swing school",
    "X-WR-TIMEZONE:Europe/Prague",
    ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");

const read = (text: string) => {
  const r = readFeed(text, NOW);
  if (!r.ok) throw new Error("unreadable");
  return r;
};

describe("readFeed — what a feed holds, in the window kept", () => {
  it("is unreadable when it isn't a calendar; an empty calendar is readable", () => {
    expect(readFeed("<html>not here</html>", NOW)).toEqual({ ok: false });
    expect(readFeed("", NOW)).toEqual({ ok: false });
    expect(read(feed())).toEqual({ ok: true, name: "Swing school", events: [], leftOut: 0 });
  });

  it("keeps a UTC time in the feed's own zone, and the fields as text", () => {
    const r = read(
      feed([
        "UID:a@example",
        "DTSTART:20261126T180000Z",
        "DTEND:20261126T210000Z",
        "SUMMARY:Social\\, with live band",
        "LOCATION:Studio\\; upstairs",
        "DESCRIPTION:Bring shoes\\nand water",
        "URL:https://swing.example/social",
      ]),
    );
    expect(r.events).toEqual([
      {
        uid: "a@example",
        title: "Social, with live band",
        location: "Studio; upstairs",
        description: "Bring shoes\nand water",
        url: "https://swing.example/social",
        startLocal: "2026-11-26T19:00:00",
        endLocal: "2026-11-26T22:00:00",
        tzid: "Europe/Prague",
        allDay: false,
        status: "confirmed",
      },
    ]);
  });

  it(`keeps what isn't over and starts within ${KEEP_DAYS} days; nothing past, nothing later`, () => {
    const at = (uid: string, start: string, end: string) => [
      `UID:${uid}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      "SUMMARY:x",
    ];
    const r = read(
      feed(
        at("past", "20261120T180000Z", "20261120T200000Z"),
        at("under-way", "20261121T110000Z", "20261121T130000Z"),
        at("ended-now", "20261121T100000Z", "20261121T120000Z"),
        at("last-in", "20270120T115900Z", "20270120T130000Z"),
        at("too-far", "20270120T120000Z", "20270120T130000Z"),
      ),
    );
    expect(r.events.map((e) => e.uid)).toEqual(["under-way", "last-in"]);
  });

  it("reads TZID times, dates and floating times; an end comes from DURATION or a default", () => {
    const r = read(
      feed(
        ["UID:tz", "DTSTART;TZID=Europe/London:20261201T190000", "DURATION:PT1H30M", "SUMMARY:a"],
        ["UID:day", "DTSTART;VALUE=DATE:20261205", "SUMMARY:b"],
        ["UID:float", "DTSTART:20261206T100000", "SUMMARY:c"],
      ),
    );
    expect(r.events.map((e) => [e.uid, e.startLocal, e.endLocal, e.tzid, e.allDay])).toEqual([
      ["tz", "2026-12-01T19:00:00", "2026-12-01T20:30:00", "Europe/London", false],
      ["day", "2026-12-05T00:00:00", "2026-12-06T00:00:00", null, true],
      ["float", "2026-12-06T10:00:00", "2026-12-06T10:00:00", null, false],
    ]);
  });

  it("a DTEND in another zone is kept in the start's", () => {
    const r = read(
      feed([
        "UID:x",
        "DTSTART;TZID=Europe/Prague:20261201T190000",
        "DTEND;TZID=Europe/London:20261201T200000",
        "SUMMARY:x",
      ]),
    );
    expect(r.events[0]?.endLocal).toBe("2026-12-01T21:00:00");
  });

  it("expands a weekly series with WKST and a UTC UNTIL, less its EXDATEs, with dates moved and cancelled", () => {
    const r = read(
      feed(
        [
          "UID:class",
          "DTSTART;TZID=Europe/Prague:20260901T190000",
          "DTEND;TZID=Europe/Prague:20260901T203000",
          "RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20261222T180000Z;BYDAY=TU",
          "EXDATE;TZID=Europe/Prague:20261201T190000",
          "SUMMARY:Lindy 2",
        ],
        [
          "UID:class",
          "RECURRENCE-ID;TZID=Europe/Prague:20261208T190000",
          "DTSTART;TZID=Europe/Prague:20261210T200000",
          "DTEND;TZID=Europe/Prague:20261210T213000",
          "SUMMARY:Lindy 2 (moved)",
        ],
        [
          "UID:class",
          "RECURRENCE-ID:20261215T180000Z",
          "DTSTART;TZID=Europe/Prague:20261215T190000",
          "DTEND;TZID=Europe/Prague:20261215T203000",
          "STATUS:CANCELLED",
          "SUMMARY:Lindy 2",
        ],
      ),
    );
    expect(r.events.map((e) => [e.uid, e.startLocal, e.status, e.title])).toEqual([
      ["class/2026-11-24T19:00:00", "2026-11-24T19:00:00", "confirmed", "Lindy 2"],
      ["class/2026-12-08T19:00:00", "2026-12-10T20:00:00", "confirmed", "Lindy 2 (moved)"],
      ["class/2026-12-15T19:00:00", "2026-12-15T19:00:00", "cancelled", "Lindy 2"],
      ["class/2026-12-22T19:00:00", "2026-12-22T19:00:00", "confirmed", "Lindy 2"],
    ]);
  });

  it("unfolds lines, reads a quoted parameter with a colon, and ignores an alarm's fields", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:fold",
      'DTSTART;X-NOTE="a:b";TZID=Europe/Prague:20261201T190000',
      "SUMMARY:A very long ti",
      " tle, folded",
      "BEGIN:VALARM",
      "SUMMARY:Not the title",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const r = read(text);
    expect(r.name).toBeNull();
    expect(r.events.map((e) => [e.title, e.startLocal])).toEqual([
      ["A very long title, folded", "2026-12-01T19:00:00"],
    ]);
  });

  it("leaves out and counts an event it can't read; a feed with nothing readable is unreadable", () => {
    const good = ["UID:good", "DTSTART:20261201T180000Z", "SUMMARY:ok"];
    const bad = [
      ["UID:zone", "DTSTART;TZID=Mars/Olympus:20261201T190000", "SUMMARY:x"],
      ["UID:rdate", "DTSTART:20261201T180000Z", "RDATE:20261202T180000Z", "SUMMARY:x"],
      ["UID:rule", "DTSTART:20261201T180000Z", "RRULE:FREQ=MONTHLY;BYSETPOS=1", "SUMMARY:x"],
      ["DTSTART:20261201T180000Z", "SUMMARY:no uid"],
      ["UID:nostart", "SUMMARY:x"],
      ["UID:backwards", "DTSTART:20261201T180000Z", "DTEND:20261201T170000Z", "SUMMARY:x"],
      ["UID:kinds", "DTSTART;VALUE=DATE:20261201", "DTEND:20261201T170000Z", "SUMMARY:x"],
      ["UID:nodate", "DTSTART:20261301T180000Z", "SUMMARY:x"],
      [
        "UID:range",
        "RECURRENCE-ID;RANGE=THISANDFUTURE:20261201T180000Z",
        "DTSTART:20261201T180000Z",
      ],
    ];
    const r = read(feed(good, ...bad));
    expect(r.events.map((e) => e.uid)).toEqual(["good"]);
    expect(r.leftOut).toBe(bad.length);
    expect(readFeed(feed(...bad), NOW)).toEqual({ ok: false });
  });

  it("keeps only a web link, and a title-less event as an empty title", () => {
    const r = read(feed(["UID:x", "DTSTART:20261201T180000Z", "URL:javascript:alert(1)"]));
    expect(r.events[0]).toMatchObject({ title: "", url: null });
  });

  it("a date named twice keeps the first", () => {
    const e = (title: string) => ["UID:twice", "DTSTART:20261201T180000Z", `SUMMARY:${title}`];
    expect(read(feed(e("first"), e("second"))).events.map((x) => x.title)).toEqual(["first"]);
  });
});

// Found by tests/property/following-read.property.test.ts against ical.js, shrunk, pinned.
describe("readFeed — series as RFC 5545 has them", () => {
  const at = (now: string, text: string) => {
    const r = readFeed(text, now);
    if (!r.ok) throw new Error("unreadable");
    return r.events.map((e) => [e.uid, e.startLocal, e.status]);
  };

  it("a series given in UTC repeats in UTC: across a change of clocks, its local time moves", () => {
    const text = feed([
      "UID:u",
      "DTSTART:20270321T230000Z",
      "DTEND:20270321T233000Z",
      "RRULE:FREQ=WEEKLY;COUNT=2",
    ]);
    // Midnight in Prague, then 01:00 once summer time starts on 28 March.
    expect(at("2027-03-01T12:00:00Z", text)).toEqual([
      ["u/2027-03-21T23:00:00", "2027-03-22T00:00:00", "confirmed"],
      ["u/2027-03-28T23:00:00", "2027-03-29T01:00:00", "confirmed"],
    ]);
  });

  it("an override counts only for a date its series has: past its end, or deleted, it names nothing", () => {
    const series = [
      "UID:s",
      "DTSTART;TZID=Europe/Prague:20261201T190000",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "EXDATE;TZID=Europe/Prague:20261208T190000",
    ];
    const override = (date: string) => [
      "UID:s",
      `RECURRENCE-ID;TZID=Europe/Prague:${date}T190000`,
      `DTSTART;TZID=Europe/Prague:${date}T200000`,
    ];
    expect(at(NOW, feed(series, override("20261215"), override("20261208")))).toEqual([
      ["s/2026-12-01T19:00:00", "2026-12-01T19:00:00", "confirmed"],
    ]);
  });

  it("a date at a time the clocks skip keeps its wall clock, at the offset before the change", () => {
    // 02:00 on 28 March 2027 doesn't exist in Prague; RFC 5545 §3.3.5 reads it at +01:00.
    const r = readFeed(
      feed([
        "UID:gap",
        "DTSTART;TZID=Europe/Prague:20270321T020000",
        "DTEND;TZID=Europe/Prague:20270321T030000",
        "RRULE:FREQ=WEEKLY;COUNT=2",
      ]),
      "2027-03-20T00:00:00Z",
    );
    if (!r.ok) throw new Error("unreadable");
    expect(r.events.map((e) => [e.startLocal, e.tzid])).toEqual([
      ["2027-03-21T02:00:00", "Europe/Prague"],
      ["2027-03-28T02:00:00", "Europe/Prague"],
    ]);
  });

  it("an override with no series in the feed stands alone", () => {
    const lone = [
      "UID:lone",
      "RECURRENCE-ID;TZID=Europe/Prague:20261208T190000",
      "DTSTART;TZID=Europe/Prague:20261209T190000",
    ];
    expect(at(NOW, feed(lone))).toEqual([
      ["lone/2026-12-08T19:00:00", "2026-12-09T19:00:00", "confirmed"],
    ]);
  });
});

describe("feedRule — a feed's rule in the recurrence subset, where it means the same", () => {
  it("drops WKST when it can't move a date, and turns a UTC UNTIL into wall clock", () => {
    expect(feedRule("FREQ=WEEKLY;WKST=MO;UNTIL=20261222T180000Z;BYDAY=TU", "Europe/Prague")).toBe(
      "FREQ=WEEKLY;UNTIL=20261222T190000;BYDAY=TU",
    );
    expect(feedRule("FREQ=WEEKLY;WKST=SU;INTERVAL=1;BYDAY=TU,TH", null)).toBe(
      "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH",
    );
    expect(feedRule("FREQ=MONTHLY;WKST=MO;BYDAY=1SA", null)).toBe("FREQ=MONTHLY;BYDAY=1SA");
  });

  it("keeps WKST where it can move a date — and then the subset refuses it", () => {
    expect(() => feedRule("FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=TU,SU", null)).toThrow();
    expect(() => feedRule("FREQ=WEEKLY;BYMONTH=3", null)).toThrow();
  });
});
