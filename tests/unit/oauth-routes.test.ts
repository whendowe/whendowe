// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, bytesToBase64Url } from "../../src/crypto/base64.js";
import { createTokenCipher, type TokenCipher } from "../../src/crypto/tokens.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { UUIDV7_PATTERN } from "../../src/ids.js";
import type { MailMessage } from "../../src/mail/port.js";
import { GOOGLE_AUTHORIZE_ENDPOINT } from "../../src/oauth/authorize.js";
import { FLOW_COOKIE_NAME, PENDING_COOKIE_NAME } from "../../src/oauth/flow-cookie.js";
import type { FetchLike } from "../../src/oauth/http.js";
import {
  GOOGLE_CALENDAR_LIST_URL,
  GOOGLE_CALENDARS_URL,
  GOOGLE_PRIMARY_CALENDAR_URL,
} from "../../src/oauth/primary-calendar.js";
import { GOOGLE_REVOKE_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "../../src/oauth/token-exchange.js";
import { createApp } from "../../src/web/app.js";
import { CONFIRM_PATH, GOOGLE_SIGN_IN_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { CALLBACK_PATH, CHOOSE_PATH, CONNECT_PATH } from "../../src/web/routes/oauth.js";
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
  readonly calendarId?: string;
  readonly tokenStatus?: number;
  readonly tokenBody?: string;
  /** The account's calendar list, as Google returns its entries (rc40). */
  readonly calendars?: readonly Record<string, unknown>[];
  /** Every request, for tests that check what was asked of Google. */
  readonly log?: { url: string; method: string; body: string | undefined }[];
}

const MADE_ID = "made-by-us@group.calendar.google.com";

const CALENDARS: readonly Record<string, unknown>[] = [
  { id: "family@group.calendar.google.com", summary: "Family", accessRole: "writer" },
  { id: "someone@example.com", summary: "Someone", primary: true, accessRole: "owner" },
];

function json(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function googleFake(options: GoogleFakeOptions = {}): FetchLike {
  const calendars = options.calendars ?? CALENDARS;
  return (url, init) => {
    options.log?.push({ url, method: init.method, body: init.body });
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
              summary: "Someone's calendar",
              timeZone: "Europe/Prague",
            }),
          ),
      });
    }
    if (url.startsWith(`${GOOGLE_CALENDAR_LIST_URL}?`)) return json({ items: calendars });
    if (url.startsWith(`${GOOGLE_CALENDAR_LIST_URL}/`)) {
      const id = decodeURIComponent(url.slice(GOOGLE_CALENDAR_LIST_URL.length + 1));
      const entry = calendars.find((c) => c.id === id);
      return entry === undefined ? json({ error: { message: "Not Found" } }, 404) : json(entry);
    }
    if (url === GOOGLE_CALENDARS_URL) return json({ id: MADE_ID, summary: "WhenDoWe" });
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

