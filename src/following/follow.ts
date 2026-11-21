// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { type SqlStatement, type StoragePort, stmt } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { findGroupForMember } from "../people/group.js";
import { unfollowedSweep } from "../privacy/purge.js";
import { PULL_EVERY_MINUTES, pullTurn } from "../reconcile/tick.js";
import { type FetchOutcome, fetchFeed, type PublicGet } from "./fetch.js";
import { type FollowedEventRow, readFeed } from "./read.js";

// Following a calendar (DESIGN §10 rc56/rc57): for yourself, or — by its organizers — for a
// group, which every member then sees. One followed_calendar per link however many follow it;
// it is fetched in its own minute of every six hours, worked out from its id as the Google
// backstop is (rc53), and only while someone follows it. What a fetch brings is compared with
// what is kept and only a difference is written (§6): an unchanged calendar writes nothing.

/** Who follows: a person for themselves, or a group, followed by one of its organizers. */
export type Follower =
  | { readonly kind: "person"; readonly personId: string }
  | { readonly kind: "group"; readonly groupId: string; readonly actorId: string };

/**
 * A followed calendar's colour: its own, never an option's letter colour (rc46). Stored as
 * the key; the page gives each key its colour.
 */
export const FOLLOW_COLOURS = ["f1", "f2", "f3", "f4", "f5", "f6"] as const;
export type FollowColour = (typeof FOLLOW_COLOURS)[number];

export type FollowResult =
  | {
      readonly ok: true;
      readonly followId: string;
      readonly calendarId: string;
      /** Never fetched yet: following a link fetches it at once (rc56). */
      readonly fetchNow: boolean;
    }
  | { readonly ok: false; readonly reason: "not-organizer" };

const followRowSchema = z.object({
  id: z.string(),
  calendar_id: z.string(),
  fetched_at: z.string().nullable(),
});
const colourRowSchema = z.object({ colour: z.string() });

/** The person or group a follower's rows name, as the two columns. */
function owner(f: Follower): readonly [string | null, string | null] {
  return f.kind === "person" ? [f.personId, null] : [null, f.groupId];
}

async function mayFollowFor(storage: StoragePort, f: Follower): Promise<boolean> {
  if (f.kind === "person") return true;
  return (await findGroupForMember(storage, f.groupId, f.actorId))?.role === "organizer";
}

/** The first colour this follower isn't using yet; past them all, round again. */
async function nextColour(storage: StoragePort, f: Follower): Promise<FollowColour> {
  const [personId, groupId] = owner(f);
  const used = (
    await storage.query(
      stmt(
        "SELECT colour FROM calendar_follow WHERE person_id IS ? AND group_id IS ?",
        personId,
        groupId,
      ),
    )
  ).map((r) => colourRowSchema.parse(r).colour);
  const free = FOLLOW_COLOURS.find((c) => !used.includes(c));
  return free ?? FOLLOW_COLOURS[used.length % FOLLOW_COLOURS.length] ?? "f1";
}

/**
 * Follow `url` (already a followable https: address, link.ts) — as many times as asked, one
 * follow per follower. The link's row is made with the first follow; one batch, so a calendar
 * never exists with nobody following it.
 */
export async function follow(
  storage: StoragePort,
  follower: Follower,
  url: string,
  now: string,
  newId: () => string = uuidv7,
): Promise<FollowResult> {
  if (!(await mayFollowFor(storage, follower))) return { ok: false, reason: "not-organizer" };
  const [personId, groupId] = owner(follower);
  const colour = await nextColour(storage, follower);
  await storage.batch([
    stmt(
      "INSERT INTO followed_calendar (id, url, created_at) VALUES (?, ?, ?) ON CONFLICT (url) DO NOTHING",
      newId(),
      url,
      now,
    ),
    stmt(
      `INSERT INTO calendar_follow (id, calendar_id, person_id, group_id, colour, created_at)
       SELECT ?, id, ?, ?, ?, ? FROM followed_calendar WHERE url = ?
       ON CONFLICT DO NOTHING`,
      newId(),
      personId,
      groupId,
      colour,
      now,
      url,
    ),
  ]);
  const [row] = await storage.query(
    stmt(
      `SELECT f.id, f.calendar_id, c.fetched_at
       FROM calendar_follow f JOIN followed_calendar c ON c.id = f.calendar_id
       WHERE c.url = ? AND f.person_id IS ? AND f.group_id IS ?`,
      url,
      personId,
      groupId,
    ),
  );
  const r = followRowSchema.parse(row);
  return { ok: true, followId: r.id, calendarId: r.calendar_id, fetchNow: r.fetched_at === null };
}

