// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Hono } from "hono";
import type { StoragePort } from "../../db/port.js";
import { feedEntries, resolveFeed } from "../../feeds/feed.js";
import { serializeFeed } from "../../feeds/ics.js";
import { hashToken } from "../../people/tokens.js";
import type { AppEnv } from "../session.js";
import { EVENTS_PATH } from "./events.js";

// A calendar feed by its secret link (DESIGN §10 rc34): GET /feed/<token>.ics. A
// calendar app can't sign in, so the link is the key. It renders the feed from the
// database every time, with an ETag over the body: an unchanged feed answers 304.
// It never creates a session, never signs anyone in, and writes nothing — not even
// when it was last fetched. The token is in the path, which nothing here logs.

export const FEED_PATH = "/feed";

export interface FeedRouteDeps {
  readonly storage: StoragePort;
  /** Absolute origin, e.g. https://whendowe.org: the UIDs' host and the events' links. */
  readonly publicBaseUrl: string;
  readonly now: () => string;
}

/** The path of a feed link, for the pages that show it (F3). */
export function feedPath(token: string): string {
  return `${FEED_PATH}/${token}.ics`;
}

const FILE = /^([A-Za-z0-9_-]{43})\.ics$/;

export function registerFeedRoutes(app: Hono<AppEnv>, deps: FeedRouteDeps): void {
  app.get(`${FEED_PATH}/:file`, async (c) => {
    c.header("Referrer-Policy", "no-referrer");
    const token = FILE.exec(c.req.param("file"))?.[1];
    const feed = token === undefined ? null : await resolveFeed(deps.storage, token);
    if (feed === null) {
      c.header("Cache-Control", "no-store");
      return c.text("This feed link no longer works.", 404);
    }
    const base = new URL(deps.publicBaseUrl);
    const now = deps.now();
    const body = serializeFeed({
      name: feed.groupName === null ? "WhenDoWe" : `WhenDoWe · ${feed.groupName}`,
      host: base.host,
      entries: await feedEntries(deps.storage, feed, {
        now,
        eventUrl: (id) => new URL(`${EVENTS_PATH}/${id}`, base).toString(),
      }),
      now,
    });
    const etag = `"${await hashToken(body)}"`;
    c.header("ETag", etag);
    // Private: each link is one person's view at their tier, never a shared cache's.
    c.header("Cache-Control", "private, max-age=900");
    if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
    c.header("Content-Type", "text/calendar; charset=utf-8");
    return c.body(body, 200);
  });
}
