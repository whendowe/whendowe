// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import ICAL from "ical.js";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
import { BUSY_SUMMARY, type FeedEntry, serializeFeed } from "../../src/feeds/ics.js";
import { propertySettings } from "./budget.js";

// Feeds are serializers with injection semantics (DESIGN §13), and visibility tiers are
// an authorization system (§9). So, for any events with any text in them, at any tier:
//  - every line of the feed, unfolded, is one of the properties the serializer writes,
//    and no physical line is longer than 75 octets or ends in anything but CRLF;
//  - each event's block has exactly the fields its tier may see, and the text in them
//    reads back as what was stored.

/** Every property name the serializer writes; anything else is an injected line. */
const WRITTEN = new Set([
  "BEGIN",
  "END",
  "VERSION",
  "PRODID",
  "CALSCALE",
  "METHOD",
  "X-WR-CALNAME",
  "REFRESH-INTERVAL",
  "X-PUBLISHED-TTL",
  "TZID",
  "DTSTART",
  "DTEND",
  "TZOFFSETFROM",
  "TZOFFSETTO",
  "UID",
  "DTSTAMP",
  "SEQUENCE",
  "RRULE",
  "SUMMARY",
  "LOCATION",
  "DESCRIPTION",
  "URL",
  "STATUS",
  "TRANSP",
]);

/** Text built to break a feed: line breaks, the TEXT specials, multi-byte, controls. */
function drawHostile(tc: hegel.TestCase): string {
  const pieces = tc.draw(
    gs.arrays(
      gs.oneOf(
        gs.sampledFrom([
          "\r\nATTENDEE:mailto:x@example.org",
          "\nEND:VEVENT\nBEGIN:VEVENT",
          "\r",
          ";",
          ",",
          "\\",
          "\\n",
          ":",
          "é",
          "🙂",
          "\u0000",
          "\u001b",
          "\t",
        ]),
        gs.text({ maxSize: 40 }),
      ),
      { maxSize: 6 },
    ),
  );
  return pieces.join("");
}

function drawInt(tc: hegel.TestCase, min: number, max: number): number {
  return tc.draw(gs.integers({ minValue: min, maxValue: max }));
}

function drawEntry(tc: hegel.TestCase, i: number): FeedEntry {
  const pad = (n: number) => String(n).padStart(2, "0");
  const allDay = tc.draw(gs.booleans());
  const repeats = tc.draw(gs.booleans());
  const day = `2101-${pad(drawInt(tc, 1, 12))}-${pad(drawInt(tc, 1, 28))}`;
  const hour = drawInt(tc, 0, 21);
  const optional = (tc2: hegel.TestCase) => (tc2.draw(gs.booleans()) ? drawHostile(tc2) : null);
  return {
    id: `0190a000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    revision: drawInt(tc, 1, 50),
    updatedAt: "2101-01-01T00:00:00.000Z",
    status: tc.draw(gs.sampledFrom(["scheduled", "cancelled"] as const)),
    visibility: tc.draw(gs.sampledFrom(["FULL", "DETAILS", "BUSY"] as const)),
    title: `T${i}${drawHostile(tc)}`,
    description: optional(tc),
    location: optional(tc),
    allDay,
    startLocal: allDay ? day : `${day}T${pad(hour)}:00:00`,
    endLocal: allDay
      ? Temporal.PlainDate.from(day).add({ days: 1 }).toString()
      : `${day}T${pad(hour + 2)}:00:00`,
    tzid: allDay ? null : tc.draw(gs.sampledFrom(["Europe/Prague", "America/New_York", "UTC"])),
    rrule: repeats ? "FREQ=WEEKLY;COUNT=4" : null,
    url: `https://whendowe.example/events/${i}`,
  };
}

/** What a stored text should read back as: line breaks as LF, other controls gone. */
const normalised = (s: string) =>
  [...s.replace(/\r\n|\r/g, "\n")]
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return c === "\t" || c === "\n" || (code >= 0x20 && code !== 0x7f);
    })
    .join("");

/** The feed's content lines: unfolded, split on CRLF (the last CRLF ends the feed). */
const unfolded = (body: string) => body.slice(0, -2).replace(/\r\n /g, "").split("\r\n");

/** RFC 5545 TEXT, read back (independently of the serializer's escapeText). */
function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = value[++i];
    out += next === "n" || next === "N" ? "\n" : (next ?? "");
  }
  return out;
}

