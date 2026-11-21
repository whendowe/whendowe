// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { type FetchLike, HttpError, type HttpRequestInit } from "../../src/oauth/http.js";
import { ProviderEventGoneError, SyncTokenExpiredError } from "../../src/providers/base.js";
import { GoogleCalendarProvider } from "../../src/providers/google.js";
import { googleEventSchema, toProviderEvent } from "../../src/providers/google-event.js";

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

// --- the write side (§11 PUSH, MVP-4 G2) ---

const EVENTS_URL = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;
const LINK = "https://when.example/events/evt-1";

function sentBody(call: Recorded | undefined): unknown {
  return JSON.parse(call?.init.body ?? "null");
}

it("creates a copy with a POST carrying its fields, its link and its canonical id", async () => {
  const { impl, calls } = fakeFetch([{ body: JSON.stringify(eventBody("g1")) }]);
  const result = await provider(impl).upsert(
    null,
    { ...eventFields(), description: "Bring cake", location: "Park", sourceUrl: LINK },
    { canonicalUid: "evt-1", writeNonce: "n1" },
  );

  expect(result).toEqual({ id: "g1", etag: '"etag-g1"' });
  expect(calls[0]?.url).toBe(EVENTS_URL);
  expect(calls[0]?.init.method).toBe("POST");
  expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
  expect(sentBody(calls[0])).toEqual({
    summary: "t",
    description: "Bring cake",
    location: "Park",
    start: { date: null, dateTime: "2026-09-13T09:00:00", timeZone: "Europe/Prague" },
    end: { date: null, dateTime: "2026-09-13T10:00:00", timeZone: "Europe/Prague" },
    recurrence: null,
    source: { title: "WhenDoWe", url: LINK },
    extendedProperties: { private: { canonical_uid: "evt-1", write_nonce: "n1" } },
  });
});

it("updates with a PATCH that names every field, so what the event lost is cleared", async () => {
  const { impl, calls } = fakeFetch([{ body: JSON.stringify(eventBody("a/b")) }]);
  await provider(impl).upsert("a/b", eventFields(), { canonicalUid: "evt-1" });

  expect(calls[0]?.url).toBe(`${EVENTS_URL}/${encodeURIComponent("a/b")}`);
  // PATCH, not PUT: a PUT would set status back to confirmed and revive a deleted copy.
  expect(calls[0]?.init.method).toBe("PATCH");
  expect(sentBody(calls[0])).toMatchObject({
    description: null,
    location: null,
    source: null,
    recurrence: null,
    extendedProperties: { private: { canonical_uid: "evt-1" } },
  });
  expect(sentBody(calls[0])).not.toHaveProperty("status");
});

it("sends all-day events as dates and a series as its RRULE line", async () => {
  const { impl, calls } = fakeFetch([{ body: JSON.stringify(eventBody("g1")) }]);
  await provider(impl).upsert(
    null,
    {
      ...eventFields(),
      allDay: true,
      startLocal: "2026-09-13",
      endLocal: "2026-09-14",
      tzid: null,
      rrule: "FREQ=WEEKLY;BYDAY=SU",
    },
    { canonicalUid: "evt-1" },
  );
  expect(sentBody(calls[0])).toMatchObject({
    start: { date: "2026-09-13", dateTime: null, timeZone: null },
    end: { date: "2026-09-14", dateTime: null, timeZone: null },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=SU"],
  });
});

it("gives a timed event with no zone UTC, which Google needs", async () => {
  const { impl, calls } = fakeFetch([{ body: JSON.stringify(eventBody("g1")) }]);
  await provider(impl).upsert(null, { ...eventFields(), tzid: null }, { canonicalUid: "u" });
  expect(sentBody(calls[0])).toMatchObject({
    start: { timeZone: "UTC" },
    end: { timeZone: "UTC" },
  });
});

