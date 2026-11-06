// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { TokenCipher } from "../crypto/tokens.js";
import type { StoragePort } from "../db/port.js";
import type { RandomBytes } from "../ids.js";
import { visibilitySchema } from "../people/group.js";
import { hashToken, issueToken } from "../people/tokens.js";
import type { FeedEntry } from "./ics.js";

// Feed links and what a feed holds (DESIGN §10 rc34 *Calendar feeds*). A feed is a
// secret link, one per person per feed: their own, or a group's. Like every token here,
// it is looked up by its SHA-256; it is also kept encrypted, only so its owner can be
// shown it again. It never expires; making a new one replaces it, and the old link is
// dead from then on. Who is in a feed is worked out each time it is read, so removing
// someone from an event takes it out of their feeds with no write to any feed.

/** A cancelled event stays this long, as CANCELLED, so calendars that have it drop it. */
export const FEED_CANCELLED_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which feed: a person's own (`groupId` null) or their feed of one group. */
export interface FeedScope {
  readonly personId: string;
  readonly groupId: string | null;
}

/** A resolved link: whose feed, and the group's name for a group's feed. */
export interface ResolvedFeed extends FeedScope {
  readonly groupName: string | null;
}

/**
 * Make this person's link to a feed, replacing any they had (the old one stops
 * working at once). A group's feed only for a member of it: null otherwise.
 */
export async function issueFeedLink(
  storage: StoragePort,
  cipher: TokenCipher,
  input: FeedScope & { readonly now: string; readonly randomBytes?: RandomBytes },
): Promise<string | null> {
  const { token, hash } = await issueToken(input.randomBytes);
  const enc = await cipher.encrypt(token);
  await storage.batch([
    {
      sql: `DELETE FROM feed_token WHERE person_id = ? AND group_id IS ?`,
      params: [input.personId, input.groupId],
    },
    {
      // The membership is checked in the same statement that writes, so a link can't be
      // made for a group someone has just left.
      sql: `INSERT INTO feed_token (token_hash, token_enc, person_id, group_id, created_at)
            SELECT ?, ?, ?, ?, ?
            WHERE ? IS NULL
               OR EXISTS (SELECT 1 FROM group_member WHERE group_id = ? AND person_id = ?)`,
      params: [
        hash,
        enc,
        input.personId,
        input.groupId,
        input.now,
        input.groupId,
        input.groupId,
        input.personId,
      ],
    },
  ]);
  const written = await storage.query({
    sql: "SELECT 1 AS present FROM feed_token WHERE token_hash = ?",
    params: [hash],
  });
  return written.length === 1 ? token : null;
}

/** This person's link to a feed, to show them again; null if they have none. */
export async function shownFeedLink(
  storage: StoragePort,
  cipher: TokenCipher,
  scope: FeedScope,
): Promise<string | null> {
  const rows = await storage.query({
    sql: "SELECT token_enc FROM feed_token WHERE person_id = ? AND group_id IS ?",
    params: [scope.personId, scope.groupId],
  });
  const row = z.object({ token_enc: z.string() }).safeParse(rows[0]);
  return row.success ? cipher.decrypt(row.data.token_enc) : null;
}

/** The feed a link opens, or null: unknown, replaced, or a group its person has left. */
export async function resolveFeed(
  storage: StoragePort,
  token: string,
): Promise<ResolvedFeed | null> {
  const rows = await storage.query({
    sql: `SELECT f.person_id, f.group_id, g.name AS group_name
          FROM feed_token f LEFT JOIN person_group g ON g.id = f.group_id
          WHERE f.token_hash = ?
            AND (f.group_id IS NULL OR EXISTS
                 (SELECT 1 FROM group_member m WHERE m.group_id = f.group_id AND m.person_id = f.person_id))`,
    params: [await hashToken(token)],
  });
  const row = z
    .object({
      person_id: z.string(),
      group_id: z.string().nullable(),
      group_name: z.string().nullable(),
    })
    .safeParse(rows[0]);
  if (!row.success) return null;
  return {
    personId: row.data.person_id,
    groupId: row.data.group_id,
    groupName: row.data.group_name,
  };
}

const entryRowSchema = z.object({
  id: z.string(),
  revision: z.number(),
  updated_at: z.string(),
  status: z.enum(["scheduled", "cancelled"]),
  visibility: visibilitySchema.exclude(["HIDDEN"]),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  all_day: z.number(),
  start_local: z.string(),
  end_local: z.string(),
  tzid: z.string().nullable(),
  rrule: z.string().nullable(),
});

/**
 * What a feed holds (§10 rc34): agreed events this person takes part in and may see,
 * at their own tier, and those cancelled in the last FEED_CANCELLED_DAYS. A group's
 * feed is the same, only for events made from that group. Open questions never are.
 */
export async function feedEntries(
  storage: StoragePort,
  scope: FeedScope,
  input: { readonly now: string; readonly eventUrl: (id: string) => string },
): Promise<FeedEntry[]> {
  const since = new Date(Date.parse(input.now) - FEED_CANCELLED_DAYS * DAY_MS).toISOString();
  const rows = await storage.query({
    sql: `SELECT e.id, e.revision, e.updated_at, e.status, ep.visibility, e.title, e.description,
                 e.location, e.all_day, e.start_local, e.end_local, e.tzid, e.rrule
          FROM canonical_event e
            JOIN event_participation ep ON ep.canonical_event_id = e.id AND ep.person_id = ?
          WHERE ep.visibility <> 'HIDDEN'
            AND (e.status = 'scheduled' OR (e.status = 'cancelled' AND e.updated_at >= ?))
            AND (? IS NULL OR e.group_id = ?)
          ORDER BY e.start_local, e.id`,
    params: [scope.personId, since, scope.groupId, scope.groupId],
  });
  return rows.map((raw) => {
    const r = entryRowSchema.parse(raw);
    return {
      id: r.id,
      revision: r.revision,
      updatedAt: r.updated_at,
      status: r.status,
      visibility: r.visibility,
      title: r.title,
      description: r.description,
      location: r.location,
      allDay: r.all_day === 1,
      startLocal: r.start_local,
      endLocal: r.end_local,
      tzid: r.tzid,
      rrule: r.rrule,
      url: r.visibility === "BUSY" ? null : input.eventUrl(r.id),
    };
  });
}

/** Which feeds a person has, for their export (§10 rc34): never the tokens. */
export async function listFeeds(
  storage: StoragePort,
  personId: string,
): Promise<{ readonly group: string | null; readonly createdAt: string }[]> {
  const rows = await storage.query({
    sql: `SELECT g.name AS group_name, f.created_at FROM feed_token f
            LEFT JOIN person_group g ON g.id = f.group_id
          WHERE f.person_id = ? ORDER BY f.created_at`,
    params: [personId],
  });
  return rows.map((raw) => {
    const r = z.object({ group_name: z.string().nullable(), created_at: z.string() }).parse(raw);
    return { group: r.group_name, createdAt: r.created_at };
  });
}