/**
 * Stop a follow of this follower's. When nobody follows the calendar any more, it goes, and
 * its events with it (a cache, rc56). False when there was no such follow of theirs.
 */
export async function stopFollowing(
  storage: StoragePort,
  follower: Follower,
  followId: string,
): Promise<boolean> {
  if (!(await mayFollowFor(storage, follower))) return false;
  const [personId, groupId] = owner(follower);
  const [row] = await storage.query(
    stmt(
      "SELECT 1 FROM calendar_follow WHERE id = ? AND person_id IS ? AND group_id IS ?",
      followId,
      personId,
      groupId,
    ),
  );
  if (row === undefined) return false;
  await storage.batch([
    stmt("DELETE FROM calendar_follow WHERE id = ?", followId),
    unfollowedSweep(),
  ]);
  return true;
}

/** A follow's own name, given on the page: at most this long (as a calendar's own is). */
export const MAX_FOLLOW_NAME = 200;

/**
 * Rename a follow of this follower's; an empty name goes back to the calendar's own. False
 * when there was no such follow of theirs.
 */
export async function renameFollow(
  storage: StoragePort,
  follower: Follower,
  followId: string,
  name: string,
): Promise<boolean> {
  if (!(await mayFollowFor(storage, follower))) return false;
  const [personId, groupId] = owner(follower);
  const named = name.trim().slice(0, MAX_FOLLOW_NAME);
  const rows = await storage.query(
    stmt(
      `UPDATE calendar_follow SET name = ? WHERE id = ? AND person_id IS ? AND group_id IS ?
       RETURNING id`,
      named === "" ? null : named,
      followId,
      personId,
      groupId,
    ),
  );
  return rows.length > 0;
}

/** Give a follow of this follower's another colour. False when there was no such follow. */
export async function recolourFollow(
  storage: StoragePort,
  follower: Follower,
  followId: string,
  colour: FollowColour,
): Promise<boolean> {
  if (!(await mayFollowFor(storage, follower))) return false;
  const [personId, groupId] = owner(follower);
  const rows = await storage.query(
    stmt(
      `UPDATE calendar_follow SET colour = ? WHERE id = ? AND person_id IS ? AND group_id IS ?
       RETURNING id`,
      colour,
      followId,
      personId,
      groupId,
    ),
  );
  return rows.length > 0;
}

/** A calendar someone sees as followed: their own follow, or one of a group they're in. */
export interface FollowShown {
  readonly followId: string;
  readonly calendarId: string;
  readonly url: string;
  /** What it is called here: the follow's own name, else the calendar's, else null. */
  readonly name: string | null;
  /** The name the follower gave it, which the rename form starts from. */
  readonly ownName: string | null;
  readonly colour: FollowColour;
  readonly status: "ok" | "unreadable" | "refused";
  readonly leftOut: number;
  /** When a fetch last changed what is kept; null before the first one. */
  readonly fetchedAt: string | null;
  /** The events kept: today to 60 days ahead, as of the last fetch. */
  readonly kept: number;
  /** null for your own; else the group, and whether you may change it (organizers only). */
  readonly group: {
    readonly id: string;
    readonly name: string;
    readonly organizer: boolean;
  } | null;
}

const shownRowSchema = z.object({
  id: z.string(),
  calendar_id: z.string(),
  url: z.string(),
  own_name: z.string().nullable(),
  calendar_name: z.string().nullable(),
  colour: z.enum(FOLLOW_COLOURS),
  status: z.enum(["ok", "unreadable", "refused"]),
  left_out: z.number(),
  fetched_at: z.string().nullable(),
  kept: z.number(),
  group_id: z.string().nullable(),
  group_name: z.string().nullable(),
  role: z.string().nullable(),
});

/**
 * What `personId` follows: their own follows first, then each group's they're a member of, by
 * group name; within each, by name. A group's follows are listed only to its members.
 */