/** The sealed pending connection a callback set (rc40), as a Cookie pair. */
function pendingCookie(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${PENDING_COOKIE_NAME}=`));
  return set?.split(";")[0] ?? "";
}

/** Choose a calendar on the page a first connection shows (rc40). */
async function choose(
  h: Harness,
  pending: string,
  calendar: string,
  as: Session = h.session,
): Promise<Response> {
  return h.app.request(
    CHOOSE_PATH,
    form({ csrf: as.csrf, calendar }, [as.cookie, pending].filter((c) => c !== "").join("; ")),
  );
}

/** Connect all the way: Google's consent, then the calendar choice. */
async function connect(h: Harness, calendar = "new"): Promise<Response> {
  const { cookie, state } = await startFlow(h);
  const chooser = await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie);
  expect(chooser.status).toBe(200);
  return choose(h, pendingCookie(chooser), calendar);
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
  const signedOut = await h.app.request("/");
  expect(signedOut.status).toBe(200);
  expect(await signedOut.text()).not.toContain(CONNECT_PATH);
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
  const pending = pendingCookie(done);
  const chosen = await app.request(
    CHOOSE_PATH,
    form({ csrf: me.csrf, calendar: "new" }, `${me.cookie}; ${pending}`),
  );
  expect(chosen.status).toBe(200);
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

it("completes the flow and stores an encrypted connection to a new WhenDoWe calendar", async () => {
  const h = await harness();
  const response = await connect(h);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(
    "<h1>Calendar connected</h1><p>Connected <strong>WhenDoWe</strong>.</p>",
  );

  const rows = await connections(h);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row?.owner_id).toBe(h.personId);
  expect(row?.provider).toBe("google");
  expect(row?.account_email).toBe("someone@example.com");
  expect(row?.calendar_id).toBe(MADE_ID);
  expect(row?.made_by_us).toBe(1);
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

it("upserts on reconnect instead of duplicating or colliding, keeping the calendar", async () => {
  // Each consent issues a new grant: the reconnect must store the second one.
  let grants = 0;
  const h = await harness((url, init) => {
    if (url !== GOOGLE_TOKEN_ENDPOINT) return googleFake()(url, init);
    grants++;
    return json({
      access_token: `${ACCESS_TOKEN}-${grants}`,
      refresh_token: `${REFRESH_TOKEN}-${grants}`,
      expires_in: 3600,
      token_type: "Bearer",
    });
  });
  await connect(h);

  // Simulate a cursor established by a later sync, which a reconnect must not drop.
  await h.storage.batch([
    {
      sql: "UPDATE calendar_connection SET sync_token = ?, status = ?",
      params: ["cursor-1", "auth_error"],
    },
  ]);

  h.now.value = "2026-09-12T14:00:00.000Z";
  const second = await startFlow(h);
  const again = await callback(
    h,
    `code=code-2&state=${encodeURIComponent(second.state)}`,
    second.cookie,
  );
  // A reconnect asks nothing: it keeps the calendar it already writes to.
  expect(await again.text()).toContain("<h1>Calendar reconnected</h1><p>Reconnected.</p>");
  expect(pendingCookie(again)).toBe("");

  const rows = await connections(h);
  // (owner_id, provider, calendar_id) is UNIQUE — a plain INSERT would have thrown.
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("active");
  expect(rows[0]?.token_expiry).toBe("2026-09-12T15:00:00.000Z");
  // A live cursor survives reconnect; a dead one is handled by 410 GONE (§12).
  expect(rows[0]?.sync_token).toBe("cursor-1");
  expect(rows[0]?.calendar_id).toBe(MADE_ID);
  expect(rows[0]?.made_by_us).toBe(1);
  expect(await h.cipher.decrypt(String(rows[0]?.access_token_enc))).toBe(`${ACCESS_TOKEN}-2`);
  expect(await h.cipher.decrypt(String(rows[0]?.refresh_token_enc))).toBe(`${REFRESH_TOKEN}-2`);
});

// --- choosing the calendar (rc40) ---

it("asks a first connection which calendar, a new one chosen, the main one first; stores nothing yet", async () => {
  const h = await harness();
  const { cookie, state } = await startFlow(h);
  const res = await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie);
  const page = await res.text();
  expect(page).toContain("<h1>Choose a calendar</h1>");
  expect(page).toContain(`action="${CHOOSE_PATH}"`);
  expect(page).toContain(`name="csrf" value="${h.session.csrf}"`);
  expect(page).toContain('value="new" checked');
  const main = page.indexOf('value="someone@example.com"');
  const family = page.indexOf('value="family@group.calendar.google.com"');
  expect(main).toBeGreaterThan(page.indexOf('value="new"'));
  expect(family).toBeGreaterThan(main);
  expect(page).toContain("(your main calendar)");
  expect(await connections(h)).toHaveLength(0);
  // The grant waits sealed in this browser, on /oauth only, for ten minutes, never readable.
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${PENDING_COOKIE_NAME}=`));
  expect(set).toContain("HttpOnly");
  expect(set).toContain("Path=/oauth");
  expect(set).toContain("Max-Age=600");
  expect(set).not.toContain(ACCESS_TOKEN);
  expect(set).not.toContain(encodeURIComponent(REFRESH_TOKEN));
});

it("makes the new calendar in the main calendar's zone, named WhenDoWe", async () => {
  const log: { url: string; method: string; body: string | undefined }[] = [];
  const h = await harness(googleFake({ log }));
  await connect(h);
  const made = log.filter((r) => r.url === GOOGLE_CALENDARS_URL);
  expect(made).toHaveLength(1);
  expect(made[0]?.method).toBe("POST");
  expect(JSON.parse(made[0]?.body ?? "")).toEqual({
    summary: "WhenDoWe",
    timeZone: "Europe/Prague",
  });
});

