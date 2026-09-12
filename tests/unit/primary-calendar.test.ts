// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import type { FetchLike, HttpRequestInit } from "../../src/oauth/http.js";
import {
  fetchPrimaryCalendar,
  GOOGLE_PRIMARY_CALENDAR_URL,
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
