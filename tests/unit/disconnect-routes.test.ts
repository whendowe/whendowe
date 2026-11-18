// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { createTokenCipher } from "../../src/crypto/tokens.js";
import { stmt } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
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
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import {
  CALLBACK_PATH,
  CHOOSE_PATH,
  CONNECT_PATH,
  DISCONNECT_PATH,
} from "../../src/web/routes/oauth.js";
import { loadMigrationSql } from "../conftest.js";

// Disconnecting Google Calendar (DESIGN §10 *Google Calendar, one way*, rc40; MVP-4 G3): a
// page asks what to do with the copies — Remove them, Keep them, and for a calendar WhenDoWe
// made, Delete the WhenDoWe calendar — and either way the grant goes back to Google and the
// tokens are deleted. Removing is the push tick's (push-tick.suite.ts); here, the pages.

const NOW = "2101-10-01T10:00:00.000Z";
const KEY = { id: 1, material: `${"A".repeat(43)}=` };
const REFRESH = "1//refresh-token-value";
const MADE_ID = "made-by-us@group.calendar.google.com";
const OWN_ID = "family@group.calendar.google.com";
const ASK = "Also remove the 2 WhenDoWe events from your Google calendar?";
const REMOVING = "WhenDoWe is removing its events from your Google calendar";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly auth: string | undefined;
}

const reply = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });

/** Google, as far as connecting and disconnecting reach it; `deleteStatus` for the calendar. */
function google(log: Call[], opts: { deleteStatus?: number } = {}): FetchLike {
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

const form = (fields: Record<string, string>, cookie: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  body: new URLSearchParams(fields).toString(),
});

async function harness(opts: { deleteStatus?: number; capabilities?: CapabilityConfig } = {}) {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const cipher = await createTokenCipher([KEY], 1);
  const sent: { text: string }[] = [];
  const log: Call[] = [];
  let n = 0;
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
      ...(opts.capabilities === undefined ? {} : { capabilities: opts.capabilities }),
    },
    oauth: {
      storage,
      cipher,
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:8080/oauth/google/callback",
      now: () => NOW,
      newId: () => `conn-${++n}`,
      fetchImpl: google(log, opts),
      secureCookies: false,
    },
  });
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
  /** Copies in Google, as the push tick records them: `n` live, and one already deleted. */
  const copies = async (n: number) => {
    const id = String((await connection())?.id);
    for (let i = 0; i <= n; i++) {
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
          i < n ? "synced" : "deleted",
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

const button = (value: string, label: string) =>
  `<button type="submit" name="copies" value="${value}">${label}</button>`;

it("home links to the page, which asks about the copies and asks Google nothing", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  expect(await h.page("/")).toContain(`<a href="${DISCONNECT_PATH}">Disconnect</a>`);
  const before = h.log.length;
  const res = await h.get(DISCONNECT_PATH);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain(`<form method="post" action="${DISCONNECT_PATH}">`);
  expect(text).toContain(ASK); // the one already deleted in Google isn't counted
  expect(text).toContain(button("remove", "Remove them"));
  expect(text).toContain(button("keep", "Keep them"));
  expect(text).toContain(button("calendar", "Delete the WhenDoWe calendar"));
  expect(text).toContain("Either way, WhenDoWe gives its access back to Google and forgets it.");
  expect(h.log.length).toBe(before); // Google isn't asked
  expect((await h.connection())?.status).toBe("active");
});

it("a calendar of your own is never offered for deletion; one copy is one event; none, nothing asked", async () => {
  const h = await harness();
  await h.connect(OWN_ID);
  await h.copies(1);
  const one = await h.page(DISCONNECT_PATH);
  expect(one).toContain("Also remove the 1 WhenDoWe event from your Google calendar?");
  expect(one).not.toContain('value="calendar"');
  expect((await h.leave("calendar")).status).toBe(409);
  expect(await h.count("calendar_connection")).toBe(1);
  expect(h.log.some((c) => c.method === "DELETE")).toBe(false);

  const g = await harness();
  await g.connect();
  const none = await g.page(DISCONNECT_PATH);
  expect(none).toContain("None of your WhenDoWe events are in your Google calendar.");
  expect(none).toContain(button("keep", "Disconnect"));
  expect(none).toContain(button("calendar", "Delete the WhenDoWe calendar"));
  expect(none).not.toContain('value="remove"');
});

it("Keep them: the grant goes back to Google and the connection is forgotten; the copies stay", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  expect(await h.count("busy_calendar")).toBe(1);
  const res = await h.leave("keep");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain(
    "Google Calendar is disconnected. The 2 WhenDoWe events there stay, and are no longer updated.",
  );
  expect(h.revokes()).toEqual([new URLSearchParams({ token: REFRESH }).toString()]);
  expect(await h.count("calendar_connection")).toBe(0);
  expect(await h.count("projection")).toBe(0);
  expect(await h.count("busy_calendar")).toBe(0);
  expect(h.log.some((c) => c.method === "DELETE")).toBe(false);
  const home = await h.page("/");
  expect(home).toContain(">Connect Google Calendar</button>");
  expect(home).not.toContain(DISCONNECT_PATH);
  expect((await h.get(DISCONNECT_PATH)).status).toBe(404);
  expect((await h.leave("keep")).status).toBe(404);
});

