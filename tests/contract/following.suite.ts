// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import type { PublicGet, PublicResponse } from "../../src/following/fetch.js";
import {
  calendarsDue,
  FETCH_EVERY_MINUTES,
  FOLLOW_COLOURS,
  follow,
  followingPass,
  followLog,
  refreshCalendar,
  stopFollowing,
} from "../../src/following/follow.js";
import { readFeed } from "../../src/following/read.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { eraseAccount } from "../../src/privacy/erasure.js";
import { exportPerson } from "../../src/privacy/export.js";
import { retentionPass, unfollowedSweep } from "../../src/privacy/purge.js";
import { pullTurn } from "../../src/reconcile/tick.js";

// Following calendars (DESIGN §10 rc56/rc57) on BOTH drivers: following for yourself and for a
// group, one row per link however many follow it, the calendar going with its last follower,
// and a fetch keeping only a difference — an unchanged calendar writes nothing.

const T0 = "2026-11-21T12:00:00.000Z";
const T1 = "2026-11-21T18:00:00.000Z";

const CAL = (...events: string[][]) =>
  [
    "BEGIN:VCALENDAR",
    "X-WR-CALNAME:Swing school",
    "X-WR-TIMEZONE:Europe/Prague",
    ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");
const SOCIAL = [
  "UID:social",
  "DTSTART:20261126T180000Z",
  "DTEND:20261126T210000Z",
  "SUMMARY:Social",
];
const CLASS = ["UID:class", "DTSTART:20261201T180000Z", "DTEND:20261201T193000Z", "SUMMARY:Class"];

function answer(status: number, text = "", headers: Record<string, string> = {}): PublicResponse {
  return {
    status,
    header: (n) => headers[n.toLowerCase()] ?? null,
    // A body read afresh each time, so one answer can be given again.
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
  };
}

/** A calendar server that answers what it's told to, and counts how often it was asked. */
function server(first: PublicResponse) {
  let next = first;
  let asked = 0;
  const get: PublicGet = async () => {
    asked++;
    return next;
  };
  return {
    get,
    answers: (r: PublicResponse) => {
      next = r;
    },
    asked: () => asked,
  };
}

/** Writes, counted: every batch that isn't empty. A steady state makes none (§6). */
function counting(port: StoragePort) {
  let writes = 0;
  let empty = 0;
  const counted: StoragePort = {
    query: (s) => {
      if (!/^\s*SELECT/i.test(s.sql)) writes++;
      return port.query(s);
    },
    batch: async (stmts) => {
      // D1 refuses an empty batch: a refresh must never send one.
      if (stmts.length === 0) empty++;
      else writes++;
      await port.batch(stmts);
    },
  };
  return { port: counted, writes: () => writes, empty: () => empty };
}

async function people(port: StoragePort, tag: string) {
  const ann = await findOrCreatePerson(port, `follow-ann-${tag}@example.org`, { now: T0 });
  const group = await createGroup(port, { name: `Dancers ${tag}`, creatorId: ann.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, ann.id);
  if (membership === null) throw new Error("membership");
  const invite = await createInvite(port, membership, {
    email: `follow-bob-${tag}@example.org`,
    invitedBy: ann.id,
    editTier: "view",
    visibility: "FULL",
    now: T0,
  });
  if (!invite.ok) throw new Error(invite.reason);
  const accepted = await acceptInvite(port, invite.token, T0);
  if (accepted === null) throw new Error("accept");
  return { ann: ann.id, bob: accepted.personId, group: group.id };
}

const events = async (port: StoragePort, calendarId: string) =>
  (
    await port.query({
      sql: "SELECT uid, title, start_local FROM followed_event WHERE calendar_id = ? ORDER BY uid",
      params: [calendarId],
    })
  ).map((r) => `${r.uid} ${r.title} ${r.start_local}`);

const calendar = async (port: StoragePort, calendarId: string) =>
  (
    await port.query({
      sql: "SELECT name, status, left_out, etag, fetched_at FROM followed_calendar WHERE id = ?",
      params: [calendarId],
    })
  )[0];

export function runFollowingContract(makePort: () => Promise<StoragePort>): void {
  describe("following calendars (rc56/rc57)", () => {
    it("one row per link however many follow it; a follower's second follow is the same follow", async () => {
      const port = await makePort();
      const { ann, bob, group } = await people(port, "one-row");
      const url = "https://club.example/one-row.ics";
      const a = await follow(port, { kind: "person", personId: ann }, url, T0);
      const again = await follow(port, { kind: "person", personId: ann }, url, T1);
      const b = await follow(port, { kind: "person", personId: bob }, url, T0);
      const g = await follow(port, { kind: "group", groupId: group, actorId: ann }, url, T0);
      if (!a.ok || !again.ok || !b.ok || !g.ok) throw new Error("followed");
      expect(again.followId).toBe(a.followId);
      expect(new Set([a.calendarId, b.calendarId, g.calendarId]).size).toBe(1);
      expect(new Set([a.followId, b.followId, g.followId]).size).toBe(3);
      expect(a.fetchNow).toBe(true); // never fetched: following fetches it at once
      await refreshCalendar(port, server(answer(200, CAL())).get, a.calendarId, T0);
      const late = await follow(port, { kind: "person", personId: bob }, url, T1);
      expect(late.ok && late.fetchNow).toBe(false); // already fetched for the others
    });

    it("someone outside a group can't follow for it", async () => {
      const port = await makePort();
      const { group } = await people(port, "outsider");
      const eve = await findOrCreatePerson(port, "follow-eve-outsider@example.org", { now: T0 });
      expect(
        await follow(
          port,
          { kind: "group", groupId: group, actorId: eve.id },
          "https://club.example/o.ics",
          T0,
        ),
      ).toEqual({ ok: false, reason: "not-organizer" });
    });

    it("only a group's organizer follows for it, and stops it", async () => {
      const port = await makePort();
      const { ann, bob, group } = await people(port, "organizer");
      const url = "https://club.example/organizer.ics";
      expect(await follow(port, { kind: "group", groupId: group, actorId: bob }, url, T0)).toEqual({
        ok: false,
        reason: "not-organizer",
      });
      const g = await follow(port, { kind: "group", groupId: group, actorId: ann }, url, T0);
      if (!g.ok) throw new Error("followed");
      expect(
        await stopFollowing(port, { kind: "group", groupId: group, actorId: bob }, g.followId),
      ).toBe(false);
      // Nor is a group's follow stopped as a person's, or another person's as yours.
      expect(await stopFollowing(port, { kind: "person", personId: ann }, g.followId)).toBe(false);
      expect(
        await stopFollowing(port, { kind: "group", groupId: group, actorId: ann }, g.followId),
      ).toBe(true);
      // Nor anyone's follow but their own.
      const bobs = await follow(port, { kind: "person", personId: bob }, url, T0);
      if (!bobs.ok) throw new Error("followed");
      expect(await stopFollowing(port, { kind: "person", personId: ann }, bobs.followId)).toBe(
        false,
      );
      expect(
        await stopFollowing(port, { kind: "group", groupId: group, actorId: ann }, bobs.followId),
      ).toBe(false);
    });

    it("a follower's calendars get colours of their own, the first free one each time", async () => {
      const port = await makePort();
      const { ann } = await people(port, "colours");
      const me = { kind: "person", personId: ann } as const;
      const colours: string[] = [];
      for (let i = 0; i < FOLLOW_COLOURS.length + 1; i++) {
        const f = await follow(port, me, `https://club.example/colour-${i}.ics`, T0);
        if (!f.ok) throw new Error("followed");
        const [row] = await port.query({
          sql: "SELECT colour FROM calendar_follow WHERE id = ?",
          params: [f.followId],
        });
        colours.push(String(row?.colour));
      }
      expect(colours.slice(0, FOLLOW_COLOURS.length)).toEqual([...FOLLOW_COLOURS]);
      expect(colours.at(-1)).toBe("f1"); // all in use: round again
    });

    it("your colours and a group's are counted apart", async () => {
      const port = await makePort();
      const { ann, bob, group } = await people(port, "apart");
      for (const i of [1, 2]) {
        const theirs = { kind: "person", personId: bob } as const;
        await follow(port, theirs, `https://club.example/apart-b${i}.ics`, T0);
        const g = { kind: "group", groupId: group, actorId: ann } as const;
        await follow(port, g, `https://club.example/apart-g${i}.ics`, T0);
      }
      const me = { kind: "person", personId: ann } as const;
      const mine = await follow(port, me, "https://club.example/apart-me.ics", T0);
      if (!mine.ok) throw new Error("followed");
      const [row] = await port.query({
        sql: "SELECT colour FROM calendar_follow WHERE id = ?",
        params: [mine.followId],
      });
      expect(row?.colour).toBe("f1");
    });

    it("a colour freed by stopping is the next one given; past them all, they go round", async () => {
      const port = await makePort();
      const { ann } = await people(port, "freed");
      const me = { kind: "person", personId: ann } as const;
      const colourOf = async (i: number) => {
        const f = await follow(port, me, `https://club.example/freed-${i}.ics`, T0);
        if (!f.ok) throw new Error("followed");
        const [row] = await port.query({
          sql: "SELECT colour FROM calendar_follow WHERE id = ?",
          params: [f.followId],
        });
        return { id: f.followId, colour: String(row?.colour) };
      };
      await colourOf(0);
      const second = await colourOf(1);
      await colourOf(2);
      await stopFollowing(port, me, second.id);
      expect((await colourOf(3)).colour).toBe("f2");
      for (let i = 4; i < FOLLOW_COLOURS.length + 2; i++) await colourOf(i); // 4..7: f4-f6, then f1
      // Seven in use, all six taken: the eighth is the second colour round again.
      expect((await colourOf(99)).colour).toBe("f2");
    });

    it("the calendar goes, with its events, when its last follower stops", async () => {
      const port = await makePort();
      const { ann, bob } = await people(port, "last");
      const url = "https://club.example/last.ics";
      const a = await follow(port, { kind: "person", personId: ann }, url, T0);
      const b = await follow(port, { kind: "person", personId: bob }, url, T0);
      if (!a.ok || !b.ok) throw new Error("followed");
      await refreshCalendar(port, server(answer(200, CAL(SOCIAL))).get, a.calendarId, T0);
      expect(await events(port, a.calendarId)).toHaveLength(1);

      expect(await stopFollowing(port, { kind: "person", personId: ann }, a.followId)).toBe(true);
      expect(await calendar(port, a.calendarId)).toBeDefined(); // Bob still follows it
      expect(await stopFollowing(port, { kind: "person", personId: bob }, b.followId)).toBe(true);
      expect(await calendar(port, a.calendarId)).toBeUndefined();
      expect(await events(port, a.calendarId)).toEqual([]);
      expect(await stopFollowing(port, { kind: "person", personId: bob }, b.followId)).toBe(false);
    });

    it("the sweep takes a calendar whose followers went another way, and none still followed", async () => {
      const port = await makePort();
      const { ann, bob } = await people(port, "sweep");
      const gone = await follow(
        port,
        { kind: "person", personId: ann },
        "https://club.example/s1.ics",
        T0,
      );
      const kept = await follow(
        port,
        { kind: "person", personId: bob },
        "https://club.example/s2.ics",
        T0,
      );
      if (!gone.ok || !kept.ok) throw new Error("followed");
      // As a person's deletion does, by cascade.
      await port.batch([
        { sql: "DELETE FROM calendar_follow WHERE id = ?", params: [gone.followId] },
      ]);
      await port.batch([unfollowedSweep()]);
      expect(await calendar(port, gone.calendarId)).toBeUndefined();
      expect(await calendar(port, kept.calendarId)).toBeDefined();
    });

    it("a fetch keeps what's on, then only a difference; an unchanged calendar writes nothing", async () => {
      const raw = await makePort();
      const { port, writes } = counting(raw);
      const { ann } = await people(raw, "diff");
      const f = await follow(
        raw,
        { kind: "person", personId: ann },
        "https://club.example/diff.ics",
        T0,
      );
      if (!f.ok) throw new Error("followed");
      const club = server(answer(200, CAL(SOCIAL, CLASS)));

      expect(await refreshCalendar(port, club.get, f.calendarId, T0)).toEqual({
        outcome: "fetched",
        added: 2,
        changed: 0,
        removed: 0,
      });
      expect(await events(raw, f.calendarId)).toEqual([
        "class Class 2026-12-01T19:00:00",
        "social Social 2026-11-26T19:00:00",
      ]);
      expect(await calendar(raw, f.calendarId)).toMatchObject({
        name: "Swing school",
        status: "ok",
        left_out: 0,
        fetched_at: T0,
      });

      const before = writes();
      expect(await refreshCalendar(port, club.get, f.calendarId, T1)).toEqual({
        outcome: "fetched",
        added: 0,
        changed: 0,
        removed: 0,
      });
      expect(writes()).toBe(before); // the same body: nothing written, fetched_at stays
      expect((await calendar(raw, f.calendarId))?.fetched_at).toBe(T0);

      const moved = [
        "UID:class",
        "DTSTART:20261202T180000Z",
        "DTEND:20261202T193000Z",
        "SUMMARY:Class",
      ];
      club.answers(answer(200, CAL(moved)));
      expect(await refreshCalendar(port, club.get, f.calendarId, T1)).toEqual({
        outcome: "fetched",
        added: 0,
        changed: 1,
        removed: 1,
      });
      expect(await events(raw, f.calendarId)).toEqual(["class Class 2026-12-02T19:00:00"]);
      expect((await calendar(raw, f.calendarId))?.fetched_at).toBe(T1);
    });

    it("notices a change to any one field, and an unchanged all-day event as unchanged", async () => {
      const raw = await makePort();
      const { ann } = await people(raw, "fields");
      const f = await follow(
        raw,
        { kind: "person", personId: ann },
        "https://club.example/fields.ics",
        T0,
      );
      if (!f.ok) throw new Error("followed");
      const base = [
        "UID:e",
        "DTSTART;TZID=Europe/Prague:20261201T190000",
        "DTEND;TZID=Europe/Prague:20261201T210000",
        "SUMMARY:Social",
        "LOCATION:Studio",
        "DESCRIPTION:Bring shoes",
        "URL:https://club.example/e",
      ];
      const day = ["UID:d", "DTSTART;VALUE=DATE:20261205", "SUMMARY:Festival"];
      const club = server(answer(200, CAL(base, day)));
      await refreshCalendar(raw, club.get, f.calendarId, T0);
      const swap = (from: string, to: string) => base.map((l) => (l === from ? to : l));
      const variants = [
        swap("SUMMARY:Social", "SUMMARY:Social!"),
        swap("LOCATION:Studio", "LOCATION:Hall"),
        swap("DESCRIPTION:Bring shoes", "DESCRIPTION:Bring water"),
        swap("URL:https://club.example/e", "URL:https://club.example/f"),
        swap(
          "DTSTART;TZID=Europe/Prague:20261201T190000",
          "DTSTART;TZID=Europe/Prague:20261201T183000",
        ),
        swap(
          "DTEND;TZID=Europe/Prague:20261201T210000",
          "DTEND;TZID=Europe/Prague:20261201T220000",
        ),
        base.map((l) => l.replace("Europe/Prague", "Europe/Vienna")),
        [...base, "STATUS:CANCELLED"],
        ["UID:e", "DTSTART;VALUE=DATE:20261201", ...base.slice(3)],
      ];
      const stored = async () =>
        (
          await raw.query({
            sql: `SELECT title, location, description, url, start_local, end_local, tzid, all_day, status
                  FROM followed_event WHERE calendar_id = ? AND uid = 'e'`,
            params: [f.calendarId],
          })
        )[0];
      for (const v of variants) {
        // From the base each time, so each variant differs from what is kept in one field only.
        club.answers(answer(200, CAL(base, day)));
        await refreshCalendar(raw, club.get, f.calendarId, T0);
        club.answers(answer(200, CAL(v, day)));
        expect(await refreshCalendar(raw, club.get, f.calendarId, T0), v.join("|")).toEqual({
          outcome: "fetched",
          added: 0,
          changed: 1,
          removed: 0,
        });
        // What is kept is what the feed now says, every field of it.
        const r = readFeed(CAL(v, day), T0);
        const want = r.ok ? r.events.find((e) => e.uid === "e") : undefined;
        expect(await stored(), v.join("|")).toEqual({
          title: want?.title,
          location: want?.location,
          description: want?.description,
          url: want?.url,
          start_local: want?.startLocal,
          end_local: want?.endLocal,
          tzid: want?.tzid,
          all_day: want?.allDay ? 1 : 0,
          status: want?.status,
        });
      }
    });

    it("keeps the calendar's own changes — its name, validators, events left out — and a first empty fetch", async () => {
      const raw = await makePort();
      const { port, writes, empty } = counting(raw);
      const { ann } = await people(raw, "own");
      const f = await follow(
        raw,
        { kind: "person", personId: ann },
        "https://club.example/own.ics",
        T0,
      );
      if (!f.ok) throw new Error("followed");
      const club = server(answer(200, CAL()));
      await refreshCalendar(port, club.get, f.calendarId, T0);
      expect(await calendar(raw, f.calendarId)).toMatchObject({
        name: "Swing school",
        fetched_at: T0,
      });

      const renamed = CAL().replace("Swing school", "Swing school Brno");
      club.answers(answer(200, renamed));
      await refreshCalendar(port, club.get, f.calendarId, T1);
      expect(await calendar(raw, f.calendarId)).toMatchObject({
        name: "Swing school Brno",
        fetched_at: T1,
      });

      club.answers(answer(200, renamed, { etag: '"v2"' }));
      await refreshCalendar(port, club.get, f.calendarId, T1);
      expect((await calendar(raw, f.calendarId))?.etag).toBe('"v2"');

      club.answers(answer(200, renamed, { etag: '"v2"', "last-modified": "Sun" }));
      await refreshCalendar(port, club.get, f.calendarId, T1);
      const [lm] = await raw.query({
        sql: "SELECT last_modified FROM followed_calendar WHERE id = ?",
        params: [f.calendarId],
      });
      expect(lm?.last_modified).toBe("Sun");

      // One event it can't read (no start), and nothing else new: only the count changes.
      const named = (...e: string[][]) => CAL(...e).replace("Swing school", "Swing school Brno");
      const validators = { etag: '"v2"', "last-modified": "Sun" };
      club.answers(answer(200, named(SOCIAL), validators));
      await refreshCalendar(port, club.get, f.calendarId, T1);
      club.answers(answer(200, named(SOCIAL, ["UID:bad"]), validators));
      await refreshCalendar(port, club.get, f.calendarId, T1);
      expect(await calendar(raw, f.calendarId)).toMatchObject({ left_out: 1 });

      const before = writes();
      await refreshCalendar(port, club.get, f.calendarId, T1);
      expect(writes()).toBe(before);
      expect(empty()).toBe(0);
    });

    it("a day that becomes midnight to midnight is a change: all-day is a field of its own", async () => {
      const port = await makePort();
      const { ann } = await people(port, "allday");
      const me = { kind: "person", personId: ann } as const;
      const f = await follow(port, me, "https://club.example/allday.ics", T0);
      if (!f.ok) throw new Error("followed");
      const club = server(answer(200, CAL(["UID:d", "DTSTART;VALUE=DATE:20261205"])));
      await refreshCalendar(port, club.get, f.calendarId, T0);
      club.answers(answer(200, CAL(["UID:d", "DTSTART:20261205T000000", "DTEND:20261206T000000"])));
      expect(await refreshCalendar(port, club.get, f.calendarId, T0)).toMatchObject({ changed: 1 });
    });

    it("a first fetch of an empty, nameless calendar still says when it was fetched", async () => {
      const port = await makePort();
      const { ann } = await people(port, "nameless");
      const me = { kind: "person", personId: ann } as const;
      const f = await follow(port, me, "https://club.example/nameless.ics", T0);
      if (!f.ok) throw new Error("followed");
      const blank = "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
      await refreshCalendar(port, server(answer(200, blank)).get, f.calendarId, T0);
      expect(await calendar(port, f.calendarId)).toMatchObject({ name: null, fetched_at: T0 });
    });

    it("never sends an empty batch: a refused or unreadable calendar marked once stays quiet", async () => {
      const raw = await makePort();
      const { port, empty } = counting(raw);
      const { ann } = await people(raw, "empty");
      const f = await follow(
        raw,
        { kind: "person", personId: ann },
        "https://club.example/empty.ics",
        T0,
      );
      if (!f.ok) throw new Error("followed");
      const club = server(answer(404));
      await refreshCalendar(port, club.get, f.calendarId, T0);
      await refreshCalendar(port, club.get, f.calendarId, T0);
      club.answers(answer(200, "not a calendar"));
      await refreshCalendar(port, club.get, f.calendarId, T0);
      club.answers(answer(302, "", { location: "http://x.example/" }));
      await refreshCalendar(port, club.get, f.calendarId, T0);
      await refreshCalendar(port, club.get, f.calendarId, T0);
      expect(empty()).toBe(0);
      club.answers(answer(304));
      expect(await refreshCalendar(port, club.get, f.calendarId, T0)).toEqual({
        outcome: "unchanged",
        added: 0,
        changed: 0,
        removed: 0,
      });
      club.answers(answer(500));
      expect(await refreshCalendar(port, club.get, f.calendarId, T0)).toEqual({
        outcome: "failed",
        added: 0,
        changed: 0,
        removed: 0,
      });
    });

    it("a fetch touches only its own calendar: the other's events and row stay as they were", async () => {
      const port = await makePort();
      const { ann } = await people(port, "two");
      const me = { kind: "person", personId: ann } as const;
      const a = await follow(port, me, "https://club.example/two-a.ics", T0);
      const b = await follow(port, me, "https://club.example/two-b.ics", T0);
      if (!a.ok || !b.ok) throw new Error("followed");
      await refreshCalendar(port, server(answer(200, CAL(SOCIAL))).get, b.calendarId, T0);
      const of = async (id: string) => ({
        row: await calendar(port, id),
        events: await events(port, id),
      });
      const bBefore = await of(b.calendarId);
      const other = CAL(CLASS).replace("Swing school", "Other");
      const club = server(answer(200, other, { etag: '"a"' }));
      expect(await refreshCalendar(port, club.get, a.calendarId, T1)).toEqual({
        outcome: "fetched",
        added: 1,
        changed: 0,
        removed: 0,
      });
      club.answers(answer(404));
      await refreshCalendar(port, club.get, a.calendarId, T1);
      expect(await of(b.calendarId)).toEqual(bBefore);
      expect(await events(port, a.calendarId)).toEqual(["class Class 2026-12-01T19:00:00"]);
    });

    it("a calendar whose follows went by cascade isn't due, before any sweep", async () => {
      const port = await makePort();
      const { ann } = await people(port, "orphan");
      const me = { kind: "person", personId: ann } as const;
      const f = await follow(port, me, "https://club.example/orphan.ics", T0);
      if (!f.ok) throw new Error("followed");
      await port.batch([{ sql: "DELETE FROM calendar_follow WHERE id = ?", params: [f.followId] }]);
      const at = new Date(pullTurn(f.calendarId) * 60_000).toISOString();
      expect(await calendarsDue(port, at)).not.toContain(f.calendarId);
    });

    it("asks with the validators it was given, and a 304 writes nothing", async () => {
      const raw = await makePort();
      const { port, writes } = counting(raw);
      const { ann } = await people(raw, "etag");
      const f = await follow(
        raw,
        { kind: "person", personId: ann },
        "https://club.example/etag.ics",
        T0,
      );
      if (!f.ok) throw new Error("followed");
      const seen: (string | undefined)[] = [];
      let status = 200;
      const get: PublicGet = async (_url, headers) => {
        seen.push(headers["if-none-match"]);
        return status === 200 ? answer(200, CAL(SOCIAL), { etag: '"v1"' }) : answer(304);
      };
      await refreshCalendar(port, get, f.calendarId, T0);
      expect((await calendar(raw, f.calendarId))?.etag).toBe('"v1"');
      status = 304;
      const before = writes();
      expect((await refreshCalendar(port, get, f.calendarId, T1)).outcome).toBe("unchanged");
      expect(writes()).toBe(before);
      expect(seen).toEqual([undefined, '"v1"']);
    });

    it("a feed that isn't a calendar, or refused, is marked and keeps its events; a failure changes nothing", async () => {
      const raw = await makePort();
      const { port, writes } = counting(raw);
      const { ann } = await people(raw, "bad");
      const f = await follow(
        raw,
        { kind: "person", personId: ann },
        "https://club.example/bad.ics",
        T0,
      );
      if (!f.ok) throw new Error("followed");
      const club = server(answer(200, CAL(SOCIAL)));
      await refreshCalendar(port, club.get, f.calendarId, T0);

      club.answers(answer(200, "<html>moved to our new site</html>"));
      expect((await refreshCalendar(port, club.get, f.calendarId, T1)).outcome).toBe("unreadable");
      expect(await calendar(raw, f.calendarId)).toMatchObject({ status: "unreadable" });
      expect(await events(raw, f.calendarId)).toHaveLength(1); // never half-applied
      const marked = writes();
      await refreshCalendar(port, club.get, f.calendarId, T1);
      expect(writes()).toBe(marked); // still unreadable: nothing more written

      club.answers(answer(503));
      expect((await refreshCalendar(port, club.get, f.calendarId, T1)).outcome).toBe("failed");
      expect(writes()).toBe(marked);

      club.answers(answer(404));
      expect((await refreshCalendar(port, club.get, f.calendarId, T1)).outcome).toBe("gone");
      expect(await calendar(raw, f.calendarId)).toMatchObject({ status: "unreadable" });

      club.answers(answer(302, "", { location: "http://club.example/plain.ics" }));
      expect((await refreshCalendar(port, club.get, f.calendarId, T1)).outcome).toBe("refused");
      expect(await calendar(raw, f.calendarId)).toMatchObject({ status: "refused" });

      club.answers(answer(200, CAL(SOCIAL)));
      expect((await refreshCalendar(port, club.get, f.calendarId, T1)).outcome).toBe("fetched");
      expect(await calendar(raw, f.calendarId)).toMatchObject({ status: "ok" });
    });

    it("each followed calendar is due in its own minute of every six hours, only while followed", async () => {
      const port = await makePort();
      const { ann } = await people(port, "due");
      const f = await follow(
        port,
        { kind: "person", personId: ann },
        "https://club.example/due.ics",
        T0,
      );
      if (!f.ok) throw new Error("followed");
      const turn = pullTurn(f.calendarId);
      const at = (minute: number) => new Date(minute * 60_000).toISOString();
      expect(await calendarsDue(port, at(turn))).toContain(f.calendarId);
      expect(await calendarsDue(port, at(turn + FETCH_EVERY_MINUTES))).toContain(f.calendarId);
      expect(await calendarsDue(port, at(turn + 1))).not.toContain(f.calendarId);
      await stopFollowing(port, { kind: "person", personId: ann }, f.followId);
      expect(await calendarsDue(port, at(turn))).not.toContain(f.calendarId);
    });

    it("a minute's pass fetches the calendars due then, and logs only a change, never the link", async () => {
      const port = await makePort();
      const { ann } = await people(port, "pass");
      const url = "https://club.example/pass.ics?key=secret";
      const f = await follow(port, { kind: "person", personId: ann }, url, T0);
      if (!f.ok) throw new Error("followed");
      const club = server(answer(200, CAL(SOCIAL)));
      // The calendar's own minute, in the six hours from midnight on T0's day.
      const base = Date.parse("2026-11-21T00:00:00Z") / 60_000;
      const offset =
        (pullTurn(f.calendarId) - (base % FETCH_EVERY_MINUTES) + FETCH_EVERY_MINUTES) %
        FETCH_EVERY_MINUTES;
      const at = new Date((base + offset) * 60_000).toISOString();
      const first = await followingPass(port, club.get, at);
      const mine = first.find((d) => d.calendarId === f.calendarId);
      expect(mine?.refreshed).toMatchObject({ outcome: "fetched", added: 1 });
      const line = followLog(
        f.calendarId,
        mine?.refreshed ?? { outcome: "missing", added: 0, changed: 0, removed: 0 },
      );
      expect(line).toEqual({
        reason: "followed_fetch",
        calendar: f.calendarId,
        outcome: "fetched",
        added: 1,
        changed: 0,
        removed: 0,
      });
      expect(JSON.stringify(line)).not.toContain("secret");
      const again = (await followingPass(port, club.get, at)).find(
        (d) => d.calendarId === f.calendarId,
      );
      expect(
        followLog(
          f.calendarId,
          again?.refreshed ?? { outcome: "missing", added: 0, changed: 0, removed: 0 },
        ),
      ).toBeNull();
      expect(followLog("c", { outcome: "unchanged", added: 0, changed: 0, removed: 0 })).toBeNull();
      for (const counts of [
        { added: 0, changed: 1, removed: 1 },
        { added: 1, changed: 1, removed: 0 },
      ]) {
        expect(followLog("c", { outcome: "fetched", ...counts })).not.toBeNull();
      }
      expect(first.every((d) => typeof d.calendarId === "string")).toBe(true);
      expect(followLog("c", { outcome: "failed", added: 0, changed: 0, removed: 0 })).toMatchObject(
        { outcome: "failed" },
      );
    });

    it("the retention pass sweeps a calendar nobody follows any more", async () => {
      const port = await makePort();
      const { ann } = await people(port, "retain");
      const f = await follow(
        port,
        { kind: "person", personId: ann },
        "https://club.example/retain.ics",
        T0,
      );
      if (!f.ok) throw new Error("followed");
      await retentionPass(port, T1);
      expect(await calendar(port, f.calendarId)).toBeDefined();
      await port.batch([{ sql: "DELETE FROM calendar_follow WHERE id = ?", params: [f.followId] }]);
      await retentionPass(port, T1);
      expect(await calendar(port, f.calendarId)).toBeUndefined();
    });

    it("your export holds the calendars you follow, not what they hold; erasing you stops them", async () => {
      const port = await makePort();
      const { ann, group } = await people(port, "export");
      const url = "https://club.example/export.ics";
      const mine = await follow(port, { kind: "person", personId: ann }, url, T0);
      await follow(
        port,
        { kind: "group", groupId: group, actorId: ann },
        "https://club.example/g.ics",
        T0,
      );
      if (!mine.ok) throw new Error("followed");
      await refreshCalendar(port, server(answer(200, CAL(SOCIAL))).get, mine.calendarId, T0);
      const doc = await exportPerson(port, ann, T1);
      expect(doc.calendars_you_follow).toEqual([
        { link: url, name: "Swing school", colour: "f1", since: T0 },
      ]);
      expect(JSON.stringify(doc)).not.toContain("Social");
      await eraseAccount(port, ann, { now: T1 });
      const left = await port.query({
        sql: "SELECT count(*) AS n FROM calendar_follow WHERE person_id = ?",
        params: [ann],
      });
      expect(left[0]?.n).toBe(0);
      // Nobody follows it now: the retention pass takes it, with what it held.
      await retentionPass(port, T1);
      expect(await calendar(port, mine.calendarId)).toBeUndefined();
    });

    it("a refresh of a calendar that's gone is a no-op", async () => {
      const port = await makePort();
      expect(
        (await refreshCalendar(port, server(answer(200)).get, "no-such-calendar", T0)).outcome,
      ).toBe("missing");
    });
  });
}
