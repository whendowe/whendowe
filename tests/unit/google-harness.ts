// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect } from "vitest";
import { createTokenCipher } from "../../src/crypto/tokens.js";
import { stmt } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { PENDING_COOKIE_NAME } from "../../src/oauth/flow-cookie.js";
import type { FetchLike } from "../../src/oauth/http.js";
import {
  GOOGLE_CALENDAR_LIST_URL,
  GOOGLE_CALENDARS_URL,
  GOOGLE_PRIMARY_CALENDAR_URL,
} from "../../src/oauth/primary-calendar.js";
import { GOOGLE_REVOKE_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "../../src/oauth/token-exchange.js";
import type { CapabilityConfig } from "../../src/people/capability.js";
import { createApp } from "../../src/web/app.js";
import type { AuthDeps } from "../../src/web/routes/auth.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import {
  CALLBACK_PATH,
  CHOOSE_PATH,
  CONNECT_PATH,
  DISCONNECT_PATH,
} from "../../src/web/routes/oauth.js";
import { loadMigrationSql } from "../conftest.js";

// One browser's app with Google faked (DESIGN §10 *Google Calendar, one way*, rc40): sign in,
// connect a calendar all the way, record its copies, disconnect it. For the G3 route tests.

export const NOW = "2101-10-01T10:00:00.000Z";
export const KEY = { id: 1, material: `${"A".repeat(43)}=` };
export const REFRESH = "1//refresh-token-value";
export const MADE_ID = "made-by-us@group.calendar.google.com";
export const OWN_ID = "family@group.calendar.google.com";

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly auth: string | undefined;
}

const reply = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });

/** Google, as far as connecting and disconnecting reach it; `deleteStatus` for the calendar. */
export function google(log: Call[], opts: { deleteStatus?: number } = {}): FetchLike {
  const calendars = [
    { id: OWN_ID, summary: "Family", accessRole: "writer" },
    { id: "ann@example.com", summary: "Ann", primary: true, accessRole: "owner" },
  ];
  return (url, init) => {
    const headers = new Headers(init.headers);
    log.push({
      url,
      method: init.method,
      body: init.body,
      auth: headers.get("authorization") ?? undefined,
    });
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return reply({
        access_token: "ya29.access",
        refresh_token: REFRESH,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/calendar.events",
      });
    }
    if (url === GOOGLE_REVOKE_ENDPOINT) return reply({});
    if (url === GOOGLE_PRIMARY_CALENDAR_URL) {
      return reply({ id: "ann@example.com", timeZone: "Europe/Prague" });
    }
    if (url.startsWith(`${GOOGLE_CALENDAR_LIST_URL}?`)) return reply({ items: calendars });
    if (url.startsWith(`${GOOGLE_CALENDAR_LIST_URL}/`)) {
      const id = decodeURIComponent(url.slice(GOOGLE_CALENDAR_LIST_URL.length + 1));
      const entry = calendars.find((c) => c.id === id);
      return entry === undefined ? reply({}, 404) : reply(entry);
    }
    if (url === GOOGLE_CALENDARS_URL) return reply({ id: MADE_ID, summary: "WhenDoWe" });
    if (url === `${GOOGLE_CALENDARS_URL}/${encodeURIComponent(MADE_ID)}`) {
      return reply({}, opts.deleteStatus ?? 204);
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

export const form = (fields: Record<string, string>, cookie: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  body: new URLSearchParams(fields).toString(),
});

export async function harness(
  opts: { deleteStatus?: number; capabilities?: CapabilityConfig } = {},
) {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const cipher = await createTokenCipher([KEY], 1);
  const sent: MailMessage[] = [];
  const log: Call[] = [];
  let n = 0;
  const auth: AuthDeps = {
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
    ...(opts.capabilities === undefined ? {} : { capabilities: opts.capabilities }),
  };
  const oauth = {
    storage,
    cipher,
    clientId: "cid.apps.googleusercontent.com",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:8080/oauth/google/callback",
    now: () => NOW,
    newId: () => `conn-${++n}`,
    fetchImpl: google(log, opts),
    secureCookies: false,
  };
  const app = createApp({ auth, oauth });
  const signIn = async (email: string) => {
    await app.request(SIGN_IN_PATH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email }).toString(),
    });
    const t =
      new URL(/https?:\/\/\S+/.exec(sent.at(-1)?.text ?? "")?.[0] ?? "").searchParams.get("t") ??
      "";
    const res = await app.request(CONFIRM_PATH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t }).toString(),
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const home = await (await app.request("/", { headers: { cookie } })).text();
    return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "" };
  };
  const ann = await signIn("ann@example.org");
  const get = async (path: string, as = ann) =>
    app.request(path, { headers: { cookie: as.cookie } });
  const page = async (path: string, as = ann) => (await get(path, as)).text();
  /** Connect all the way, to a new WhenDoWe calendar or one of Ann's own. */
  const connect = async (calendar: "new" | typeof OWN_ID = "new", as = ann) => {
    const start = await app.request(CONNECT_PATH, form({ csrf: as.csrf }, as.cookie));
    const flow = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const chooser = await app.request(
      `${CALLBACK_PATH}?code=c&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `${as.cookie}; ${flow}` },
      },
    );
    const pending =
      chooser.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${PENDING_COOKIE_NAME}=`))
        ?.split(";")[0] ?? "";
    const body = new URLSearchParams({ csrf: as.csrf, calendar });
    body.append("busy", OWN_ID);
    const res = await app.request(CHOOSE_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${as.cookie}; ${pending}`,
      },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
  };
  const connection = async () =>
    (await storage.query(stmt("SELECT id, status, made_by_us FROM calendar_connection")))[0];
  /** Copies in Google, as the push tick records them: `n` live, one deleted, one never made. */
  const copies = async (n: number) => {
    const id = String((await connection())?.id);
    for (let i = 0; i <= n + 1; i++) {
      await storage.batch([
        stmt(
          `INSERT INTO canonical_event (id, origin, owner_id, title, start_local, end_local, tzid,
             created_at, updated_at) VALUES (?, 'user_edit', 'x', 'Dinner', '2101-11-21T18:00',
             '2101-11-21T20:00', 'Europe/Prague', ?, ?)`,
          `ev-${i}`,
          NOW,
          NOW,
        ),
        stmt(
          `INSERT INTO projection (id, canonical_event_id, calendar_connection_id, visibility_profile,
             provider_event_id, state, created_at, updated_at) VALUES (?, ?, ?, 'FULL', ?, ?, ?, ?)`,
          `pr-${i}`,
          `ev-${i}`,
          id,
          i < n ? `g-${i}` : null,
          i < n ? "synced" : i === n ? "deleted" : "error",
          NOW,
          NOW,
        ),
      ]);
    }
  };
  const count = async (table: string) => {
    const sql = {
      projection: "SELECT COUNT(*) AS n FROM projection",
      busy_calendar: "SELECT COUNT(*) AS n FROM busy_calendar",
      calendar_connection: "SELECT COUNT(*) AS n FROM calendar_connection",
    }[table];
    return Number((await storage.query(stmt(sql ?? "")))[0]?.n);
  };
  const leave = (copiesChoice: string, as = ann) =>
    app.request(DISCONNECT_PATH, form({ csrf: as.csrf, copies: copiesChoice }, as.cookie));
  const revokes = () => log.filter((c) => c.url === GOOGLE_REVOKE_ENDPOINT).map((c) => c.body);
  return {
    app,
    auth,
    oauth,
    sent,
    storage,
    log,
    ann,
    signIn,
    get,
    page,
    connect,
    connection,
    copies,
    count,
    leave,
    revokes,
  };
}
