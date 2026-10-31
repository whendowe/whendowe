// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, bytesToBase64Url } from "../../src/crypto/base64.js";
import { createTokenCipher, type TokenCipher } from "../../src/crypto/tokens.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { UUIDV7_PATTERN } from "../../src/ids.js";
import type { MailMessage } from "../../src/mail/port.js";
import { GOOGLE_AUTHORIZE_ENDPOINT } from "../../src/oauth/authorize.js";
import { FLOW_COOKIE_NAME } from "../../src/oauth/flow-cookie.js";
import type { FetchLike } from "../../src/oauth/http.js";
import { GOOGLE_PRIMARY_CALENDAR_URL } from "../../src/oauth/primary-calendar.js";
import { GOOGLE_REVOKE_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "../../src/oauth/token-exchange.js";
import { createApp } from "../../src/web/app.js";
import { CONFIRM_PATH, GOOGLE_SIGN_IN_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { CALLBACK_PATH, CONNECT_PATH } from "../../src/web/routes/oauth.js";
import { loadMigrationSql } from "../conftest.js";

// Route-level tests against a real in-memory SQLite database and a fake fetch, so
// the whole connect flow runs end to end without network. Since MVP-1 E every flow
// belongs to a signed-in person: the harness signs one in, and callback() sends that
// session cookie alongside whatever flow cookie a test supplies.

const KEY = { id: 1, material: `${"A".repeat(43)}=` };
const OWNER_EMAIL = "owner@example.org";
const REDIRECT_URI = "http://localhost:8080/oauth/google/callback";
const NOW = "2026-09-12T12:00:00.000Z";

const ACCESS_TOKEN = "ya29.access-token-value";
const REFRESH_TOKEN = "1//refresh-token-value";

interface Session {
  cookie: string;
  csrf: string;
}

interface Harness {
  app: ReturnType<typeof createApp>;
  cipher: TokenCipher;
  storage: ReturnType<typeof sqliteStoragePort>;
  now: { value: string };
  sent: MailMessage[];
  /** The signed-in owner every flow runs as, unless a test says otherwise. */
  session: Session;
  personId: string;
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

function form(fields: Record<string, string>, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  };
}

/** Sign in by magic link; with `alongside`, in a browser that holds that cookie already. */
async function signIn(
  h: Pick<Harness, "app" | "sent">,
  email: string,
  alongside?: string,
): Promise<Session> {
  await h.app.request(SIGN_IN_PATH, form({ email }));
  const t =
    new URL(/https?:\/\/\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "").searchParams.get("t") ??
    "";
  const res = await h.app.request(CONFIRM_PATH, form({ t }, alongside));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "" };
}

async function harness(fetchImpl: FetchLike = googleFake()): Promise<Harness> {
  const storage = await makeStorage();
  const cipher = await createTokenCipher([KEY], 1);
  const now = { value: NOW };
  const sent: MailMessage[] = [];
  let counter = 0;
  const app = createApp({
    auth: {
      storage,
      mail: {
        send: (m) => {
          sent.push(m);
          return Promise.resolve();
        },
      },
      publicBaseUrl: "http://localhost:8080",
      secureCookies: false,
      // Sessions must outlive the scenario clock jumps below, so they use real time.
      now: () => new Date().toISOString(),
    },
    oauth: {
      storage,
      cipher,
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "client-secret",
      redirectUri: REDIRECT_URI,
      now: () => now.value,
      newId: () => `conn-${++counter}`,
      fetchImpl,
      secureCookies: false,
    },
  });
  const session = await signIn({ app, sent }, OWNER_EMAIL);
  const rows = await storage.query({
    sql: "SELECT id FROM person WHERE email = ?",
    params: [OWNER_EMAIL],
  });
  return { app, cipher, storage, now, sent, session, personId: String(rows[0]?.id) };
}

/** Run the connect leg as the harness owner; returns the flow cookie and state. */
async function startFlow(
  h: Harness,
  as: Session = h.session,
): Promise<{ cookie: string; state: string }> {
  const response = await h.app.request(CONNECT_PATH, form({ csrf: as.csrf }, as.cookie));
  expect(response.status).toBe(303);

  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const location = response.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  expect(cookie).toContain(FLOW_COOKIE_NAME);
  expect(state).not.toBe("");
  return { cookie, state };
}

/** The callback as a browser would send it: the flow cookie plus a session cookie. */
async function callback(
  h: Harness,
  query: string,
  flowCookie?: string,
  as: Session | null = h.session,
): Promise<Response> {
  const cookies = [as?.cookie, flowCookie].filter((c): c is string => c !== undefined && c !== "");
  return h.app.request(`${CALLBACK_PATH}?${query}`, {
    headers: cookies.length === 0 ? {} : { cookie: cookies.join("; ") },
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
  const response = await h.app.request(
    CONNECT_PATH,
    form({ csrf: h.session.csrf }, h.session.cookie),
  );

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
  const response = await h.app.request(
    CONNECT_PATH,
    form({ csrf: h.session.csrf }, h.session.cookie),
  );
  const location = response.headers.get("location") ?? "";
  // Only the challenge may travel to Google; the verifier stays in the cookie.
  expect(location).not.toContain("code_verifier");
});

it("does not start a flow on GET", async () => {
  const h = await harness();
  // A GET that mutated state could be triggered by any page with an <img> tag.
  expect((await h.app.request(CONNECT_PATH)).status).toBe(404);
});

it("offers the connect button only to a signed-in person, carrying their CSRF token", async () => {
  const h = await harness();
  const signedIn = await (
    await h.app.request("/", { headers: { cookie: h.session.cookie } })
  ).text();
  expect(signedIn).toContain(CONNECT_PATH);
  expect(signedIn).toContain(`name="csrf" value="${h.session.csrf}"`);
  expect(await (await h.app.request("/")).text()).not.toContain(CONNECT_PATH);
  const bare = await (await createApp().request("/")).text();
  expect(bare).not.toContain(CONNECT_PATH);
  expect(bare).toContain("not configured");
});

// --- ownership (MVP-1 E) -----------------------------------------------------------

it("requires sign-in to start connecting a calendar", async () => {
  const h = await harness();
  const res = await h.app.request(CONNECT_PATH, form({}));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(SIGN_IN_PATH);
  expect(res.headers.get("set-cookie") ?? "").not.toContain(FLOW_COOKIE_NAME);
});

it("refuses to start a flow without this session's CSRF token", async () => {
  // The gap M1 documented: with no session there was nothing to bind a token to.
  const h = await harness();
  const res = await h.app.request(CONNECT_PATH, form({}, h.session.cookie));
  expect(res.status).toBe(403);
  expect(res.headers.get("set-cookie") ?? "").not.toContain(FLOW_COOKIE_NAME);
});

it("stores the connection under the person who connected it, with a UUIDv7 id by default", async () => {
  const storage = await makeStorage();
  const sent: MailMessage[] = [];
  const app = createApp({
    auth: {
      storage,
      mail: {
        send: (m) => {
          sent.push(m);
          return Promise.resolve();
        },
      },
      publicBaseUrl: "http://localhost:8080",
      secureCookies: false,
      now: () => new Date().toISOString(),
    },
    oauth: {
      storage,
      cipher: await createTokenCipher([KEY], 1),
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: REDIRECT_URI,
      now: () => new Date().toISOString(),
      fetchImpl: googleFake(),
      secureCookies: false,
    },
  });
  const me = await signIn({ app, sent }, "mine@example.org");
  const start = await app.request(CONNECT_PATH, form({ csrf: me.csrf }, me.cookie));
  const flowCookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const done = await app.request(`${CALLBACK_PATH}?code=c&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `${me.cookie}; ${flowCookie}` },
  });
  expect(done.status).toBe(200);
  const [row] = await storage.query({
    sql: "SELECT id, owner_id FROM calendar_connection",
    params: [],
  });
  const [person] = await storage.query({
    sql: "SELECT id FROM person WHERE email = ?",
    params: ["mine@example.org"],
  });
  expect(row?.owner_id).toBe(person?.id);
  expect(row?.owner_id).not.toBe("self");
  expect(String(row?.id)).toMatch(UUIDV7_PATTERN);
});

it("refuses the callback if a different person is signed in by then", async () => {
  // Sign out and in as someone else mid-flow: the calendar must not attach to them.
  const h = await harness();
  const { cookie, state } = await startFlow(h);
  const other = await signIn(h, "someone-else@example.org");
  const res = await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie, other);
  expect(res.status).toBe(403);
  expect(await connections(h)).toHaveLength(0);
});

it("refuses the callback if nobody is signed in by then", async () => {
  const h = await harness();
  const { cookie, state } = await startFlow(h);
  const res = await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie, null);
  expect(res.status).toBe(403);
  expect(await connections(h)).toHaveLength(0);
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
  expect(row?.owner_id).toBe(h.personId);
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

// --- sign in with Google (§13 rc20) -------------------------------------------------

const CLIENT_ID = "cid.apps.googleusercontent.com";
const encode = (value: unknown) =>
  bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

/** An ID token as Google's token endpoint returns it, for the harness's client and clock. */
function idTokenFor(email: string, claims: Record<string, unknown> = {}): string {
  return [
    encode({ alg: "RS256", kid: "k" }),
    encode({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "1234567890",
      exp: Date.parse(NOW) / 1000 + 3600,
      email,
      email_verified: true,
      ...claims,
    }),
    "signature",
  ].join(".");
}

function signInFake(idToken: string): FetchLike {
  return googleFake({
    tokenBody: JSON.stringify({
      access_token: ACCESS_TOKEN,
      id_token: idToken,
      expires_in: 3599,
      token_type: "Bearer",
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
    }),
  });
}

/** Press "Sign in with Google", signed out unless a cookie is given. */
async function startSignIn(h: Harness, cookie?: string) {
  const res = await h.app.request(GOOGLE_SIGN_IN_PATH, form({}, cookie));
  expect(res.status).toBe(303);
  const flowCookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const location = new URL(res.headers.get("location") ?? "");
  return { cookie: flowCookie, state: location.searchParams.get("state") ?? "", location };
}

/** The session cookie a response installs, if any (the flow cookie is cleared beside it). */
function sessionCookie(res: Response): string | null {
  const set = res.headers.getSetCookie().find((c) => !c.startsWith(`${FLOW_COOKIE_NAME}=`));
  return set === undefined ? null : (set.split(";")[0] ?? null);
}

async function people(h: Harness): Promise<string[]> {
  const rows = await h.storage.query({
    sql: "SELECT email FROM person ORDER BY email",
    params: [],
  });
  return rows.map((r) => String(r.email));
}

async function finishSignIn(h: Harness, as: Session | null = null) {
  const { cookie, state } = await startSignIn(h, as?.cookie);
  return callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie, as);
}

it("offers Google on the sign-in page only where Google is configured", async () => {
  const h = await harness();
  const page = await (await h.app.request(SIGN_IN_PATH)).text();
  expect(page).toContain(`action="${GOOGLE_SIGN_IN_PATH}"`);
  expect(page).toContain("Sign in with Google");
  const noGoogle = createApp({
    auth: {
      storage: h.storage,
      mail: { send: () => Promise.resolve() },
      publicBaseUrl: "http://localhost:8080",
      secureCookies: false,
      now: () => new Date().toISOString(),
    },
  });
  expect(await (await noGoogle.request(SIGN_IN_PATH)).text()).not.toContain(GOOGLE_SIGN_IN_PATH);
  expect((await noGoogle.request(GOOGLE_SIGN_IN_PATH, form({}))).status).toBe(404);
});

it("asks Google for openid email only, signed out, and seals a sign-in flow", async () => {
  const h = await harness();
  const { cookie, location } = await startSignIn(h);
  expect(`${location.origin}${location.pathname}`).toBe(GOOGLE_AUTHORIZE_ENDPOINT);
  expect(location.searchParams.get("scope")).toBe("openid email");
  expect(location.searchParams.get("prompt")).toBe("select_account");
  expect(location.searchParams.get("access_type")).toBeNull();
  // The same callback as the calendar: one redirect URI on the OAuth client.
  expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(cookie).toContain(FLOW_COOKIE_NAME);
  expect((await h.app.request(GOOGLE_SIGN_IN_PATH)).status).toBe(404); // GET never mutates
});

it("lands on the person a magic link to the same address gives, and stores nothing of Google's", async () => {
  // The harness owner signed in by link as owner@example.org: a Workspace account.
  const h = await harness(signInFake(idTokenFor("Owner@Example.org", { hd: "example.org" })));
  const res = await finishSignIn(h);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  const cookie = sessionCookie(res);
  expect(cookie).not.toBeNull();
  const home = await (await h.app.request("/", { headers: { cookie: cookie ?? "" } })).text();
  expect(home).toContain(OWNER_EMAIL);
  expect(await people(h)).toEqual([OWNER_EMAIL]);
  expect(await connections(h)).toHaveLength(0);
  expect(res.headers.getSetCookie().some((c) => c.startsWith(`${FLOW_COOKIE_NAME}=;`))).toBe(true);
});

it("signs a new Gmail address up, and while signed in adds it as another account", async () => {
  const h = await harness(signInFake(idTokenFor("ann@gmail.com")));
  const res = await finishSignIn(h, h.session);
  expect(res.status).toBe(303);
  expect(await people(h)).toEqual(["ann@gmail.com", OWNER_EMAIL]);
  const home = await (
    await h.app.request("/", { headers: { cookie: sessionCookie(res) ?? "" } })
  ).text();
  // Ann is active; the owner is still on this browser, one switch away.
  expect(home).toContain("ann@gmail.com");
  expect(home).toContain(OWNER_EMAIL);
});

it("offers the email link for an address Google doesn't host, and signs no one in", async () => {
  const h = await harness(signInFake(idTokenFor("ann@old-job.example")));
  const res = await finishSignIn(h);
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(text).toContain(`action="${SIGN_IN_PATH}"`);
  expect(text).toContain('name="email" value="ann@old-job.example"');
  expect(sessionCookie(res)).toBeNull();
  expect(await people(h)).toEqual([OWNER_EMAIL]);
});

it("refuses an unverified address, and a token for another client", async () => {
  for (const [token, status] of [
    [idTokenFor("ann@gmail.com", { email_verified: false }), 400],
    [idTokenFor("ann@gmail.com", { aud: "another-client" }), 502],
  ] as const) {
    const h = await harness(signInFake(token));
    const res = await finishSignIn(h);
    expect(res.status).toBe(status);
    expect(sessionCookie(res)).toBeNull();
    expect(await people(h)).toEqual([OWNER_EMAIL]);
  }
});

it("refuses a state that doesn't match (login CSRF), signing no one in", async () => {
  const h = await harness(signInFake(idTokenFor("attacker@gmail.com")));
  const { cookie } = await startSignIn(h);
  const res = await callback(h, "code=attacker-code&state=wrong", cookie, null);
  expect(res.status).toBe(400);
  expect(sessionCookie(res)).toBeNull();
  expect(await people(h)).toEqual([OWNER_EMAIL]);
});

it("a sign-in flow never connects a calendar, and a connect flow never signs anyone in", async () => {
  // Google's answer carries everything either flow could want.
  const h = await harness(
    googleFake({
      tokenBody: JSON.stringify({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        id_token: idTokenFor("ann@gmail.com"),
        expires_in: 3599,
        token_type: "Bearer",
      }),
    }),
  );
  await finishSignIn(h, h.session);
  expect(await connections(h)).toHaveLength(0);

  const connect = await startFlow(h);
  const res = await callback(
    h,
    `code=c&state=${encodeURIComponent(connect.state)}`,
    connect.cookie,
    null,
  );
  expect(res.status).toBe(403);
  expect(sessionCookie(res)).toBeNull();
});

it("a cancelled sign-in says why Google may refuse, and points to the email link", async () => {
  const h = await harness();
  const { cookie } = await startSignIn(h);
  const res = await callback(h, "error=access_denied", cookie, null);
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(text).toContain("access_denied");
  expect(text).toContain("testers");
  expect(text).toContain(`href="${SIGN_IN_PATH}"`);
});

it("refuses a fifth account before anyone is created", async () => {
  const h = await harness(signInFake(idTokenFor("fifth@gmail.com")));
  let browser = h.session;
  for (const email of ["b@example.org", "c@example.org", "d@example.org"]) {
    browser = await signIn(h, email, browser.cookie);
  }
  const res = await finishSignIn(h, browser);
  expect(res.status).toBe(409);
  expect(await people(h)).not.toContain("fifth@gmail.com");
});

// --- deleting an account revokes its Google grant (§10 rc21) ---------------------------

it("deleting an account revokes its calendar grant at Google, then deletes the tokens", async () => {
  const revoked: string[] = [];
  const base = googleFake();
  const h = await harness((url, init) => {
    if (url === GOOGLE_REVOKE_ENDPOINT) {
      revoked.push(new URLSearchParams(init.body ?? "").get("token") ?? "");
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
    }
    return base(url, init);
  });
  const { cookie, state } = await startFlow(h);
  await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie);
  expect(await connections(h)).toHaveLength(1);

  const asked = await h.app.request(
    "/account/delete",
    form({ csrf: h.session.csrf, confirm: OWNER_EMAIL }, h.session.cookie),
  );
  expect(asked.status).toBe(200);
  // Nothing is revoked while the account waits its 7 days (§10 rc22)…
  expect(revoked).toEqual([]);
  expect(await connections(h)).toHaveLength(1);
  // …and "delete it now" from the emailed link revokes, then deletes.
  const link = /\/account\/deletion\?t=(\S+)/.exec(h.sent.at(-1)?.text ?? "")?.[1] ?? "";
  const done = await h.app.request(
    "/account/deletion",
    form({ t: decodeURIComponent(link), do: "now" }),
  );
  expect(done.status).toBe(200);
  expect(revoked).toEqual([REFRESH_TOKEN]);
  expect(await connections(h)).toHaveLength(0);
});
