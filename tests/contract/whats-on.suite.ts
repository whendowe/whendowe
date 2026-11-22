// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { createEvent } from "../../src/events/event.js";
import type { PublicGet } from "../../src/following/fetch.js";
import { follow, recolourFollow, refreshCalendar } from "../../src/following/follow.js";
import { followedEvent, whatsOn } from "../../src/following/whats-on.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";

// What's on when you're free (DESIGN §10 rc58) on BOTH drivers: the next two weeks of what you
// and your groups follow, each event once in your own follow's colour, cancelled ones left out,
// what overlaps something of yours marked; and a followed event found only by its followers.

const T0 = "2026-11-21T12:00:00.000Z";

const CAL = (...events: string[][]) =>
  [
    "BEGIN:VCALENDAR",
    "X-WR-CALNAME:Swing school",
    "X-WR-TIMEZONE:Europe/Prague",
    ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");
const ev = (uid: string, start: string, end: string, more: string[] = []) => [
  `UID:${uid}`,
  `DTSTART:${start}`,
  `DTEND:${end}`,
  `SUMMARY:${uid}`,
  ...more,
];
const FEED = CAL(
  // On now: started before T0, ends after it.
  ev("now", "20261121T110000Z", "20261121T130000Z"),
  // 19:00–22:00 in Prague.
  ev("social", "20261126T180000Z", "20261126T210000Z", [
    "LOCATION:Hall",
    "URL:https://club.example/s",
  ]),
  ev("gone", "20261127T180000Z", "20261127T200000Z", ["STATUS:CANCELLED"]),
  ["UID:fest", "DTSTART;VALUE=DATE:20261128", "DTEND;VALUE=DATE:20261130", "SUMMARY:fest"],
  ev("class", "20261201T180000Z", "20261201T193000Z"),
  // The two weeks' last morning: 09:00 in Prague on 5 December.
  ev("dec5", "20261205T080000Z", "20261205T090000Z"),
  // Past the two weeks, though within the 60 days kept.
  ev("far", "20261210T180000Z", "20261210T200000Z"),
);

/** The window's edges, read on T0 and asked about on LATER; and one day in two zones. */
const LATER = "2026-11-27T12:00:00.000Z"; // the window ends 2026-12-11T12:00Z
const date = (uid: string, first: string, afterLast: string) => [
  `UID:${uid}`,
  `DTSTART;VALUE=DATE:${first}`,
  `DTEND;VALUE=DATE:${afterLast}`,
  `SUMMARY:${uid}`,
];
const EDGES = CAL(
  ev("ended", "20261126T100000Z", "20261127T120000Z"), // ends as LATER begins
  ev("moment", "20261127T120000Z", "20261127T120000Z"), // no length, at LATER
  ev("running", "20261127T110000Z", "20261127T130000Z"),
  ev("edge", "20261211T120000Z", "20261211T130000Z"), // starts as the window ends
  ev("inside", "20261211T115900Z", "20261211T130000Z"),
  date("daysdone", "20261125", "20261127"), // its last day is the day before LATER's
  date("daysnow", "20261126", "20261128"),
  date("lastday", "20261211", "20261212"),
  date("afterlast", "20261212", "20261213"),
  // 2 December: 19:00 in Prague is before 18:30 in London.
  date("dec2", "20261202", "20261203"),
  [
    "UID:prague",
    "DTSTART;TZID=Europe/Prague:20261202T190000",
    "DTEND;TZID=Europe/Prague:20261202T200000",
    "SUMMARY:prague",
  ],
  [
    "UID:london",
    "DTSTART;TZID=Europe/London:20261202T183000",
    "DTEND;TZID=Europe/London:20261202T193000",
    "SUMMARY:london",
  ],
);

function serving(text: string): PublicGet {
  return async () => ({
    status: 200,
    header: () => null,
    body: {
      getReader: () => {
        const chunks = [new TextEncoder().encode(text)];
        return {
          read: async () => {
            const value = chunks.shift();
            return value === undefined ? { done: true } : { done: false, value };
          },
          cancel: async () => {},
        };
      },
    },
  });
}

/** Ann follows the school herself and for Dancers, where Bob is a member; Carl follows nothing. */
async function school(port: StoragePort, tag: string, feed = FEED) {
  const ann = await findOrCreatePerson(port, `on-ann-${tag}@example.org`, { now: T0 });
  const carl = await findOrCreatePerson(port, `on-carl-${tag}@example.org`, { now: T0 });
  const group = await createGroup(port, { name: `Dancers ${tag}`, creatorId: ann.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, ann.id);
  if (membership === null) throw new Error("membership");
  const invite = await createInvite(port, membership, {
    email: `on-bob-${tag}@example.org`,
    invitedBy: ann.id,
    editTier: "view",
    visibility: "FULL",
    now: T0,
  });
  if (!invite.ok) throw new Error(invite.reason);
  const accepted = await acceptInvite(port, invite.token, T0);
  if (accepted === null) throw new Error("accept");
  const url = `https://club.example/${tag}.ics`;
  const own = await follow(port, { kind: "person", personId: ann.id }, url, T0);
  const forGroup = await follow(
    port,
    { kind: "group", groupId: group.id, actorId: ann.id },
    url,
    T0,
  );
  if (!own.ok || !forGroup.ok) throw new Error("follow");
  const groupFollower = { kind: "group", groupId: group.id, actorId: ann.id } as const;
  await recolourFollow(port, groupFollower, forGroup.followId, "f5");
  await refreshCalendar(port, serving(feed), own.calendarId, T0);
  return {
    ann: ann.id,
    bob: accepted.personId,
    carl: carl.id,
    membership,
    calendarId: own.calendarId,
  };
}

const titles = (events: readonly { title: string }[]) => events.map((e) => e.title);

export function runWhatsOnContract(makePort: () => Promise<StoragePort>): void {
  describe("what's on", () => {
    it("lists the next two weeks once, by start, cancelled ones left out", async () => {
      const port = await makePort();
      const s = await school(port, "list");
      const ann = await whatsOn(port, s.ann, T0);
      expect(titles(ann)).toEqual(["now", "social", "fest", "class", "dec5"]);
      // Followed twice, shown once, in her own follow's colour.
      expect(ann.every((e) => e.colour === "f1" && e.calendarName === "Swing school")).toBe(true);
      expect(ann[1]).toMatchObject({
        calendarId: s.calendarId,
        uid: "social",
        location: "Hall",
        url: "https://club.example/s",
        startLocal: "2026-11-26T19:00:00",
        endLocal: "2026-11-26T22:00:00",
        tzid: "Europe/Prague",
        allDay: false,
        startUtc: "2026-11-26T18:00:00Z",
        endUtc: "2026-11-26T21:00:00Z",
        clashes: false,
      });
      expect(ann[2]).toMatchObject({ allDay: true, startUtc: null, endUtc: null });
      // Bob sees the group's, in the group's colour; Carl follows nothing.
      const bob = await whatsOn(port, s.bob, T0);
      expect(titles(bob)).toEqual(titles(ann));
      expect(bob.every((e) => e.colour === "f5")).toBe(true);
      expect(await whatsOn(port, s.carl, T0)).toEqual([]);
      // A day later, what has ended is gone and what came within two weeks is in.
      const later = await whatsOn(port, s.ann, "2026-11-27T12:00:00.000Z");
      expect(titles(later)).toEqual(["fest", "class", "dec5", "far"]);
    });

    it("marks what overlaps something of yours, and only for you", async () => {
      const port = await makePort();
      const s = await school(port, "clash");
      const make = (startLocal: string, endLocal: string, allDay = false) =>
        createEvent(port, {
          creatorId: s.ann,
          group: null,
          fields: {
            title: "Mine",
            description: null,
            location: null,
            allDay,
            startLocal,
            endLocal,
            tzid: allDay ? null : "Europe/Prague",
          },
          now: T0,
        });
      // An hour inside the social; a whole day on the class's date; a few hours on the fest.
      await make("2026-11-26T20:00", "2026-11-26T21:00");
      await make("2026-12-01", "2026-12-02", true);
      await make("2026-11-28T12:00", "2026-11-28T14:00");
      // The two weeks' last morning: your times are asked for to its end.
      await make("2026-12-05T09:30", "2026-12-05T10:30");
      const ann = await whatsOn(port, s.ann, T0);
      expect(ann.filter((e) => e.clashes).map((e) => e.uid)).toEqual(["social", "class", "dec5"]);
      expect((await whatsOn(port, s.bob, T0)).some((e) => e.clashes)).toBe(false);
    });

    it("keeps to the two weeks by instant, all-day ones by day, and orders a day by instant", async () => {
      const port = await makePort();
      const s = await school(port, "edges", EDGES);
      expect(titles(await whatsOn(port, s.ann, LATER))).toEqual([
        "daysnow",
        "running",
        "moment",
        "dec2",
        "prague",
        "london",
        "lastday",
        "inside",
      ]);
    });

    it("finds a followed event only for those who follow its calendar", async () => {
      const port = await makePort();
      const s = await school(port, "sheet");
      const found = await followedEvent(port, s.bob, s.calendarId, "social", T0);
      expect(found).toMatchObject({ title: "social", colour: "f5", cancelled: false });
      expect(await followedEvent(port, s.carl, s.calendarId, "social", T0)).toBeNull();
      expect(await followedEvent(port, s.ann, s.calendarId, "nothing", T0)).toBeNull();
      expect(await followedEvent(port, s.ann, "another", "social", T0)).toBeNull();
      // A cancelled one is still found, and says so.
      expect(await followedEvent(port, s.ann, s.calendarId, "gone", T0)).toMatchObject({
        cancelled: true,
        colour: "f1",
      });
    });
  });
}
