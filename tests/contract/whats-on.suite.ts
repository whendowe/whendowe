// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  createEvent,
  deleteEvent,
  editEvent,
  findEventForParticipant,
  listHistory,
  setCancelled,
} from "../../src/events/event.js";
import type { PublicGet } from "../../src/following/fetch.js";
import {
  follow,
  recolourFollow,
  refreshCalendar,
  stopFollowing,
} from "../../src/following/follow.js";
import { cancelledBy, followSource, go, goingTo } from "../../src/following/going.js";
import { followedEvent, type OnEvent, whatsOn } from "../../src/following/whats-on.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";

// What's on when you're free (DESIGN §10 rc58) on BOTH drivers: the next two weeks of what you
// and your groups follow, each event once in your own follow's colour, cancelled ones left out,
// what overlaps something of yours marked; and a followed event found only by its followers.
// Going (rc59): a followed event made an event of yours, one per person, shown as going.

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
    ownFollowId: own.followId,
    groupFollowId: forGroup.followId,
    groupId: group.id,
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

  describe("going (rc59)", () => {
    const followed = async (
      port: StoragePort,
      personId: string,
      calendarId: string,
      uid: string,
    ) => {
      const e = await followedEvent(port, personId, calendarId, uid, T0);
      if (e === null) throw new Error(`no ${uid}`);
      return e;
    };
    const yours = async (port: StoragePort, personId: string, eventId: string) => {
      const access = await findEventForParticipant(port, eventId, personId);
      if (access === null) throw new Error("not yours");
      return access;
    };

    it("makes an event of yours, just you, with its title, place, description and time", async () => {
      const port = await makePort();
      const s = await school(port, "go");
      const social = await followed(port, s.ann, s.calendarId, "social");
      const went = await go(port, { personId: s.ann, event: social, now: T0 });
      if (went.kind !== "made") throw new Error(went.kind);
      const access = await yours(port, s.ann, went.eventId);
      expect(access.event).toMatchObject({
        title: "social",
        location: "Hall",
        description: null,
        allDay: false,
        startLocal: "2026-11-26T19:00:00",
        endLocal: "2026-11-26T22:00:00",
        tzid: "Europe/Prague",
        rrule: null,
        status: "scheduled",
        groupId: null,
        ownerId: s.ann,
      });
      // Nobody else is in it: not Bob, who follows the calendar through the group.
      expect(await findEventForParticipant(port, went.eventId, s.bob)).toBeNull();
      const [row] = await port.query({
        sql: "SELECT followed_from, followed_until FROM canonical_event WHERE id = ?",
        params: [went.eventId],
      });
      expect(row).toEqual({ followed_from: `${s.calendarId}/social`, followed_until: "1" });
      expect(await goingTo(port, s.ann, social)).toEqual({
        eventId: went.eventId,
        cancelled: false,
      });
      expect(await goingTo(port, s.bob, social)).toBeNull();
      // An event made otherwise came from nowhere, and follows nothing.
      const mine = await createEvent(port, {
        creatorId: s.ann,
        group: null,
        fields: {
          title: "Mine",
          description: null,
          location: null,
          allDay: false,
          startLocal: "2026-12-03T19:00",
          endLocal: "2026-12-03T20:00",
          tzid: "Europe/Prague",
        },
        now: T0,
      });
      const [plain] = await port.query({
        sql: "SELECT followed_from, followed_until FROM canonical_event WHERE id = ?",
        params: [mine.id],
      });
      expect(plain).toEqual({ followed_from: null, followed_until: null });
      // A whole-day one, as days.
      const fest = await go(port, {
        personId: s.ann,
        event: await followed(port, s.ann, s.calendarId, "fest"),
        now: T0,
      });
      if (fest.kind !== "made") throw new Error(fest.kind);
      expect((await yours(port, s.ann, fest.eventId)).event).toMatchObject({
        allDay: true,
        startLocal: "2026-11-28",
        endLocal: "2026-11-30",
        tzid: null,
      });
    });

    it("makes one per person, however many taps, and each follower their own", async () => {
      const port = await makePort();
      const s = await school(port, "once");
      const social = await followed(port, s.ann, s.calendarId, "social");
      // Two at once: both look first and find nothing, and the index makes the second the first.
      const [a, b] = await Promise.all([
        go(port, { personId: s.ann, event: social, now: T0 }),
        go(port, { personId: s.ann, event: social, now: T0 }),
      ]);
      if (a.kind === "moment" || b.kind === "moment") throw new Error("moment");
      expect(a.eventId).toBe(b.eventId);
      expect([a.kind, b.kind].sort()).toEqual(["already", "made"]);
      const again = await go(port, { personId: s.ann, event: social, now: T0 });
      expect(again).toEqual({ kind: "already", eventId: a.eventId });
      const [count] = await port.query({
        sql: "SELECT count(*) AS n FROM canonical_event WHERE owner_id = ?",
        params: [s.ann],
      });
      expect(count).toEqual({ n: 1 });
      const bob = await go(port, { personId: s.bob, event: social, now: T0 });
      expect(bob.kind).toBe("made");
    });

    it("refuses a moment with no length, which can't be an event", async () => {
      const port = await makePort();
      const s = await school(port, "moment", EDGES);
      const moment = await followed(port, s.ann, s.calendarId, "moment");
      expect(await go(port, { personId: s.ann, event: moment, now: T0 })).toEqual({
        kind: "moment",
      });
    });

    it("what's on shows what you're going to as going, never as a clash with itself", async () => {
      const port = await makePort();
      const s = await school(port, "shown");
      const social = await followed(port, s.ann, s.calendarId, "social");
      const went = await go(port, { personId: s.ann, event: social, now: T0 });
      if (went.kind !== "made") throw new Error(went.kind);
      const on = (list: readonly OnEvent[], uid: string) => list.find((e) => e.uid === uid);
      expect(on(await whatsOn(port, s.ann, T0), "social")).toMatchObject({
        clashes: false,
        going: { eventId: went.eventId, cancelled: false },
      });
      expect(on(await whatsOn(port, s.ann, T0), "class")).toMatchObject({ going: null });
      // Bob didn't go: his is his own.
      expect(on(await whatsOn(port, s.bob, T0), "social")).toMatchObject({ going: null });
      // Cancelled, it is no longer going, and nothing of yours is busy then.
      const access = await yours(port, s.ann, went.eventId);
      expect((await setCancelled(port, access, { cancelled: true, now: T0 })).kind).toBe("done");
      expect(on(await whatsOn(port, s.ann, T0), "social")).toMatchObject({
        clashes: false,
        going: { eventId: went.eventId, cancelled: true },
      });
      // Deleted, it was never gone to, and Going makes a new one.
      const cancelled = await yours(port, s.ann, went.eventId);
      expect((await deleteEvent(port, cancelled, T0)).kind).toBe("deleted");
      expect(on(await whatsOn(port, s.ann, T0), "social")).toMatchObject({ going: null });
      expect((await go(port, { personId: s.ann, event: social, now: T0 })).kind).toBe("made");
    });
  });

  describe("following the source (rc59, F3b)", () => {
    const LATER_T = "2026-11-22T12:00:00.000Z";
    /** The feed with the social moved an hour later, renamed and elsewhere. */
    const MOVED = FEED.replace("DTSTART:20261126T180000Z", "DTSTART:20261126T190000Z")
      .replace("DTEND:20261126T210000Z", "DTEND:20261126T220000Z")
      .replace("SUMMARY:social", "SUMMARY:Social night")
      .replace("LOCATION:Hall", "LOCATION:Old Mill");
    const gone = async (port: StoragePort, s: { ann: string; calendarId: string }) => {
      const social = await followedEvent(port, s.ann, s.calendarId, "social", T0);
      if (social === null) throw new Error("social");
      const went = await go(port, { personId: s.ann, event: social, now: T0 });
      if (went.kind === "moment") throw new Error("moment");
      return went.eventId;
    };
    const yours = async (port: StoragePort, personId: string, eventId: string) => {
      const access = await findEventForParticipant(port, eventId, personId);
      if (access === null) throw new Error("not yours");
      return access;
    };
    const until = async (port: StoragePort, eventId: string) =>
      (
        await port.query({
          sql: "SELECT followed_until FROM canonical_event WHERE id = ?",
          params: [eventId],
        })
      )[0]?.followed_until;

    it("a moved source moves yours, everything Going copied, logged as from its calendar", async () => {
      const port = await makePort();
      const s = await school(port, "moves");
      const id = await gone(port, s);
      await refreshCalendar(port, serving(MOVED), s.calendarId, LATER_T);
      const access = await yours(port, s.ann, id);
      expect(access.event).toMatchObject({
        title: "Social night",
        location: "Old Mill",
        startLocal: "2026-11-26T20:00:00",
        endLocal: "2026-11-26T23:00:00",
        tzid: "Europe/Prague",
        revision: 2,
        status: "scheduled",
      });
      expect(await until(port, id)).toBe("2");
      const [latest] = await listHistory(port, access);
      expect(latest).toMatchObject({
        revision: 2,
        actorId: `calendar:${s.calendarId}`,
        source: "inbound_sync",
        actor: null,
        at: LATER_T,
      });
      expect(Object.keys(latest?.change ?? {}).sort()).toEqual([
        "endLocal",
        "location",
        "startLocal",
        "title",
      ]);
      // Moved back, it follows again: still the source's.
      await refreshCalendar(port, serving(FEED), s.calendarId, LATER_T);
      expect((await yours(port, s.ann, id)).event).toMatchObject({
        title: "social",
        revision: 3,
      });
      expect(await until(port, id)).toBe("3");
    });

    it("once you change it, it is only yours", async () => {
      const port = await makePort();
      const s = await school(port, "mine");
      const id = await gone(port, s);
      const access = await yours(port, s.ann, id);
      const edited = await editEvent(port, access, {
        fields: { ...access.event, description: "With Bob" },
        actorId: s.ann,
        now: T0,
      });
      expect(edited.kind).toBe("updated");
      await refreshCalendar(port, serving(MOVED), s.calendarId, LATER_T);
      expect((await yours(port, s.ann, id)).event).toMatchObject({
        title: "social",
        description: "With Bob",
        startLocal: "2026-11-26T19:00:00",
        revision: 2,
      });
      expect(await until(port, id)).toBe("1");
      // Cancelling is a change of yours too.
      const port2 = await makePort();
      const t = await school(port2, "cancel");
      const id2 = await gone(port2, t);
      const done = await setCancelled(port2, await yours(port2, t.ann, id2), {
        cancelled: true,
        now: T0,
      });
      expect(done.kind).toBe("done");
      await refreshCalendar(port2, serving(MOVED), t.calendarId, LATER_T);
      expect((await yours(port2, t.ann, id2)).event).toMatchObject({
        title: "social",
        status: "cancelled",
      });
    });

    it("each follower's event follows on its own; others are untouched", async () => {
      const port = await makePort();
      const s = await school(port, "each");
      const annId = await gone(port, s);
      const bobSocial = await followedEvent(port, s.bob, s.calendarId, "social", T0);
      if (bobSocial === null) throw new Error("social");
      const bob = await go(port, { personId: s.bob, event: bobSocial, now: T0 });
      if (bob.kind === "moment") throw new Error("moment");
      // Bob makes his his own; Ann's still follows.
      const bobAccess = await yours(port, s.bob, bob.eventId);
      await editEvent(port, bobAccess, {
        fields: { ...bobAccess.event, title: "Bob's social" },
        actorId: s.bob,
        now: T0,
      });
      const mine = await createEvent(port, {
        creatorId: s.ann,
        group: null,
        fields: {
          title: "social",
          description: null,
          location: null,
          allDay: false,
          startLocal: "2026-11-26T19:00",
          endLocal: "2026-11-26T22:00",
          tzid: "Europe/Prague",
        },
        now: T0,
      });
      await refreshCalendar(port, serving(MOVED), s.calendarId, LATER_T);
      expect((await yours(port, s.ann, annId)).event.title).toBe("Social night");
      expect((await yours(port, s.bob, bob.eventId)).event.title).toBe("Bob's social");
      // An event of the same name and time that wasn't gone to is not the source's.
      expect((await yours(port, s.ann, mine.id)).event).toMatchObject({
        title: "social",
        revision: 1,
      });
    });

    it("a cancelled source changes nothing, and says so while you follow it", async () => {
      const port = await makePort();
      const s = await school(port, "cancelled");
      // Another calendar of hers, listed before the school: the name is the school's.
      const other = await follow(
        port,
        { kind: "person", personId: s.ann },
        "https://club.example/aaa.ics",
        T0,
      );
      if (!other.ok) throw new Error("follow");
      await refreshCalendar(
        port,
        serving(FEED.replace("X-WR-CALNAME:Swing school", "X-WR-CALNAME:Aaa club")),
        other.calendarId,
        T0,
      );
      const id = await gone(port, s);
      expect(await cancelledBy(port, s.ann, id)).toBeNull();
      const CANCELLED = MOVED.replace("LOCATION:Old Mill", "LOCATION:Old Mill\r\nSTATUS:CANCELLED");
      await refreshCalendar(port, serving(CANCELLED), s.calendarId, LATER_T);
      expect((await yours(port, s.ann, id)).event).toMatchObject({
        title: "social",
        status: "scheduled",
        revision: 1,
      });
      expect(await cancelledBy(port, s.ann, id)).toBe("Swing school");
      // Not gone to, not there, or someone who follows nothing: nothing.
      const mine = await createEvent(port, {
        creatorId: s.ann,
        group: null,
        fields: {
          title: "x",
          description: null,
          location: null,
          allDay: true,
          startLocal: "2026-12-03",
          endLocal: "2026-12-04",
          tzid: null,
        },
        now: T0,
      });
      expect(await cancelledBy(port, s.ann, mine.id)).toBeNull();
      expect(await cancelledBy(port, s.ann, "no-such-event")).toBeNull();
      expect(await cancelledBy(port, s.carl, id)).toBeNull();
      // Dropped out of the feed altogether: it may only have ended, so nothing is said.
      const DROPPED = FEED.split("BEGIN:VEVENT")
        .filter((part) => !part.includes("UID:social"))
        .join("BEGIN:VEVENT");
      await refreshCalendar(port, serving(DROPPED), s.calendarId, LATER_T);
      expect(await cancelledBy(port, s.ann, id)).toBeNull();
      expect((await yours(port, s.ann, id)).event).toMatchObject({ title: "social", revision: 1 });
    });

    it("an edit of yours landing while the source's is written wins, and it is yours", async () => {
      const inner = await makePort();
      const s = await school(inner, "race");
      const id = await gone(inner, s);
      // The moment the source's change is written, an edit of Ann's lands first.
      let raced = false;
      const port: StoragePort = {
        query: (q) => inner.query(q),
        batch: async (stmts) => {
          if (!raced && stmts.some((x) => x.sql.includes("SET followed_until"))) {
            raced = true;
            const access = await yours(inner, s.ann, id);
            await editEvent(inner, access, {
              fields: { ...access.event, description: "Mine now" },
              actorId: s.ann,
              now: T0,
            });
          }
          return inner.batch(stmts);
        },
      };
      const moved = await followSource(port, {
        calendarId: s.calendarId,
        source: {
          uid: "social",
          status: "confirmed",
          title: "Social night",
          location: "Hall",
          description: null,
          allDay: false,
          startLocal: "2026-11-26T19:00:00",
          endLocal: "2026-11-26T22:00:00",
          tzid: "Europe/Prague",
        },
        now: LATER_T,
      });
      expect(raced).toBe(true);
      expect(moved).toBe(0);
      expect((await yours(inner, s.ann, id)).event).toMatchObject({
        title: "social",
        description: "Mine now",
        revision: 2,
      });
      expect(await until(inner, id)).toBe("1");
      // Not raced, it counts what it moved: one event here.
      const t = await school(inner, "count");
      await gone(inner, t);
      expect(
        await followSource(inner, {
          calendarId: t.calendarId,
          source: {
            uid: "social",
            status: "confirmed",
            title: "Social night",
            location: "Hall",
            description: null,
            allDay: false,
            startLocal: "2026-11-26T19:00:00",
            endLocal: "2026-11-26T22:00:00",
            tzid: "Europe/Prague",
          },
          now: LATER_T,
        }),
      ).toBe(1);
    });

    it("stopping following keeps the event, and it follows no more", async () => {
      const port = await makePort();
      const s = await school(port, "stop");
      const id = await gone(port, s);
      const groupFollower = { kind: "group", groupId: s.groupId, actorId: s.ann } as const;
      expect(await stopFollowing(port, { kind: "person", personId: s.ann }, s.ownFollowId)).toBe(
        true,
      );
      expect(await stopFollowing(port, groupFollower, s.groupFollowId)).toBe(true);
      expect((await yours(port, s.ann, id)).event.title).toBe("social");
      // Followed again, it is a calendar of its own: the event isn't picked up again.
      const again = await follow(
        port,
        { kind: "person", personId: s.ann },
        "https://club.example/stop.ics",
        LATER_T,
      );
      if (!again.ok) throw new Error("follow");
      await refreshCalendar(port, serving(MOVED), again.calendarId, LATER_T);
      expect((await yours(port, s.ann, id)).event).toMatchObject({ title: "social", revision: 1 });
    });

    it("a change that leaves no event, or only a link, changes nothing", async () => {
      const port = await makePort();
      const s = await school(port, "still");
      const id = await gone(port, s);
      // The link only: the cache changes, your event doesn't.
      const LINK = FEED.replace("URL:https://club.example/s", "URL:https://club.example/t");
      await refreshCalendar(port, serving(LINK), s.calendarId, LATER_T);
      expect((await yours(port, s.ann, id)).event.revision).toBe(1);
      // Now a moment with no length: it can't be an event, so yours stays.
      const MOMENT = FEED.replace("DTEND:20261126T210000Z", "DTEND:20261126T180000Z");
      await refreshCalendar(port, serving(MOMENT), s.calendarId, LATER_T);
      expect((await yours(port, s.ann, id)).event).toMatchObject({
        endLocal: "2026-11-26T22:00:00",
        revision: 1,
      });
    });
  });
}
