// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { createTokenCipher } from "../../src/crypto/tokens.js";
import { stmt } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { hashToken } from "../../src/people/tokens.js";
import { GOOGLE_HOOK_PATH } from "../../src/reconcile/watch.js";
import { createApp } from "../../src/web/app.js";
import { registerHookRoutes } from "../../src/web/routes/hooks.js";
import type { AppEnv } from "../../src/web/session.js";
import { loadMigrationSql } from "../conftest.js";

// POST /hooks/google (DESIGN §10 rc53): a notification must name a channel we made, on an active
// connection, and carry its secret; then, unless it is the channel's first "sync", the
// connection is read. Anything else is 404, and nothing is read.

const T0 = "2101-11-21T10:00:00.000Z";
const SECRET = "the-channel-secret";

async function setUp() {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const ann = await findOrCreatePerson(storage, "ann@example.org", { now: T0 });
  const row = async (id: string, channel: string | null, hash: string | null, status = "active") =>
    storage.batch([
      stmt(
        `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
           access_token_enc, refresh_token_enc, status, watch_channel, watch_token_hash,
           created_at, updated_at)
         VALUES (?, ?, 'google', ?, ?, 'x', 'x', ?, ?, ?, ?, ?)`,
        id,
        ann.id,
        `${id}@example.org`,
        `cal-${id}`,
        status,
        channel,
        hash,
        T0,
        T0,
      ),
    ]);
  const hash = await hashToken(SECRET);
  await row("conn-1", "ch-1", hash);
  await row("conn-gone", "ch-gone", hash, "auth_error");
  await row("conn-nohash", "ch-nohash", null);
  const poked: string[] = [];
  const app = new Hono<AppEnv>();
  registerHookRoutes(app, {
    storage,
    poke: (id) => {
      poked.push(id);
      return Promise.resolve();
    },
  });
  const notify = (headers: Record<string, string>, method = "POST") =>
    app.request(GOOGLE_HOOK_PATH, { method, headers });
  return { poked, notify, storage };
}

const good = {
  "x-goog-channel-id": "ch-1",
  "x-goog-channel-token": SECRET,
  "x-goog-resource-state": "exists",
};

it("a notification with its channel's secret asks for that connection to be read", async () => {
  const t = await setUp();
  const res = await t.notify(good);
  expect(res.status).toBe(200);
  expect(t.poked).toEqual(["conn-1"]);
});

it("the channel's first sync is answered and reads nothing", async () => {
  const t = await setUp();
  expect((await t.notify({ ...good, "x-goog-resource-state": "sync" })).status).toBe(200);
  expect(t.poked).toEqual([]);
});

it("refuses a wrong secret, an unknown channel, a connection not active, one with no secret, and missing headers", async () => {
  const t = await setUp();
  const cases: Record<string, string>[] = [
    { ...good, "x-goog-channel-token": "guess" },
    { ...good, "x-goog-channel-token": `${SECRET}x` },
    { ...good, "x-goog-channel-id": "ch-unknown" },
    { ...good, "x-goog-channel-id": "ch-gone" },
    { ...good, "x-goog-channel-id": "ch-nohash" },
    { "x-goog-channel-id": "ch-1", "x-goog-resource-state": "exists" },
    { "x-goog-channel-token": SECRET },
    { ...good, "x-goog-channel-token": "x".repeat(300) },
    {},
  ];
  for (const headers of cases) {
    const res = await t.notify(headers);
    expect(res.status, JSON.stringify(Object.keys(headers))).toBe(404);
    expect(await res.text()).toBe("");
  }
  expect(t.poked).toEqual([]);
});

it("GET never reads anything", async () => {
  const t = await setUp();
  expect((await t.notify(good, "GET")).status).toBe(404);
  expect(t.poked).toEqual([]);
});

it("on Workers the notification is answered without waiting for the read", async () => {
  const t = await setUp();
  let release: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waited: Promise<unknown>[] = [];
  const app = new Hono<AppEnv>();
  registerHookRoutes(app, { storage: t.storage, poke: () => reading });
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => undefined,
    props: {},
  };
  const res = await app.request(GOOGLE_HOOK_PATH, { method: "POST", headers: good }, {}, ctx);
  expect(res.status).toBe(200);
  expect(waited).toHaveLength(1);
  release();
  await Promise.all(waited);
});

it("the app has the endpoint only with Google configured and a way to read", async () => {
  const t = await setUp();
  const oauth = {
    storage: t.storage,
    cipher: await createTokenCipher([{ id: 1, material: `${"A".repeat(43)}=` }], 1),
    clientId: "c",
    clientSecret: "s",
    redirectUri: "http://localhost:8080/oauth/google/callback",
    now: () => T0,
    secureCookies: false,
  };
  const poked: string[] = [];
  const poke = (id: string) => {
    poked.push(id);
    return Promise.resolve();
  };
  const send = (app: ReturnType<typeof createApp>) =>
    app.request(GOOGLE_HOOK_PATH, { method: "POST", headers: good });
  expect((await send(createApp({ oauth, poke }))).status).toBe(200);
  expect(poked).toEqual(["conn-1"]);
  expect((await send(createApp({ oauth }))).status).toBe(404);
  expect((await send(createApp({ poke }))).status).toBe(404);
  expect(poked).toEqual(["conn-1"]);
});
