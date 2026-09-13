// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../../src/crypto/base64.js";
import { createTokenCipher, type TokenCipher } from "../../src/crypto/tokens.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { GOOGLE_AUTHORIZE_ENDPOINT } from "../../src/oauth/authorize.js";
import { FLOW_COOKIE_NAME } from "../../src/oauth/flow-cookie.js";
import type { FetchLike } from "../../src/oauth/http.js";
import { GOOGLE_PRIMARY_CALENDAR_URL } from "../../src/oauth/primary-calendar.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../../src/oauth/token-exchange.js";
import { createApp } from "../../src/web/app.js";
import { CALLBACK_PATH, CONNECT_PATH, type OAuthRouteDeps } from "../../src/web/routes/oauth.js";
import { loadMigrationSql } from "../conftest.js";

// Route-level tests against a real in-memory SQLite database and a fake fetch, so
// the whole connect flow runs end to end without network. The routes touch storage
// only through the port, which tests/contract already proves on both drivers, so
// these do not need to run in workerd as well.

const KEY = { id: 1, material: `${"A".repeat(43)}=` };
const OWNER = "owner-1";
const REDIRECT_URI = "http://localhost:8080/oauth/google/callback";
const NOW = "2026-09-12T12:00:00.000Z";

const ACCESS_TOKEN = "ya29.access-token-value";
const REFRESH_TOKEN = "1//refresh-token-value";

interface Harness {
  app: ReturnType<typeof createApp>;
  cipher: TokenCipher;
  storage: Awaited<ReturnType<typeof makeStorage>>;
  now: { value: string };
}

async function makeStorage() {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) {
    await client.executeMultiple(sql);
  }
  return sqliteStoragePort(client);
}

interface GoogleFakeOptions {
  readonly calendarSummary?: string | null;
  readonly calendarId?: string;
  readonly tokenStatus?: number;
  readonly tokenBody?: string;
}

function googleFake(options: GoogleFakeOptions = {}): FetchLike {
  return (url) => {
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const body =
        options.tokenBody ??
        JSON.stringify({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/calendar",
        });
      const status = options.tokenStatus ?? 200;
      return Promise.resolve({
        ok: status < 300,
        status,
        text: () => Promise.resolve(body),
      });
    }
    if (url === GOOGLE_PRIMARY_CALENDAR_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              id: options.calendarId ?? "someone@example.com",
              // `?? ` would collapse an intentional null into the default, which
              // is exactly the fallback this fake needs to be able to exercise.
              summary:
                options.calendarSummary === undefined
                  ? "Someone's calendar"
                  : options.calendarSummary,
              timeZone: "Europe/Prague",
            }),
          ),
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

async function harness(fetchImpl: FetchLike = googleFake()): Promise<Harness> {
  const storage = await makeStorage();
  const cipher = await createTokenCipher([KEY], 1);
  const now = { value: NOW };
  let counter = 0;
  const deps: OAuthRouteDeps = {
    storage,
    cipher,
    clientId: "cid.apps.googleusercontent.com",
    clientSecret: "client-secret",
    redirectUri: REDIRECT_URI,
    ownerId: OWNER,
    now: () => now.value,
    newId: () => `conn-${++counter}`,
    fetchImpl,
    secureCookies: false,
  };
  return { app: createApp(deps), cipher, storage, now };
}

/** Run the connect leg and return what the browser would carry into the callback. */
async function startFlow(h: Harness): Promise<{ cookie: string; state: string }> {
  const response = await h.app.request(CONNECT_PATH, { method: "POST" });
  expect(response.status).toBe(303);

  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const location = response.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  expect(cookie).toContain(FLOW_COOKIE_NAME);
  expect(state).not.toBe("");
  return { cookie, state };
}

