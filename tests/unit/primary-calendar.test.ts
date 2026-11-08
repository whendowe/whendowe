// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import type { FetchLike, HttpRequestInit } from "../../src/oauth/http.js";
import {
  createCalendar,
  fetchPrimaryCalendar,
  findWritableCalendar,
  GOOGLE_CALENDAR_LIST_URL,
  GOOGLE_CALENDARS_URL,
  GOOGLE_PRIMARY_CALENDAR_URL,
  listWritableCalendars,
} from "../../src/oauth/primary-calendar.js";

const ACCESS_TOKEN = "ya29.access-token";

interface Recorded {
  url: string;
  init: HttpRequestInit;
}

function fakeFetch(status: number, body: string): { impl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    });
  };
  return { impl, calls };
}

it("GETs the primary calendarList entry with a bearer token", async () => {
  const { impl, calls } = fakeFetch(200, JSON.stringify({ id: "someone@example.com" }));
  await fetchPrimaryCalendar(ACCESS_TOKEN, impl);

  expect(calls[0]?.url).toBe(GOOGLE_PRIMARY_CALENDAR_URL);
  expect(calls[0]?.init.method).toBe("GET");
  expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(calls[0]?.init.body).toBeUndefined();
});

it("keeps the access token out of the URL", async () => {
  const { impl, calls } = fakeFetch(200, JSON.stringify({ id: "someone@example.com" }));
  await fetchPrimaryCalendar(ACCESS_TOKEN, impl);
  expect(calls[0]?.url).not.toContain(ACCESS_TOKEN);
  expect(calls[0]?.url).not.toContain("?");
});

it("maps the fields it needs", async () => {
  const { impl } = fakeFetch(
    200,
    JSON.stringify({
      id: "someone@example.com",
      summary: "someone@example.com",
      timeZone: "Europe/Prague",
      accessRole: "owner",
      // Fields we do not model must not break the parse.
      backgroundColor: "#9fe1e7",
      selected: true,
    }),
  );
  expect(await fetchPrimaryCalendar(ACCESS_TOKEN, impl)).toEqual({
    id: "someone@example.com",
    summary: "someone@example.com",
    timeZone: "Europe/Prague",
    accessRole: "owner",
  });
});

it("nulls optional fields Google omitted", async () => {
  const { impl } = fakeFetch(200, JSON.stringify({ id: "someone@example.com" }));
  expect(await fetchPrimaryCalendar(ACCESS_TOKEN, impl)).toEqual({
    id: "someone@example.com",
    summary: null,
    timeZone: null,
    accessRole: null,
  });
});

it("accepts explicit nulls as well as omitted fields", async () => {
  // Google normally omits absent fields, but an explicit null is a legitimate way
  // for an API to say the same thing and must not fail a connect.
  const { impl } = fakeFetch(
    200,
    JSON.stringify({ id: "someone@example.com", summary: null, timeZone: null }),
  );
  expect(await fetchPrimaryCalendar(ACCESS_TOKEN, impl)).toEqual({
    id: "someone@example.com",
    summary: null,
    timeZone: null,
    accessRole: null,
  });
});

it("requires an id", async () => {
  // account_email and calendar_id are both NOT NULL in §10's schema, and this call
  // is where both come from — an id-less response cannot produce a valid row.
  const { impl } = fakeFetch(200, JSON.stringify({ summary: "no id here" }));
  await expect(fetchPrimaryCalendar(ACCESS_TOKEN, impl)).rejects.toThrow(/unexpected shape.*id/s);
});

it("surfaces an auth failure from Google", async () => {
  const { impl } = fakeFetch(401, JSON.stringify({ error: { message: "Invalid Credentials" } }));
  await expect(fetchPrimaryCalendar(ACCESS_TOKEN, impl)).rejects.toThrow(
    /HTTP 401.*Invalid Credentials/,
  );
});

it("never puts the access token into an error message", async () => {
  const { impl } = fakeFetch(401, JSON.stringify({ error: "unauthorized" }));
  let message = "";
  try {
    await fetchPrimaryCalendar(ACCESS_TOKEN, impl);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toBe("");
  expect(message).not.toContain(ACCESS_TOKEN);
});

// --- choosing a calendar (rc40) ---

/** A fetch that answers each call with the next of `pages`. */
function pagedFetch(pages: readonly unknown[]): { impl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const body = JSON.stringify(pages[calls.length - 1] ?? {});
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
  };
  return { impl, calls };
}