it("connects a calendar of their own, checked with Google, and makes none", async () => {
  const log: { url: string; method: string; body: string | undefined }[] = [];
  const h = await harness(googleFake({ log }));
  const res = await connect(h, "family@group.calendar.google.com");
  expect(await res.text()).toContain("Connected <strong>Family</strong>");
  const [row] = await connections(h);
  expect(row?.calendar_id).toBe("family@group.calendar.google.com");
  expect(row?.made_by_us).toBe(0);
  expect(log.some((r) => r.url === GOOGLE_CALENDARS_URL)).toBe(false);
});

it("refuses a calendar Google says can't take events, or doesn't know", async () => {
  const h = await harness(
    googleFake({
      calendars: [
        ...CALENDARS,
        { id: "holidays@group.v.calendar.google.com", summary: "Holidays", accessRole: "reader" },
      ],
    }),
  );
  for (const id of ["holidays@group.v.calendar.google.com", "someone-elses@example.com"]) {
    const { cookie, state } = await startFlow(h);
    const chooser = await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie);
    const res = await choose(h, pendingCookie(chooser), id);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "<h1>Not connected</h1><p>That calendar can't take events. Please start again.</p>",
    );
  }
  expect(await connections(h)).toHaveLength(0);
});

it("lists only calendars that can take events", async () => {
  const h = await harness(
    googleFake({
      calendars: [
        ...CALENDARS,
        { id: "ro@example.com", summary: "Read only", accessRole: "reader" },
      ],
    }),
  );
  const { cookie, state } = await startFlow(h);
  const page = await (
    await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie)
  ).text();
  expect(page).toContain("Family");
  expect(page).not.toContain("ro@example.com");
});

it("refuses a choice without the pending grant, from someone else, or without CSRF", async () => {
  const h = await harness();
  const { cookie, state } = await startFlow(h);
  const chooser = await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie);
  const pending = pendingCookie(chooser);

  const none = await choose(h, "", "new");
  expect(none.status).toBe(400);
  expect(await none.text()).toContain("<h1>Attempt expired</h1>");
  const other = await signIn(h, "someone-else@example.org");
  const stopped = await choose(h, pending, "new", other);
  expect(stopped.status).toBe(403);
  expect(await stopped.text()).toContain(
    "<h1>Connection stopped</h1><p>You're no longer signed in as the person who started this.",
  );
  const forged = await h.app.request(
    CHOOSE_PATH,
    form({ csrf: "nope", calendar: "new" }, `${h.session.cookie}; ${pending}`),
  );
  expect(forged.status).toBe(403);
  expect(await forged.text()).toContain("<h1>Request rejected</h1><p>Please try again.</p>");
  const signedOut = await h.app.request(CHOOSE_PATH, form({ calendar: "new" }, pending));
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.get("location")).toBe(SIGN_IN_PATH);
  const blank = await choose(h, pending, "");
  expect(blank.status).toBe(400);
  expect(await blank.text()).toContain("<h1>Choose a calendar</h1><p>Please choose one.</p>");
  expect(await connections(h)).toHaveLength(0);
});

it("refuses an expired or tampered pending grant, and clears it either way", async () => {
  const h = await harness();
  const { cookie, state } = await startFlow(h);
  const chooser = await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie);
  const pending = pendingCookie(chooser);

  const value = pending.slice(`${PENDING_COOKIE_NAME}=`.length);
  const bytes = base64ToBytes(decodeURIComponent(value));
  const last = bytes.length - 1;
  bytes[last] = (bytes[last] ?? 0) ^ 0x01;
  const tampered = await choose(
    h,
    `${PENDING_COOKIE_NAME}=${encodeURIComponent(bytesToBase64(bytes))}`,
    "new",
  );
  expect(tampered.status).toBe(400);
  expect(tampered.headers.get("set-cookie")).toContain(`${PENDING_COOKIE_NAME}=; `);

  h.now.value = "2026-09-12T12:11:00.000Z";
  expect((await choose(h, pending, "new")).status).toBe(400);
  expect(await connections(h)).toHaveLength(0);
});

