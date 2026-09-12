// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import type { FetchLike, HttpRequestInit } from "../../src/oauth/http.js";
import { SyncTokenExpiredError } from "../../src/providers/base.js";
import { GoogleCalendarProvider } from "../../src/providers/google.js";

const ACCESS_TOKEN = "ya29.access-token-value";
const CALENDAR_ID = "someone@example.com";

interface Recorded {
  url: string;
  init: HttpRequestInit;
}

interface Reply {
  readonly status?: number;
  readonly body: string;
}

/** Replies in sequence, so pagination can be driven page by page. */
function fakeFetch(replies: readonly Reply[]): { impl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    const status = reply?.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(reply?.body ?? ""),
    });
  };
  return { impl, calls };
}

function provider(impl: FetchLike): GoogleCalendarProvider {
  return new GoogleCalendarProvider({
    calendarId: CALENDAR_ID,
    getAccessToken: () => Promise.resolve(ACCESS_TOKEN),
    fetchImpl: impl,
  });
}

function eventBody(id: string): Record<string, unknown> {
  return {
    id,
    etag: `"etag-${id}"`,
    status: "confirmed",
    summary: `Event ${id}`,
    start: { dateTime: "2026-09-13T09:00:00+02:00", timeZone: "Europe/Prague" },
    end: { dateTime: "2026-09-13T10:00:00+02:00", timeZone: "Europe/Prague" },
  };
}

// --- request shape ---

it("lists with the parameters a sync cursor requires", async () => {
  const { impl, calls } = fakeFetch([
    { body: JSON.stringify({ items: [], nextSyncToken: "tok-1" }) },
  ]);
  await provider(impl).listChanges(null);

  const url = new URL(calls[0]?.url ?? "");
  expect(url.pathname).toContain(encodeURIComponent(CALENDAR_ID));
  // Deletions must be visible, or an inbound removal is invisible to the sync.
  expect(url.searchParams.get("showDeleted")).toBe("true");
  // Whole series, never expanded instances (§16).
  expect(url.searchParams.get("singleEvents")).toBe("false");
  // No time window: those filters cannot be combined with a syncToken, and
  // changing filters between syncs invalidates the cursor.
  expect(url.searchParams.has("timeMin")).toBe(false);
  expect(url.searchParams.has("timeMax")).toBe(false);
  expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
});

it("omits syncToken on a full sync and sends it on an incremental one", async () => {
  const body = JSON.stringify({ items: [], nextSyncToken: "tok-2" });

  const full = fakeFetch([{ body }]);
  await provider(full.impl).listChanges(null);
  expect(new URL(full.calls[0]?.url ?? "").searchParams.has("syncToken")).toBe(false);

  const incremental = fakeFetch([{ body }]);
  await provider(incremental.impl).listChanges("tok-1");
  expect(new URL(incremental.calls[0]?.url ?? "").searchParams.get("syncToken")).toBe("tok-1");
});

it("keeps the access token out of the URL", async () => {
  const { impl, calls } = fakeFetch([
    { body: JSON.stringify({ items: [], nextSyncToken: "tok-1" }) },
  ]);
  await provider(impl).listChanges(null);
  expect(calls[0]?.url).not.toContain(ACCESS_TOKEN);
});

it("resolves the access token per call, not at construction", async () => {
  // The refresh path in M2 hangs off this: a long-lived provider must be able to
  // pick up a newer token without being rebuilt.
  const { impl } = fakeFetch([{ body: JSON.stringify({ items: [], nextSyncToken: "t" }) }]);
  let issued = 0;
  const p = new GoogleCalendarProvider({
    calendarId: CALENDAR_ID,
    getAccessToken: () => Promise.resolve(`token-${++issued}`),
    fetchImpl: impl,
  });
  await p.listChanges(null);
  await p.listChanges(null);
  expect(issued).toBe(2);
});

// --- results ---

it("maps returned events through the provider mapping", async () => {
  const { impl } = fakeFetch([
    { body: JSON.stringify({ items: [eventBody("a")], nextSyncToken: "tok-3" }) },
  ]);
  const batch = await provider(impl).listChanges(null);
  expect(batch.nextSyncToken).toBe("tok-3");
  expect(batch.changes).toHaveLength(1);
  expect(batch.changes[0]?.id).toBe("a");
  expect(batch.changes[0]?.fields.startLocal).toBe("2026-09-13T09:00:00");
});

it("tolerates a page with no items array", async () => {
  const { impl } = fakeFetch([{ body: JSON.stringify({ nextSyncToken: "tok-4" }) }]);
  expect((await provider(impl).listChanges(null)).changes).toEqual([]);
});