it.each([404, 410])("says an updated copy is gone when Google answers %i", async (status) => {
  const { impl } = fakeFetch([{ status, body: JSON.stringify({ error: { message: "x" } }) }]);
  const update = provider(impl).upsert("g1", eventFields(), { canonicalUid: "u" });
  await expect(update).rejects.toThrow(ProviderEventGoneError);
  // Its own name and message, so a log line tells it from a failure (§14).
  await expect(update).rejects.toMatchObject({
    name: "ProviderEventGoneError",
    message: "the provider event was deleted there",
  });
});

it("says an updated copy is gone when Google answers that it is cancelled, not revived", async () => {
  const { impl } = fakeFetch([
    { body: JSON.stringify({ ...eventBody("g1"), status: "cancelled" }) },
  ]);
  await expect(provider(impl).upsert("g1", eventFields(), { canonicalUid: "u" })).rejects.toThrow(
    ProviderEventGoneError,
  );
});

it("treats a 404 on a create, and any other failure, as a failure to retry", async () => {
  const notFound = fakeFetch([{ status: 404, body: "{}" }]);
  const create = provider(notFound.impl).upsert(null, eventFields(), { canonicalUid: "u" });
  await expect(create).rejects.not.toThrow(ProviderEventGoneError);
  await expect(create).rejects.toThrow(/calendar event insert failed: HTTP 404/);

  const broken = fakeFetch([{ status: 500, body: JSON.stringify({ error: { message: "boom" } }) }]);
  const update = provider(broken.impl).upsert("g1", eventFields(), { canonicalUid: "u" });
  await expect(update).rejects.toThrow(/calendar event update failed: HTTP 500/);
  await expect(update).rejects.not.toThrow(ACCESS_TOKEN);
});

it("deletes with a DELETE, and a copy already gone counts as deleted", async () => {
  for (const status of [204, 200, 404, 410]) {
    const { impl, calls } = fakeFetch([{ status, body: "" }]);
    await provider(impl).delete("g/1");
    expect(calls[0]?.url).toBe(`${EVENTS_URL}/${encodeURIComponent("g/1")}`);
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  }
  const { impl } = fakeFetch([{ status: 500, body: "" }]);
  await expect(provider(impl).delete("g1")).rejects.toThrow(
    "calendar event delete failed: HTTP 500 (not deleted)",
  );
});

it("finds a copy by its canonical id, and only by that", async () => {
  const found = {
    ...eventBody("g7"),
    extendedProperties: { private: { canonical_uid: "evt-1" } },
  };
  const { impl, calls } = fakeFetch([{ body: JSON.stringify({ items: [found] }) }]);
  const event = await provider(impl).findByMetadata("evt-1");

  expect(event?.id).toBe("g7");
  expect(event?.metadata.canonicalUid).toBe("evt-1");
  const url = new URL(calls[0]?.url ?? "");
  expect(`${url.origin}${url.pathname}`).toBe(EVENTS_URL);
  expect(url.searchParams.get("privateExtendedProperty")).toBe("canonical_uid=evt-1");
  expect(url.searchParams.get("singleEvents")).toBe("false");
  expect(url.searchParams.get("maxResults")).toBe("1");
  expect(calls[0]?.init.headers.accept).toBe("application/json");
  // Deleted copies stay out (Google's default), so a copy deleted there is never adopted.
  expect(url.searchParams.has("showDeleted")).toBe(false);
  expect(calls[0]?.init.method).toBe("GET");
  expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
});

it("names the lookup when it fails", async () => {
  const { impl } = fakeFetch([{ status: 500, body: "{}" }]);
  await expect(provider(impl).findByMetadata("evt-1")).rejects.toThrow(
    /calendar event lookup failed: HTTP 500/,
  );
});

it("finds nothing when Google has no copy", async () => {
  for (const body of [{ items: [] }, {}]) {
    const { impl } = fakeFetch([{ body: JSON.stringify(body) }]);
    expect(await provider(impl).findByMetadata("evt-1")).toBeNull();
  }
});