export async function followsFor(storage: StoragePort, personId: string): Promise<FollowShown[]> {
  const rows = await storage.query(
    stmt(
      `SELECT f.id, f.calendar_id, c.url, f.name AS own_name, c.name AS calendar_name, f.colour,
              c.status, c.left_out, c.fetched_at,
              (SELECT count(*) FROM followed_event e WHERE e.calendar_id = c.id) AS kept,
              f.group_id, g.name AS group_name, m.role
       FROM calendar_follow f
       JOIN followed_calendar c ON c.id = f.calendar_id
       LEFT JOIN person_group g ON g.id = f.group_id
       LEFT JOIN group_member m ON m.group_id = f.group_id AND m.person_id = ?
       WHERE f.person_id = ? OR m.person_id IS NOT NULL
       ORDER BY f.group_id IS NOT NULL, g.name COLLATE NOCASE, g.id,
                coalesce(f.name, c.name, c.url) COLLATE NOCASE, f.id`,
      personId,
      personId,
    ),
  );
  return rows.map((row) => {
    const r = shownRowSchema.parse(row);
    return {
      followId: r.id,
      calendarId: r.calendar_id,
      url: r.url,
      name: r.own_name ?? r.calendar_name,
      ownName: r.own_name,
      colour: r.colour,
      status: r.status,
      leftOut: r.left_out,
      fetchedAt: r.fetched_at,
      kept: r.kept,
      group:
        r.group_id === null
          ? null
          : { id: r.group_id, name: r.group_name ?? "", organizer: r.role === "organizer" },
    };
  });
}

// ---------------------------------------------------------------------------
// Fetching, and keeping only a difference
// ---------------------------------------------------------------------------

/** How often each followed calendar is fetched (rc56): the backstop's six hours. */
export const FETCH_EVERY_MINUTES = PULL_EVERY_MINUTES;

/** The followed calendars whose turn it is in the minute `at`: someone follows them. Reads only. */
export async function calendarsDue(storage: StoragePort, at: string): Promise<string[]> {
  const minute = Math.floor(Date.parse(at) / 60_000) % FETCH_EVERY_MINUTES;
  return (
    await storage.query(
      stmt(
        `SELECT c.id FROM followed_calendar c
         WHERE EXISTS (SELECT 1 FROM calendar_follow f WHERE f.calendar_id = c.id)
         ORDER BY c.id`,
      ),
    )
  )
    .map((r) => z.object({ id: z.string() }).parse(r).id)
    .filter((id) => pullTurn(id) === minute);
}

const calendarRowSchema = z.object({
  url: z.string(),
  name: z.string().nullable(),
  etag: z.string().nullable(),
  last_modified: z.string().nullable(),
  fetched_at: z.string().nullable(),
  status: z.enum(["ok", "unreadable", "refused"]),
  left_out: z.number(),
});

const eventRowSchema = z.object({
  uid: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  start_local: z.string(),
  end_local: z.string(),
  tzid: z.string().nullable(),
  all_day: z.number(),
  status: z.enum(["confirmed", "cancelled"]),
});

function keptRow(r: z.infer<typeof eventRowSchema>): FollowedEventRow {
  return {
    uid: r.uid,
    title: r.title,
    location: r.location,
    description: r.description,
    url: r.url,
    startLocal: r.start_local,
    endLocal: r.end_local,
    tzid: r.tzid,
    allDay: r.all_day === 1,
    status: r.status,
  };
}

function sameEvent(a: FollowedEventRow, b: FollowedEventRow): boolean {
  return (
    a.title === b.title &&
    a.location === b.location &&
    a.description === b.description &&
    a.url === b.url &&
    a.startLocal === b.startLocal &&
    a.endLocal === b.endLocal &&
    a.tzid === b.tzid &&
    a.allDay === b.allDay &&
    a.status === b.status
  );
}

function upsert(calendarId: string, e: FollowedEventRow): SqlStatement {
  return stmt(
    `INSERT INTO followed_event
       (calendar_id, uid, title, location, description, url, start_local, end_local, tzid, all_day, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (calendar_id, uid) DO UPDATE SET
       title = excluded.title, location = excluded.location, description = excluded.description,
       url = excluded.url, start_local = excluded.start_local, end_local = excluded.end_local,
       tzid = excluded.tzid, all_day = excluded.all_day, status = excluded.status`,
    calendarId,
    e.uid,
    e.title,
    e.location,
    e.description,
    e.url,
    e.startLocal,
    e.endLocal,
    e.tzid,
    e.allDay ? 1 : 0,
    e.status,
  );
}

/** What a refresh did, for the log (§14): counts and the outcome, never content or the link. */
export interface Refreshed {
  readonly outcome: FetchOutcome["kind"] | "unreadable" | "missing";
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
}