// --- pagination ---

it("follows page tokens and returns the final sync token", async () => {
  const { impl, calls } = fakeFetch([
    { body: JSON.stringify({ items: [eventBody("a")], nextPageToken: "page-2" }) },
    { body: JSON.stringify({ items: [eventBody("b")], nextPageToken: "page-3" }) },
    { body: JSON.stringify({ items: [eventBody("c")], nextSyncToken: "tok-final" }) },
  ]);

  const batch = await provider(impl).listChanges(null);

  expect(calls).toHaveLength(3);
  expect(new URL(calls[0]?.url ?? "").searchParams.has("pageToken")).toBe(false);
  expect(new URL(calls[1]?.url ?? "").searchParams.get("pageToken")).toBe("page-2");
  expect(new URL(calls[2]?.url ?? "").searchParams.get("pageToken")).toBe("page-3");
  expect(batch.changes.map((c) => c.id)).toEqual(["a", "b", "c"]);
  // Only the last page carries it.
  expect(batch.nextSyncToken).toBe("tok-final");
});

it("honours a configured page size", async () => {
  const { impl, calls } = fakeFetch([
    { body: JSON.stringify({ items: [], nextSyncToken: "tok-5" }) },
  ]);
  const p = new GoogleCalendarProvider({
    calendarId: CALENDAR_ID,
    getAccessToken: () => Promise.resolve(ACCESS_TOKEN),
    fetchImpl: impl,
    pageSize: 10,
  });
  await p.listChanges(null);
  expect(new URL(calls[0]?.url ?? "").searchParams.get("maxResults")).toBe("10");
});

it("stops and says so if pagination never ends", async () => {
  // An upstream that always returns a page token would otherwise loop until the
  // request budget ran out. The message must name the real cause: a missing sync
  // token is a different fault with a different fix.
  const { impl, calls } = fakeFetch([
    { body: JSON.stringify({ items: [], nextPageToken: "always-another" }) },
  ]);
  await expect(provider(impl).listChanges(null)).rejects.toThrow(/exceeded 200 pages/);
  expect(calls).toHaveLength(200);
});

it("fails loudly if the listing ends without a sync token", async () => {
  // Silently continuing would make the next tick re-list everything, turning the
  // steady-state zero-write path (§6/§16) into a full scan every minute.
  const { impl } = fakeFetch([{ body: JSON.stringify({ items: [] }) }]);
  await expect(provider(impl).listChanges(null)).rejects.toThrow(/without a nextSyncToken/);
});

// --- the 410 protocol case ---

it("converts 410 GONE into SyncTokenExpiredError", async () => {
  // Expired cursor is protocol, not failure: the caller runs §12's full resync.
  const { impl } = fakeFetch([
    { status: 410, body: JSON.stringify({ error: { message: "Sync token is no longer valid" } }) },
  ]);
  await expect(provider(impl).listChanges("stale-token")).rejects.toBeInstanceOf(
    SyncTokenExpiredError,
  );
});

it("does not swallow other HTTP failures", async () => {
  const { impl } = fakeFetch([
    { status: 403, body: JSON.stringify({ error: { message: "Rate Limit Exceeded" } }) },
  ]);
  const failure = provider(impl).listChanges(null);
  await expect(failure).rejects.toThrow(/HTTP 403.*Rate Limit Exceeded/);
  await expect(failure).rejects.not.toBeInstanceOf(SyncTokenExpiredError);
});

it("never puts the access token into an error message", async () => {
  const { impl } = fakeFetch([{ status: 401, body: JSON.stringify({ error: "unauthorized" }) }]);
  let message = "";
  try {
    await provider(impl).listChanges(null);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toBe("");
  expect(message).not.toContain(ACCESS_TOKEN);
});

// --- the write side is still M2 ---

it("rejects write operations until M2", async () => {
  const { impl } = fakeFetch([{ body: "{}" }]);
  const p = provider(impl);
  await expect(p.upsert(null, { ...eventFields() }, { canonicalUid: "u" })).rejects.toThrow(/M2/);
  await expect(p.delete("id")).rejects.toThrow(/M2/);
  await expect(p.findByMetadata("uid")).rejects.toThrow(/M2/);
});

function eventFields() {
  return {
    title: "t",
    description: null,
    location: null,
    startLocal: "2026-09-13T09:00:00",
    endLocal: "2026-09-13T10:00:00",
    tzid: "Europe/Prague",
    allDay: false,
    rrule: null,
  };
}
