// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createTokenCipher } from "../../src/crypto/tokens.js";
import { createEvent } from "../../src/events/event.js";
import { issueFeedLink } from "../../src/feeds/feed.js";
import { createGroup } from "../../src/people/group.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { feedPath } from "../../src/web/routes/feeds.js";
import { browser } from "../property/one-browser.js";

// GET /feed/<token>.ics (DESIGN §10 rc34): the link is the key, so it works with no
// cookie at all, never sets one and writes nothing; an unchanged feed answers 304.

const NOW = "2101-10-01T10:00:00.000Z";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes: a test key

async function withFeed() {
  const b = await browser({ now: () => NOW });
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  await createEvent(b.storage, {
    creatorId: ann.id,
    group: null,
    fields: {
      title: "Dinner",
      description: null,
      location: null,
      allDay: false,
      startLocal: "2101-11-21T18:00",
      endLocal: "2101-11-21T20:00",
      tzid: "Europe/Prague",
    },
    now: NOW,
  });
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const token = await issueFeedLink(b.storage, cipher, {
    personId: ann.id,
    groupId: null,
    now: NOW,
  });
  if (token === null) throw new Error("issued");
  return { b, path: feedPath(token) };
}

it("serves the feed with no cookie, sets none, writes nothing, and keeps the link out of Referer", async () => {
  const { b, path } = await withFeed();
  const before = b.writes;
  const res = await b.request(path);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cache-control")).toBe("private, max-age=900");
  const body = await res.text();
  expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(body).toContain("SUMMARY:Dinner");
  expect(body).toContain("X-WR-CALNAME:WhenDoWe\r\n");
  expect(body).toMatch(/URL:https?:\/\/[^\r]+\/events\/[0-9a-f-]+\r\n/);
  expect(b.writes).toBe(before);
});

it("an unchanged feed answers 304 to its ETag; a changed one doesn't", async () => {
  const { b, path } = await withFeed();
  const first = await b.request(path);
  const etag = first.headers.get("etag") ?? "";
  expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  const again = await b.request(path, { headers: { "If-None-Match": etag } });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  await b.storage.batch([
    { sql: "UPDATE canonical_event SET title = 'Lunch', revision = revision + 1", params: [] },
  ]);
  const changed = await b.request(path, { headers: { "If-None-Match": etag } });
  expect(changed.status).toBe(200);
  expect(await changed.text()).toContain("SUMMARY:Lunch");
});

it("an unknown or malformed link is 404 and cached by nobody (replaced: feeds.suite)", async () => {
  const { b, path } = await withFeed();
  for (const bad of ["/feed/nope.ics", `${path}x`, path.replace(".ics", ""), "/feed/"]) {
    const res = await b.request(bad);
    expect(res.status, bad).toBe(404);
  }
  const unknown = await b.request(`/feed/${"A".repeat(43)}.ics`);
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get("cache-control")).toBe("no-store");
  expect(await unknown.text()).toBe("This feed link no longer works.");
});

it("a group's feed is named for the group", async () => {
  const b = await browser({ now: () => NOW });
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  const group = await createGroup(b.storage, { name: "Rope jam", creatorId: ann.id, now: NOW });
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const token = await issueFeedLink(b.storage, cipher, {
    personId: ann.id,
    groupId: group.id,
    now: NOW,
  });
  const body = await (await b.request(feedPath(token ?? ""))).text();
  expect(body).toContain("X-WR-CALNAME:WhenDoWe · Rope jam");
});