/**
 * Fetch a followed calendar and keep what it holds now, writing only what differs: its
 * events (added, changed, gone), and its own row where its name, validators, status or count
 * left out changed. A fetch that may work next time (`failed`) changes nothing; one that
 * reads as no calendar marks it unreadable and keeps the events it had — never half-applied.
 */
export async function refreshCalendar(
  storage: StoragePort,
  get: PublicGet,
  calendarId: string,
  now: string,
): Promise<Refreshed> {
  const none = { added: 0, changed: 0, removed: 0 };
  const [row] = await storage.query(
    stmt(
      `SELECT url, name, etag, last_modified, fetched_at, status, left_out
       FROM followed_calendar WHERE id = ?`,
      calendarId,
    ),
  );
  if (row === undefined) return { outcome: "missing", ...none };
  const cal = calendarRowSchema.parse(row);
  const fetched = await fetchFeed(get, cal.url, {
    etag: cal.etag,
    lastModified: cal.last_modified,
  });

  const status = (s: "ok" | "unreadable" | "refused"): SqlStatement[] =>
    s === cal.status
      ? []
      : [
          stmt(
            "UPDATE followed_calendar SET status = ?, fetched_at = ? WHERE id = ?",
            s,
            now,
            calendarId,
          ),
        ];

  switch (fetched.kind) {
    case "unchanged":
    case "failed":
      return { outcome: fetched.kind, ...none };
    case "refused":
    case "gone": {
      const writes = status(fetched.kind === "refused" ? "refused" : "unreadable");
      if (writes.length > 0) await storage.batch(writes);
      return { outcome: fetched.kind, ...none };
    }
    case "fetched":
      break;
  }

  const read = readFeed(fetched.text, now);
  if (!read.ok) {
    const writes = status("unreadable");
    if (writes.length > 0) await storage.batch(writes);
    return { outcome: "unreadable", ...none };
  }

  const kept = new Map(
    (
      await storage.query(
        stmt(
          `SELECT uid, title, location, description, url, start_local, end_local, tzid, all_day, status
           FROM followed_event WHERE calendar_id = ?`,
          calendarId,
        ),
      )
    ).map((r) => {
      const e = keptRow(eventRowSchema.parse(r));
      return [e.uid, e] as const;
    }),
  );
  const writes: SqlStatement[] = [];
  let added = 0;
  let changed = 0;
  for (const e of read.events) {
    const before = kept.get(e.uid);
    kept.delete(e.uid);
    if (before !== undefined && sameEvent(before, e)) continue;
    if (before === undefined) added++;
    else changed++;
    writes.push(upsert(calendarId, e));
  }
  for (const uid of kept.keys()) {
    writes.push(
      stmt("DELETE FROM followed_event WHERE calendar_id = ? AND uid = ?", calendarId, uid),
    );
  }
  const removed = kept.size;

  const own =
    read.name !== cal.name ||
    fetched.etag !== cal.etag ||
    fetched.lastModified !== cal.last_modified ||
    read.leftOut !== cal.left_out ||
    cal.status !== "ok" ||
    cal.fetched_at === null;
  if (own || writes.length > 0) {
    writes.push(
      stmt(
        `UPDATE followed_calendar
         SET name = ?, etag = ?, last_modified = ?, left_out = ?, status = 'ok', fetched_at = ?
         WHERE id = ?`,
        read.name,
        fetched.etag,
        fetched.lastModified,
        read.leftOut,
        now,
        calendarId,
      ),
    );
    await storage.batch(writes);
  }
  return { outcome: "fetched", added, changed, removed };
}

/** One minute's fetching (rc56): each followed calendar whose turn it is, one at a time. */
export async function followingPass(
  storage: StoragePort,
  get: PublicGet,
  at: string,
): Promise<{ readonly calendarId: string; readonly refreshed: Refreshed }[]> {
  const done: { calendarId: string; refreshed: Refreshed }[] = [];
  for (const calendarId of await calendarsDue(storage, at)) {
    done.push({ calendarId, refreshed: await refreshCalendar(storage, get, calendarId, at) });
  }
  return done;
}

/**
 * A refresh's log line (§14): the calendar's id, the outcome and counts — never the link, its
 * query, or anything it holds. Null when nothing changed, so a steady state logs nothing.
 */
export function followLog(
  calendarId: string,
  r: Refreshed,
): Record<string, string | number> | null {
  if (
    r.outcome === "unchanged" ||
    (r.outcome === "fetched" && r.added + r.changed + r.removed === 0)
  )
    return null;
  return { reason: "followed_fetch", calendar: calendarId, ...r };
}