test("no text adds a line; every physical line is short and CRLF-terminated", () =>
  hegel.test((tc) => {
    const entries = Array.from({ length: drawInt(tc, 0, 4) }, (_, i) => drawEntry(tc, i));
    const body = serializeFeed({
      name: drawHostile(tc),
      host: "whendowe.example",
      entries,
      now: "2101-06-01T00:00:00Z",
    });
    expect(body.endsWith("\r\n")).toBe(true);
    const physical = body.slice(0, -2).split("\r\n");
    for (const line of physical) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    for (const line of unfolded(body)) {
      const name = /^([A-Z-]+)[:;]/.exec(line)?.[1] ?? "";
      expect(WRITTEN.has(name), line).toBe(true);
    }
    expect(unfolded(body).filter((l) => l === "BEGIN:VEVENT")).toHaveLength(entries.length);
  }, propertySettings));

test("each event shows exactly what its tier may see, and its text reads back", () =>
  hegel.test((tc) => {
    const entries = Array.from({ length: drawInt(tc, 1, 4) }, (_, i) => drawEntry(tc, i));
    const body = serializeFeed({
      name: "Feed",
      host: "whendowe.example",
      entries,
      now: "2101-06-01T00:00:00Z",
    });
    const events: string[][] = [];
    for (const line of unfolded(body)) {
      if (line === "BEGIN:VEVENT") events.push([]);
      else if (line !== "END:VEVENT") events.at(-1)?.push(line);
    }
    expect(events).toHaveLength(entries.length);
    for (const [i, e] of entries.entries()) {
      const lines = events[i] ?? [];
      const value = (name: string) =>
        lines
          .filter((l) => l.startsWith(`${name}:`))
          .map((l) => unescapeText(l.slice(name.length + 1)));
      const busy = e.visibility === "BUSY";
      expect(value("SUMMARY")).toEqual([busy ? BUSY_SUMMARY : normalised(e.title)]);
      expect(value("LOCATION")).toEqual(
        !busy && e.location !== null ? [normalised(e.location)] : [],
      );
      expect(value("DESCRIPTION")).toEqual(
        e.visibility === "FULL" && e.description !== null ? [normalised(e.description)] : [],
      );
      expect(value("URL")).toEqual(busy ? [] : [e.url]);
      expect(value("STATUS")).toEqual([e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"]);
    }
  }, propertySettings));

// An independent reader (DESIGN §9 rc34): Mozilla's ical.js, the parser in Thunderbird.
// What it reads back is what was stored, and every start is the same instant —
// for a repeating event, through the VTIMEZONE we wrote, which checks it too.
test("an independent parser reads every event back: text, tier and the instant it starts", () =>
  hegel.test((tc) => {
    const entries = Array.from({ length: drawInt(tc, 1, 4) }, (_, i) => drawEntry(tc, i));
    const body = serializeFeed({
      name: drawHostile(tc),
      host: "whendowe.example",
      entries,
      now: "2101-06-01T00:00:00Z",
    });
    const calendar = new ICAL.Component(ICAL.parse(body));
    ICAL.TimezoneService.reset();
    for (const zone of calendar.getAllSubcomponents("vtimezone"))
      ICAL.TimezoneService.register(zone);
    const events = calendar.getAllSubcomponents("vevent").map((v) => new ICAL.Event(v));
    expect(events).toHaveLength(entries.length);
    for (const [i, e] of entries.entries()) {
      const ev = events[i];
      if (ev === undefined) throw new Error("missing event");
      const busy = e.visibility === "BUSY";
      expect(ev.uid).toBe(`${e.id}@whendowe.example`);
      expect(ev.summary).toBe(busy ? BUSY_SUMMARY : normalised(e.title));
      expect(ev.location ?? null).toBe(
        !busy && e.location !== null ? normalised(e.location) : null,
      );
      expect(ev.description ?? null).toBe(
        e.visibility === "FULL" && e.description !== null ? normalised(e.description) : null,
      );
      if (e.allDay) {
        expect(ev.startDate.isDate).toBe(true);
        expect(ev.startDate.toString()).toBe(e.startLocal);
        expect(ev.endDate.toString()).toBe(e.endLocal);
      } else {
        const at = (local: string) =>
          Temporal.PlainDateTime.from(local)
            .toZonedDateTime(e.tzid ?? "UTC")
            .toInstant().epochMilliseconds;
        expect(ev.startDate.toUnixTime() * 1000, `${e.startLocal} ${e.tzid}`).toBe(
          at(e.startLocal),
        );
        expect(ev.endDate.toUnixTime() * 1000).toBe(at(e.endLocal));
      }
      expect(ev.isRecurring()).toBe(e.rrule !== null);
    }
  }, propertySettings));