it("lists writable calendars by their own names, the main one first, across pages", async () => {
  const { impl, calls } = pagedFetch([
    {
      items: [
        { id: "a@group", summary: "A", accessRole: "writer" },
        { id: "me@example.com", summary: "me@example.com", primary: true, accessRole: "owner" },
      ],
      nextPageToken: "p2",
    },
    { items: [{ id: "b@group", summary: "B", summaryOverride: "My B", accessRole: "owner" }] },
  ]);
  expect(await listWritableCalendars(ACCESS_TOKEN, impl)).toEqual([
    { id: "me@example.com", name: "me@example.com", primary: true },
    { id: "a@group", name: "A", primary: false },
    { id: "b@group", name: "My B", primary: false },
  ]);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.init.method).toBe("GET");
  expect(calls[0]?.init.headers.accept).toBe("application/json");
  const first = new URL(calls[0]?.url ?? "");
  expect(`${first.origin}${first.pathname}`).toBe(GOOGLE_CALENDAR_LIST_URL);
  expect(first.searchParams.get("minAccessRole")).toBe("writer");
  expect(first.searchParams.get("maxResults")).toBe("250");
  expect(first.searchParams.has("pageToken")).toBe(false);
  expect(new URL(calls[1]?.url ?? "").searchParams.get("pageToken")).toBe("p2");
  expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(calls[0]?.url).not.toContain(ACCESS_TOKEN);
});

it("drops a calendar that can't take events, whatever the filter let through", async () => {
  const { impl } = pagedFetch([
    {
      items: [
        { id: "r@group", accessRole: "reader" },
        { id: "f@group", accessRole: "freeBusyReader" },
        { id: "n@group" },
        { id: "w@group", accessRole: "writer" },
      ],
    },
  ]);
  expect(await listWritableCalendars(ACCESS_TOKEN, impl)).toEqual([
    { id: "w@group", name: "w@group", primary: false },
  ]);
});

it("reads at most four pages, and an empty list is no calendars", async () => {
  const page = { items: [], nextPageToken: "more" };
  const { impl, calls } = pagedFetch([page, page, page, page, page, page]);
  expect(await listWritableCalendars(ACCESS_TOKEN, impl)).toEqual([]);
  expect(calls).toHaveLength(4);
  expect(await listWritableCalendars(ACCESS_TOKEN, pagedFetch([{}]).impl)).toEqual([]);
});

it("checks a chosen calendar by its escaped id", async () => {
  const { impl, calls } = fakeFetch(
    200,
    JSON.stringify({ id: "a/b@group", summary: "A", accessRole: "writer" }),
  );
  expect(await findWritableCalendar(ACCESS_TOKEN, "a/b@group", impl)).toEqual({
    id: "a/b@group",
    name: "A",
    primary: false,
  });
  expect(calls[0]?.url).toBe(`${GOOGLE_CALENDAR_LIST_URL}/a%2Fb%40group`);
  expect(calls[0]?.init.method).toBe("GET");
  expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
});

it("finds no calendar that is read-only or unknown, and passes other failures on", async () => {
  const reader = fakeFetch(200, JSON.stringify({ id: "r@group", accessRole: "reader" }));
  expect(await findWritableCalendar(ACCESS_TOKEN, "r@group", reader.impl)).toBeNull();
  const unknown = fakeFetch(404, JSON.stringify({ error: { message: "Not Found" } }));
  expect(await findWritableCalendar(ACCESS_TOKEN, "x@group", unknown.impl)).toBeNull();
  const broken = fakeFetch(500, JSON.stringify({ error: { message: "Backend Error" } }));
  await expect(findWritableCalendar(ACCESS_TOKEN, "x@group", broken.impl)).rejects.toThrow(
    /HTTP 500/,
  );
});

it("makes a calendar with a name and a zone, and returns its id", async () => {
  const { impl, calls } = fakeFetch(200, JSON.stringify({ id: "new@group", summary: "WhenDoWe" }));
  expect(
    await createCalendar(ACCESS_TOKEN, { summary: "WhenDoWe", timeZone: "Europe/Prague" }, impl),
  ).toBe("new@group");
  expect(calls[0]?.url).toBe(GOOGLE_CALENDARS_URL);
  expect(GOOGLE_CALENDARS_URL).toBe("https://www.googleapis.com/calendar/v3/calendars");
  expect(calls[0]?.init.method).toBe("POST");
  expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(calls[0]?.init.body ?? "")).toEqual({
    summary: "WhenDoWe",
    timeZone: "Europe/Prague",
  });
});

it("leaves the zone to Google when the main calendar had none", async () => {
  const { impl, calls } = fakeFetch(200, JSON.stringify({ id: "new@group" }));
  await createCalendar(ACCESS_TOKEN, { summary: "WhenDoWe", timeZone: null }, impl);
  expect(JSON.parse(calls[0]?.init.body ?? "")).toEqual({ summary: "WhenDoWe" });
});

it("says which call failed", async () => {
  const fail = fakeFetch(403, JSON.stringify({ error: { message: "Forbidden" } })).impl;
  await expect(listWritableCalendars(ACCESS_TOKEN, fail)).rejects.toThrow(/^calendar list failed/);
  await expect(findWritableCalendar(ACCESS_TOKEN, "x", fail)).rejects.toThrow(
    /^calendar lookup failed/,
  );
  await expect(
    createCalendar(ACCESS_TOKEN, { summary: "WhenDoWe", timeZone: null }, fail),
  ).rejects.toThrow(/^calendar create failed/);
});
