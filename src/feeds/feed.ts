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
      sql: `DELETE FROM feed_token WHERE kind = 'feed' AND person_id = ? AND group_id IS ?`,
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
    sql: "SELECT token_enc FROM feed_token WHERE kind = 'feed' AND person_id = ? AND group_id IS ?",
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
          WHERE f.token_hash = ? AND f.kind = 'feed'
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
          WHERE f.kind = 'feed' AND f.person_id = ? ORDER BY f.created_at`,
    params: [personId],
  });
  return rows.map((raw) => {
    const r = z.object({ group_name: z.string().nullable(), created_at: z.string() }).parse(raw);
    return { group: r.group_name, createdAt: r.created_at };
  });
}

// --- Group calendar links (DESIGN §10 rc36) ---------------------------------------------
//
// A group's schedule for people outside it: grandparents, a babysitter, a band's website.
// Each link is labelled, has a tier (details or busy only), and is kept by an organizer
// (person_id): it never shows more than its keeper sees. When the keeper stops being an
// organizer — they leave or are erased — the link moves to the organizer who remains or
// takes over. As many as wanted; only organizers make, replace and stop them.

export const sharedTierSchema = z.enum(["DETAILS", "BUSY"]);
export type SharedTier = z.infer<typeof sharedTierSchema>;

/** Who a link is for, as its organizers name it: "Grandparents". */
export const sharedLabelSchema = z
  .string()
  .trim()
  .min(1, "Say who the link is for.")
  .max(40, "Keep it under 40 characters.");

export interface SharedLink {
  /** The row's key, for the forms that replace or stop it; never the link itself. */
  readonly hash: string;
  readonly label: string;
  readonly tier: SharedTier;
  readonly createdAt: string;
  readonly keeperId: string;
  /** Who made it; null once they are erased (a former member). */
  readonly madeBy: string | null;
}

/** A resolved group calendar link: the group, its keeper, and what it shows. */
export interface ResolvedSharedLink {
  readonly groupId: string;
  readonly groupName: string;
  readonly keeperId: string;
  readonly tier: SharedTier;
}

const IS_ORGANIZER = `EXISTS (SELECT 1 FROM group_member
  WHERE group_id = ? AND person_id = ? AND role = 'organizer')`;

/** Make a link to a group's calendar; null unless the maker is one of its organizers. */
export async function makeSharedLink(
  storage: StoragePort,
  cipher: TokenCipher,
  input: {
    readonly groupId: string;
    readonly organizerId: string;
    readonly label: string;
    readonly tier: SharedTier;
    readonly now: string;
    readonly randomBytes?: RandomBytes;
  },
): Promise<string | null> {
  const label = sharedLabelSchema.parse(input.label);
  const tier = sharedTierSchema.parse(input.tier);
  const { token, hash } = await issueToken(input.randomBytes);
  const enc = await cipher.encrypt(token);
  await storage.batch([
    {
      sql: `INSERT INTO feed_token
              (token_hash, token_enc, person_id, group_id, created_at, kind, label, tier, made_by)
            SELECT ?, ?, ?, ?, ?, 'shared', ?, ?, ?
            WHERE ${IS_ORGANIZER}`,
      params: [
        hash,
        enc,
        input.organizerId,
        input.groupId,
        input.now,
        label,
        tier,
        input.organizerId,
        input.groupId,
        input.organizerId,
      ],
    },
  ]);
  return (await written(storage, hash)) ? token : null;
}

async function written(storage: StoragePort, hash: string): Promise<boolean> {
  const rows = await storage.query({
    sql: "SELECT 1 AS present FROM feed_token WHERE token_hash = ?",
    params: [hash],
  });
  return rows.length === 1;
}

/**
 * A new link in place of one that got out: same label, tier, keeper and maker. The old
 * link answers 404 from then on. Null unless an organizer asks for a link of this group.
 */
export async function replaceSharedLink(
  storage: StoragePort,
  cipher: TokenCipher,
  input: {
    readonly groupId: string;
    readonly organizerId: string;
    readonly hash: string;
    readonly now: string;
    readonly randomBytes?: RandomBytes;
  },
): Promise<string | null> {
  const { token, hash } = await issueToken(input.randomBytes);
  const enc = await cipher.encrypt(token);
  await storage.batch([
    {
      sql: `INSERT INTO feed_token
              (token_hash, token_enc, person_id, group_id, created_at, kind, label, tier, made_by)
            SELECT ?, ?, person_id, group_id, ?, 'shared', label, tier, made_by
            FROM feed_token
            WHERE token_hash = ? AND group_id = ? AND kind = 'shared' AND ${IS_ORGANIZER}`,
      params: [hash, enc, input.now, input.hash, input.groupId, input.groupId, input.organizerId],
    },
    {
      sql: `DELETE FROM feed_token WHERE token_hash = ? AND group_id = ? AND kind = 'shared'
              AND changes() = 1`,
      params: [input.hash, input.groupId],
    },
  ]);
  return (await written(storage, hash)) ? token : null;
}

/** Stop sharing: the link is gone. False unless an organizer stops a link of this group. */
export async function stopSharedLink(
  storage: StoragePort,
  input: { readonly groupId: string; readonly organizerId: string; readonly hash: string },
): Promise<boolean> {
  const gone = await storage.query({
    sql: `DELETE FROM feed_token WHERE token_hash = ? AND group_id = ? AND kind = 'shared'
            AND ${IS_ORGANIZER}
          RETURNING token_hash`,
    params: [input.hash, input.groupId, input.groupId, input.organizerId],
  });
  return gone.length === 1;
}

const sharedRowSchema = z.object({
  token_hash: z.string(),
  token_enc: z.string(),
  label: z.string(),
  tier: sharedTierSchema,
  created_at: z.string(),
  person_id: z.string(),
  made_by: z.string().nullable(),
});

/** A group's links, oldest first: every member may see that they exist (rc36). */
export async function listSharedLinks(
  storage: StoragePort,
  groupId: string,
): Promise<SharedLink[]> {
  return (await sharedRows(storage, groupId)).map((r) => ({
    hash: r.token_hash,
    label: r.label,
    tier: r.tier,
    createdAt: r.created_at,
    keeperId: r.person_id,
    madeBy: r.made_by,
  }));
}

async function sharedRows(storage: StoragePort, groupId: string) {
  const rows = await storage.query({
    sql: `SELECT token_hash, token_enc, label, tier, created_at, person_id, made_by
          FROM feed_token WHERE group_id = ? AND kind = 'shared'
          -- Links made in one moment tie on created_at; rowid is the order they were made.
          ORDER BY created_at, rowid`,
    params: [groupId],
  });
  return rows.map((raw) => sharedRowSchema.parse(raw));
}

/** The links themselves, by row, for the group's organizers to see again (the route checks). */
export async function shownSharedLinks(
  storage: StoragePort,
  cipher: TokenCipher,
  groupId: string,
): Promise<ReadonlyMap<string, string>> {
  const shown = new Map<string, string>();
  for (const r of await sharedRows(storage, groupId))
    shown.set(r.token_hash, await cipher.decrypt(r.token_enc));
  return shown;
}

/** The group calendar a link opens, or null: unknown, stopped, or its keeper no organizer. */
export async function resolveSharedLink(
  storage: StoragePort,
  token: string,
): Promise<ResolvedSharedLink | null> {
  const rows = await storage.query({
    sql: `SELECT f.group_id, g.name AS group_name, f.person_id, f.tier
          FROM feed_token f JOIN person_group g ON g.id = f.group_id
          WHERE f.token_hash = ? AND f.kind = 'shared'
            AND EXISTS (SELECT 1 FROM group_member m WHERE m.group_id = f.group_id
                          AND m.person_id = f.person_id AND m.role = 'organizer')`,
    params: [await hashToken(token)],
  });
  const row = z
    .object({
      group_id: z.string(),
      group_name: z.string(),
      person_id: z.string(),
      tier: sharedTierSchema,
    })
    .safeParse(rows[0]);
  if (!row.success) return null;
  return {
    groupId: row.data.group_id,
    groupName: row.data.group_name,
    keeperId: row.data.person_id,
    tier: row.data.tier,
  };
}

/**
 * What a group calendar link shows (rc36): the group's agreed events its keeper takes
 * part in and may see, each at the lower of the link's tier and the keeper's — never
 * notes, never a link to a page only members can open. You can't publish what you can't see.
 */
export async function sharedEntries(
  storage: StoragePort,
  link: ResolvedSharedLink,
  now: string,
): Promise<FeedEntry[]> {
  const entries = await feedEntries(
    storage,
    { personId: link.keeperId, groupId: link.groupId },
    { now, eventUrl: () => "" },
  );
  return entries.map((e) => ({
    ...e,
    visibility: link.tier === "BUSY" || e.visibility === "BUSY" ? "BUSY" : "DETAILS",
    url: null,
  }));
}

/** The group calendar links a person keeps, for their export (rc36): never the links. */
export async function listKeptLinks(
  storage: StoragePort,
  personId: string,
): Promise<{ readonly group: string; readonly label: string; readonly tier: SharedTier }[]> {
  const rows = await storage.query({
    sql: `SELECT g.name AS group_name, f.label, f.tier FROM feed_token f
            JOIN person_group g ON g.id = f.group_id
          WHERE f.kind = 'shared' AND f.person_id = ? ORDER BY f.created_at, f.rowid`,
    params: [personId],
  });
  return rows.map((raw) => {
    const r = z
      .object({ group_name: z.string(), label: z.string(), tier: sharedTierSchema })
      .parse(raw);
    return { group: r.group_name, label: r.label, tier: r.tier };
  });
}
