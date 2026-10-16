// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { createApp } from "../../src/web/app.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { loadMigrationSql } from "../conftest.js";

async function harness() {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const sent: MailMessage[] = [];
  const now = () => new Date().toISOString();
  const app = createApp({
    auth: {
      storage,
      mail: {
        send: (m) => {
          sent.push(m);
          return Promise.resolve();
        },
      },
      publicBaseUrl: "https://whendowe.example",
      secureCookies: false,
      now,
    },
  });
  return { app, sent };
}

type H = Awaited<ReturnType<typeof harness>>;

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});

async function signIn(h: H, email: string): Promise<{ cookie: string; csrf: string }> {
  await h.app.request(SIGN_IN_PATH, post({ email }));
  const t =
    new URL(/https?:\/\/\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "").searchParams.get("t") ??
    "";
  const res = await h.app.request(CONFIRM_PATH, post({ t }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "";
  return { cookie, csrf };
}

async function createGroupVia(
  h: H,
  me: { cookie: string; csrf: string },
  name: string,
): Promise<string> {
  const res = await h.app.request(GROUPS_PATH, post({ csrf: me.csrf, name }, me.cookie));
  expect(res.status).toBe(303);
  return res.headers.get("location") ?? "";
}

it("requires sign-in for every group page", async () => {
  const h = await harness();
  for (const path of [GROUPS_PATH, `${GROUPS_PATH}/anything`]) {
    const res = await h.app.request(path);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(SIGN_IN_PATH);
  }
  expect((await h.app.request(GROUPS_PATH, post({ name: "x" }))).status).toBe(303);
});

it("creates a group and shows it with its organizer", async () => {
  const h = await harness();
  const me = await signIn(h, "dm@example.org");
  const location = await createGroupVia(h, me, "Thursday Table");
  const page = await (await h.app.request(location, { headers: { cookie: me.cookie } })).text();
  expect(page).toContain("<h1>Thursday Table</h1>");
  expect(page).toContain("dm@example.org (you)");
  const list = await (await h.app.request(GROUPS_PATH, { headers: { cookie: me.cookie } })).text();
  expect(list).toContain("you organize");
});

it("refuses to create a group without this session's CSRF token", async () => {
  const h = await harness();
  const me = await signIn(h, "csrf-g@example.org");
  const res = await h.app.request(GROUPS_PATH, post({ name: "Forged" }, me.cookie));
  expect(res.status).toBe(403);
  const list = await (await h.app.request(GROUPS_PATH, { headers: { cookie: me.cookie } })).text();
  expect(list).not.toContain("Forged");
});

it("another person cannot see the group, even with its URL", async () => {
  const h = await harness();
  const owner = await signIn(h, "owner@example.org");
  const location = await createGroupVia(h, owner, "Our Household");
  const stranger = await signIn(h, "stranger@example.org");
  const res = await h.app.request(location, { headers: { cookie: stranger.cookie } });
  // 404, not 403: an outsider must not even learn that the group exists.
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("Our Household");
  const missing = await h.app.request(`${GROUPS_PATH}/no-such-group`, {
    headers: { cookie: stranger.cookie },
  });
  expect(missing.status).toBe(404);
});

it("escapes a hostile group name everywhere it is shown", async () => {
  const h = await harness();
  const me = await signIn(h, "xss@example.org");
  const location = await createGroupVia(h, me, '<img src=x onerror="alert(1)">');
  for (const path of [location, GROUPS_PATH]) {
    const page = await (await h.app.request(path, { headers: { cookie: me.cookie } })).text();
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x");
  }
});

it("rejects an empty name and keeps what was typed", async () => {
  const h = await harness();
  const me = await signIn(h, "empty@example.org");
  const res = await h.app.request(GROUPS_PATH, post({ csrf: me.csrf, name: "   " }, me.cookie));
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Give the group a name.");
});

it("shows a helpful empty state before the first group", async () => {
  const h = await harness();
  const me = await signIn(h, "new@example.org");
  const page = await (await h.app.request(GROUPS_PATH, { headers: { cookie: me.cookie } })).text();
  expect(page).toContain("No groups yet.");
});