it("allows one Google connection per account: a second choice is refused", async () => {
  const h = await harness();
  // Two tabs both reach the choice; the first wins.
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    const { cookie, state } = await startFlow(h);
    tabs.push(
      pendingCookie(await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie)),
    );
  }
  expect((await choose(h, tabs[0] ?? "", "new")).status).toBe(200);
  const second = await choose(h, tabs[1] ?? "", "family@group.calendar.google.com");
  expect(second.status).toBe(409);
  expect(await second.text()).toContain(
    "<h1>Already connected</h1><p>This account already has a calendar connected.</p>",
  );
  expect(await connections(h)).toHaveLength(1);
});

it("refuses to reconnect through a different Google account, and gives that grant back", async () => {
  const revoked: string[] = [];
  let account = "someone@example.com";
  const h = await harness((url, init) => {
    if (url === GOOGLE_REVOKE_ENDPOINT) {
      revoked.push(new URLSearchParams(init.body ?? "").get("token") ?? "");
      return json({});
    }
    return googleFake({ calendarId: account })(url, init);
  });
  await connect(h);
  account = "other@example.com";
  const { cookie, state } = await startFlow(h);
  const res = await callback(h, `code=c&state=${encodeURIComponent(state)}`, cookie);
  expect(res.status).toBe(409);
  const text = await res.text();
  expect(text).toContain("<h1>Not connected</h1>");
  expect(text).toContain("someone@example.com");
  expect(revoked).toEqual([REFRESH_TOKEN]);
  const [row] = await connections(h);
  expect(row?.account_email).toBe("someone@example.com");
});

it("home says where the calendar is connected, and offers to reconnect after auth_error", async () => {
  const h = await harness();
  const home = async () =>
    (await h.app.request("/", { headers: { cookie: h.session.cookie } })).text();
  expect(await home()).toContain("Connect Google Calendar");
  await connect(h);
  const connected = await home();
  expect(connected).toContain("Google Calendar connected: someone@example.com.");
  expect(connected).not.toContain(`action="${CONNECT_PATH}"`);
  await h.storage.batch([
    { sql: "UPDATE calendar_connection SET status = 'auth_error'", params: [] },
  ]);
  const broken = await home();
  expect(broken).toContain("Reconnect Google Calendar");
  expect(broken).toContain(`action="${CONNECT_PATH}"`);
  // Someone else's connection is theirs: this person still has none.
  const other = await signIn(h, "someone-else@example.org");
  const theirs = await (await h.app.request("/", { headers: { cookie: other.cookie } })).text();
  expect(theirs).toContain("Connect Google Calendar");
  expect(theirs).not.toContain("someone@example.com");
});

it("a connection of another provider is not this account's Google connection", async () => {
  const h = await harness();
  await h.storage.batch([
    {
      sql: `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
              access_token_enc, refresh_token_enc, status, created_at, updated_at)
            VALUES ('x', ?, 'caldav', 'dav@example.org', 'dav', 'e', 'e', 'active', ?, ?)`,
      params: [h.personId, NOW, NOW],
    },
  ]);
  const home = await (await h.app.request("/", { headers: { cookie: h.session.cookie } })).text();
  expect(home).toContain("Connect Google Calendar");
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

it("names a calendar by its id when it has no name", async () => {
  const h = await harness(
    googleFake({ calendars: [{ id: "nameless@group.calendar.google.com", accessRole: "owner" }] }),
  );
  const { cookie, state } = await startFlow(h);
  const response = await callback(h, `code=auth-code&state=${encodeURIComponent(state)}`, cookie);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("> nameless@group.calendar.google.com</label>");
});

it("escapes a calendar summary containing markup", async () => {
  // The summary is whatever the account holder typed into Google (§13: provider
  // content is untrusted input in both directions).
  const h = await harness(
    googleFake({
      calendars: [
        {
          id: "x@group.calendar.google.com",
          summary: '<img src=x onerror="alert(1)">',
          accessRole: "owner",
        },
      ],
    }),
  );
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
  // The session records how it was made (rc42): Google here, a sign-in link for the owner's.
  const via = await h.storage.query({
    sql: "SELECT p.email, s.via FROM session s JOIN person p ON p.id = s.person_id ORDER BY p.email",
    params: [],
  });
  expect(via).toEqual([
    { email: "ann@gmail.com", via: "google" },
    { email: OWNER_EMAIL, via: "magic" },
  ]);
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
  await connect(h);
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