async function callback(h: Harness, query: string, cookie?: string): Promise<Response> {
  return h.app.request(`${CALLBACK_PATH}?${query}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function connections(h: Harness) {
  return h.storage.query({
    sql: "SELECT * FROM calendar_connection ORDER BY id",
    params: [],
  });
}

// --- the connect leg ---

it("redirects to Google with the PKCE challenge and sets the flow cookie", async () => {
  const h = await harness();
  const response = await h.app.request(CONNECT_PATH, { method: "POST" });

  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(GOOGLE_AUTHORIZE_ENDPOINT);
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("code_challenge")).not.toBeNull();
  expect(location.searchParams.get("access_type")).toBe("offline");
  expect(location.searchParams.get("prompt")).toBe("consent");
  expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);

  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
});

it("never puts the PKCE verifier in the redirect URL", async () => {
  const h = await harness();
  const response = await h.app.request(CONNECT_PATH, { method: "POST" });
  const location = response.headers.get("location") ?? "";
  // Only the challenge may travel to Google; the verifier stays in the cookie.
  expect(location).not.toContain("code_verifier");
});

it("does not start a flow on GET", async () => {
  const h = await harness();
  // A GET that mutated state could be triggered by any page with an <img> tag.
  expect((await h.app.request(CONNECT_PATH)).status).toBe(404);
});

it("offers the connect button only when configured", async () => {
  const h = await harness();
  expect(await (await h.app.request("/")).text()).toContain(CONNECT_PATH);
  const bare = createApp();
  const html = await (await bare.request("/")).text();
  expect(html).not.toContain(CONNECT_PATH);
  expect(html).toContain("not configured");
});

// --- the callback leg, happy path ---

it("completes the flow and stores an encrypted connection", async () => {
  const h = await harness();
  const { cookie, state } = await startFlow(h);

  const response = await callback(h, `code=auth-code&state=${encodeURIComponent(state)}`, cookie);
  expect(response.status).toBe(200);

  const rows = await connections(h);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row?.owner_id).toBe(OWNER);
  expect(row?.provider).toBe("google");
  expect(row?.account_email).toBe("someone@example.com");
  expect(row?.calendar_id).toBe("someone@example.com");
  expect(row?.status).toBe("active");
  expect(row?.token_expiry).toBe("2026-09-12T13:00:00.000Z");

  // Tokens at rest are ciphertext, and decrypt back to the originals (§13).
  expect(row?.access_token_enc).not.toBe(ACCESS_TOKEN);
  expect(row?.refresh_token_enc).not.toBe(REFRESH_TOKEN);
  expect(String(row?.access_token_enc)).not.toContain(ACCESS_TOKEN);
  expect(await h.cipher.decrypt(String(row?.access_token_enc))).toBe(ACCESS_TOKEN);
  expect(await h.cipher.decrypt(String(row?.refresh_token_enc))).toBe(REFRESH_TOKEN);
});

it("clears the flow cookie after use", async () => {
  const h = await harness();
  const { cookie, state } = await startFlow(h);
  const response = await callback(h, `code=auth-code&state=${encodeURIComponent(state)}`, cookie);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});

it("upserts on reconnect instead of duplicating or colliding", async () => {
  const h = await harness();
  const first = await startFlow(h);
  await callback(h, `code=code-1&state=${encodeURIComponent(first.state)}`, first.cookie);

  // Simulate a cursor established by a later sync, which a reconnect must not drop.
  await h.storage.batch([
    {
      sql: "UPDATE calendar_connection SET sync_token = ?, status = ?",
      params: ["cursor-1", "auth_error"],
    },
  ]);

  h.now.value = "2026-09-12T14:00:00.000Z";
  const second = await startFlow(h);
  await callback(h, `code=code-2&state=${encodeURIComponent(second.state)}`, second.cookie);

  const rows = await connections(h);
  // (owner_id, provider, calendar_id) is UNIQUE — a plain INSERT would have thrown.
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("active");
  expect(rows[0]?.token_expiry).toBe("2026-09-12T15:00:00.000Z");
  // A live cursor survives reconnect; a dead one is handled by 410 GONE (§12).
  expect(rows[0]?.sync_token).toBe("cursor-1");
});

// --- the callback leg, rejections ---

it("rejects a state that does not match the cookie (login CSRF)", async () => {
  const h = await harness();
  const { cookie } = await startFlow(h);
  const response = await callback(h, "code=attacker-code&state=not-the-right-state", cookie);
  expect(response.status).toBe(400);
  expect(await connections(h)).toHaveLength(0);
});

it("rejects a callback with no flow cookie", async () => {
  const h = await harness();
  const { state } = await startFlow(h);
  const response = await callback(h, `code=auth-code&state=${encodeURIComponent(state)}`);
  expect(response.status).toBe(400);
  expect(await connections(h)).toHaveLength(0);
});

it("rejects a tampered flow cookie", async () => {
  const h = await harness();
  const { cookie, state } = await startFlow(h);

  const value = cookie.slice(`${FLOW_COOKIE_NAME}=`.length);
  const bytes = base64ToBytes(decodeURIComponent(value));
  const last = bytes.length - 1;
  bytes[last] = (bytes[last] ?? 0) ^ 0x01;
  const tampered = `${FLOW_COOKIE_NAME}=${encodeURIComponent(bytesToBase64(bytes))}`;

  const response = await callback(h, `code=auth-code&state=${encodeURIComponent(state)}`, tampered);
  expect(response.status).toBe(400);
  expect(await connections(h)).toHaveLength(0);
});

it("rejects an expired flow", async () => {
  const h = await harness();
  const { cookie, state } = await startFlow(h);
  h.now.value = "2026-09-12T12:11:00.000Z"; // 11 minutes later, TTL is 10
  const response = await callback(h, `code=auth-code&state=${encodeURIComponent(state)}`, cookie);
  expect(response.status).toBe(400);
  expect(await connections(h)).toHaveLength(0);
});

it("rejects an absurdly long query field before doing any work", async () => {
  const h = await harness();
  const { cookie } = await startFlow(h);
  const response = await callback(h, `code=${"a".repeat(3000)}&state=x`, cookie);
  expect(response.status).toBe(400);
  expect(await connections(h)).toHaveLength(0);
});

it("rejects a callback missing the code", async () => {
  const h = await harness();
  const { cookie, state } = await startFlow(h);
  const response = await callback(h, `state=${encodeURIComponent(state)}`, cookie);
  expect(response.status).toBe(400);
  expect(await connections(h)).toHaveLength(0);
});

it("reports a declined consent without storing anything", async () => {
  const h = await harness();
  const { cookie } = await startFlow(h);
  const response = await callback(h, "error=access_denied", cookie);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("access_denied");
  expect(await connections(h)).toHaveLength(0);
});

// --- escaping (§13) ---

it("escapes a hostile error parameter", async () => {
  const h = await harness();
  const { cookie } = await startFlow(h);
  // Anyone can send the user to the callback with any query they like.
  const response = await callback(
    h,
    `error=${encodeURIComponent("<script>alert(1)</script>")}`,
    cookie,
  );
  const html = await response.text();
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;");
});

it("falls back to the calendar id when there is no summary", async () => {
  const h = await harness(googleFake({ calendarSummary: null }));
  const { cookie, state } = await startFlow(h);
  const response = await callback(h, `code=auth-code&state=${encodeURIComponent(state)}`, cookie);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("someone@example.com");
});

it("escapes a calendar summary containing markup", async () => {
  // The summary is whatever the account holder typed into Google (§13: provider
  // content is untrusted input in both directions).
  const h = await harness(googleFake({ calendarSummary: '<img src=x onerror="alert(1)">' }));
  const { cookie, state } = await startFlow(h);
  const response = await callback(h, `code=auth-code&state=${encodeURIComponent(state)}`, cookie);
  const html = await response.text();
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain('onerror="alert(1)"');
});
