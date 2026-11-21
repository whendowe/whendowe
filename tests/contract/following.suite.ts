// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import type { PublicGet, PublicResponse } from "../../src/following/fetch.js";
import {
  calendarsDue,
  FETCH_EVERY_MINUTES,
  FOLLOW_COLOURS,
  follow,
  refreshCalendar,
  stopFollowing,
  unfollowedSweep,
} from "../../src/following/follow.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
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
  const counted: StoragePort = {
    query: (s) => {
      if (!/^\s*SELECT/i.test(s.sql)) writes++;
      return port.query(s);
    },
    batch: async (stmts) => {
      if (stmts.length > 0) writes++;
      await port.batch(stmts);
    },
  };
  return { port: counted, writes: () => writes };
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
      expect(FOLLOW_COLOURS).toContain(colours.at(-1));
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
      await port.batch([unfollowedSweep(null)]);
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

    it("a refresh of a calendar that's gone is a no-op", async () => {
      const port = await makePort();
      expect(
        (await refreshCalendar(port, server(answer(200)).get, "no-such-calendar", T0)).outcome,
      ).toBe("missing");
    });
  });
}