it("reads back what it writes: our fields survive the trip through Google's shape", async () => {
  const cases = [
    { ...eventFields(), description: "d", location: "l", sourceUrl: LINK },
    { ...eventFields(), rrule: "FREQ=DAILY;COUNT=3" },
    {
      ...eventFields(),
      allDay: true,
      startLocal: "2026-09-13",
      endLocal: "2026-09-15",
      tzid: null,
    },
  ];
  for (const fields of cases) {
    const { impl, calls } = fakeFetch([{ body: JSON.stringify(eventBody("g1")) }]);
    await provider(impl).upsert(null, fields, { canonicalUid: "evt-1", writeNonce: "n" });
    // Google stores a null as the field being absent, and answers a wall clock with its
    // offset in the event's zone (Prague in September is +02:00).
    const stored = JSON.parse(calls[0]?.init.body ?? "{}", (key, value) =>
      value === null ? undefined : key === "dateTime" ? `${value}+02:00` : value,
    );
    const echoed = googleEventSchema.parse({ ...stored, id: "g1", etag: "e" });
    const back = toProviderEvent(echoed);
    expect(back.fields).toEqual(fields);
    expect(back.metadata).toEqual({ canonicalUid: "evt-1", writeNonce: "n" });
  }
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
    sourceUrl: null,
  };
}

// --- push channels (rc53, T3a) -------------------------------------------------------

it("watches the calendar with a web_hook channel carrying our token, and reads Google's answer", async () => {
  const { impl, calls } = fakeFetch([
    {
      body: JSON.stringify({
        kind: "api#channel",
        id: "ch-1",
        resourceId: "res-1",
        expiration: "4102444800000",
      }),
    },
  ]);
  const made = await provider(impl).watch({
    id: "ch-1",
    token: "secret-token",
    address: "https://whendowe.example/hooks/google",
    ttlSeconds: 604800,
  });
  expect(made).toEqual({ resourceId: "res-1", expiresAt: "2100-01-01T00:00:00.000Z" });
  expect(calls[0]?.url).toBe(`${EVENTS_URL}/watch`);
  expect(calls[0]?.init.method).toBe("POST");
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
    id: "ch-1",
    type: "web_hook",
    address: "https://whendowe.example/hooks/google",
    token: "secret-token",
    params: { ttl: "604800" },
  });
  expect(calls[0]?.init.headers).toMatchObject({
    authorization: `Bearer ${ACCESS_TOKEN}`,
    "content-type": "application/json",
  });
});

it("refuses an answer without a resource id or a numeric expiry, and passes Google's refusal on", async () => {
  for (const body of [{ expiration: "1" }, { resourceId: "r", expiration: "soon" }]) {
    const { impl } = fakeFetch([{ body: JSON.stringify(body) }]);
    await expect(
      provider(impl).watch({ id: "c", token: "t", address: "https://x.example/h", ttlSeconds: 1 }),
    ).rejects.toThrow();
  }
  const { impl } = fakeFetch([{ status: 400, body: "{}" }]);
  await expect(
    provider(impl).watch({ id: "c", token: "t", address: "https://x.example/h", ttlSeconds: 1 }),
  ).rejects.toThrow(HttpError);
});

it("stops a channel by its id and resource id; already gone is success, anything else is not", async () => {
  const { impl, calls } = fakeFetch([
    { status: 204, body: "" },
    { status: 404, body: "" },
    { status: 500, body: "" },
  ]);
  const p = provider(impl);
  await p.stopWatch({ id: "ch-1", resourceId: "res-1" });
  expect(calls[0]?.url).toBe("https://www.googleapis.com/calendar/v3/channels/stop");
  expect(calls[0]?.init.method).toBe("POST");
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ id: "ch-1", resourceId: "res-1" });
  expect(calls[0]?.init.headers).toMatchObject({
    authorization: `Bearer ${ACCESS_TOKEN}`,
    "content-type": "application/json",
  });
  await p.stopWatch({ id: "ch-1", resourceId: "res-1" });
  await expect(p.stopWatch({ id: "ch-1", resourceId: "res-1" })).rejects.toThrow(HttpError);
});