it("Remove them: the connection is marked for the tick, its busy times stop, Google isn't called yet", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  const calls = h.log.length;
  const res = await h.leave("remove");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain(REMOVING);
  expect((await h.connection())?.status).toBe("disconnected");
  expect(await h.count("busy_calendar")).toBe(0);
  expect(await h.count("projection")).toBe(3); // the tick's to remove
  expect(h.log.length).toBe(calls);
  expect(await h.page("/")).toContain(
    "Disconnecting Google Calendar: removing your WhenDoWe events from it.",
  );
  expect(await h.page(DISCONNECT_PATH)).toContain(REMOVING);
  // Pressed again, or another choice from a stale page: still just removing.
  expect(await (await h.leave("keep")).text()).toContain(REMOVING);
  expect((await h.connection())?.status).toBe("disconnected");
  expect(h.revokes()).toEqual([]);
});

it("Delete the WhenDoWe calendar: one call to Google, then the grant goes back and it's forgotten", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  const res = await h.leave("calendar");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain(
    "Google Calendar is disconnected, and the WhenDoWe calendar deleted.",
  );
  const deletes = h.log.filter((c) => c.method === "DELETE");
  expect(deletes).toEqual([
    {
      url: `${GOOGLE_CALENDARS_URL}/${encodeURIComponent(MADE_ID)}`,
      method: "DELETE",
      body: undefined,
      auth: "Bearer ya29.access",
    },
  ]);
  expect(h.revokes()).toHaveLength(1);
  expect(await h.count("calendar_connection")).toBe(0);
  expect(await h.count("projection")).toBe(0);
});

it("a WhenDoWe calendar already gone counts as deleted; Google failing changes nothing", async () => {
  const gone = await harness({ deleteStatus: 404 });
  await gone.connect();
  expect((await gone.leave("calendar")).status).toBe(200);
  expect(await gone.count("calendar_connection")).toBe(0);

  const down = await harness({ deleteStatus: 503 });
  await down.connect();
  const res = await down.leave("calendar");
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("Google didn't answer just now.");
  expect(await down.count("calendar_connection")).toBe(1);
  expect((await down.connection())?.status).toBe("active");
  expect(down.revokes()).toEqual([]);
});

it("after Google stopped accepting: only Disconnect, and the copies are yours to remove", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  await h.storage.batch([stmt("UPDATE calendar_connection SET status = 'auth_error'")]);
  expect(await h.page("/")).toContain(
    `<p class="muted"><a href="${DISCONNECT_PATH}">Disconnect</a></p>`,
  );
  const text = await h.page(DISCONNECT_PATH);
  expect(text).toContain(
    "the 2 WhenDoWe events in your Google calendar can't be removed from here; remove them in Google Calendar yourself.",
  );
  expect(text).toContain(button("keep", "Disconnect"));
  expect(text).not.toContain('value="remove"');
  expect(text).not.toContain('value="calendar"');
  for (const choice of ["remove", "calendar"]) {
    expect((await h.leave(choice)).status).toBe(409);
    expect((await h.connection())?.status).toBe("auth_error");
  }
  expect((await h.leave("keep")).status).toBe(200);
  expect(await h.count("calendar_connection")).toBe(0);
});

it("without calendar_sync, disconnecting and removing the copies still work", async () => {
  const h = await harness({ capabilities: { default: "granted", operators: [] } });
  // Connected before the capability was gated: the row is what matters.
  const g = await harness();
  await g.connect();
  const row = (await g.storage.query(stmt("SELECT * FROM calendar_connection")))[0];
  const person = (await h.storage.query(stmt("SELECT id FROM person")))[0];
  await h.storage.batch([
    stmt(
      `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
         access_token_enc, refresh_token_enc, token_expiry, status, made_by_us, created_at, updated_at)
       VALUES ('c', ?, 'google', 'ann@example.com', ?, ?, ?, ?, 'active', 1, ?, ?)`,
      String(person?.id),
      MADE_ID,
      String(row?.access_token_enc),
      String(row?.refresh_token_enc),
      String(row?.token_expiry),
      NOW,
      NOW,
    ),
  ]);
  await h.copies(2);
  expect(await h.page("/")).toContain(`<a href="${DISCONNECT_PATH}">Disconnect</a>`);
  expect(await h.page(DISCONNECT_PATH)).toContain(ASK);
  expect((await h.leave("remove")).status).toBe(200);
  expect((await h.connection())?.status).toBe("disconnected");
});

it("signed out, without the form's token, or with no choice: nothing changes; others are untouched", async () => {
  const h = await harness();
  await h.connect();
  const signedOut = await h.app.request(DISCONNECT_PATH, form({ copies: "keep" }, ""));
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.get("location")).toBe(SIGN_IN_PATH);
  expect((await h.app.request(DISCONNECT_PATH)).status).toBe(303);
  const forged = await h.app.request(
    DISCONNECT_PATH,
    form({ csrf: "stale", copies: "keep" }, h.ann.cookie),
  );
  expect(forged.status).toBe(403);
  for (const bad of ["", "maybe", "Keep them"]) {
    const res = await h.leave(bad);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Choose one.");
  }
  // Bob, with no connection of his own, can't reach Ann's.
  const bob = await h.signIn("bob@example.org");
  expect((await h.get(DISCONNECT_PATH, bob)).status).toBe(404);
  expect((await h.leave("keep", bob)).status).toBe(404);
  expect(await h.count("calendar_connection")).toBe(1);
  expect(h.revokes()).toEqual([]);
});
