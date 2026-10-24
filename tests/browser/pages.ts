// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { createApp } from "../../src/web/app.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { loadMigrationSql } from "../conftest.js";

// Renders the pages the browser tier drives (DESIGN §9 rc16) through the app itself —
// the same in-process harness as the route tests: in-memory storage, a signed-in
// person, a fixed clock — and writes them out as files for Playwright to open.
// Example data only: the screenshots made from these are committed to a public repo.

const NOW = "2026-10-24T08:00:00.000Z";
const OUT = new URL("./.pages/", import.meta.url);

const client = createClient({ url: ":memory:" });
for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
const sent: MailMessage[] = [];
const app = createApp({
  auth: {
    storage: sqliteStoragePort(client),
    mail: {
      send: (m) => {
        sent.push(m);
        return Promise.resolve();
      },
    },
    publicBaseUrl: "https://whendowe.example",
    secureCookies: false,
    now: () => NOW,
  },
});

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});

function must(value: string | null | undefined, what: string): string {
  if (value === null || value === undefined || value === "") throw new Error(`no ${what}`);
  return value;
}

/** Sign this "browser" in as one more account (DESIGN §13 rc18); returns its cookie. */
async function signIn(email: string, cookie?: string): Promise<string> {
  await app.request(SIGN_IN_PATH, post({ email }, cookie));
  const link = must(/https?:\/\/\S+/.exec(sent.at(-1)?.text ?? "")?.[0], "sign-in link");
  const token = must(new URL(link).searchParams.get("t"), "sign-in token");
  const confirmed = await app.request(CONFIRM_PATH, post({ t: token }, cookie));
  return must(confirmed.headers.get("set-cookie")?.split(";")[0], "session cookie");
}

// Three accounts on this browser, so the header's menu has someone to switch to; the
// DM, signed in last, is the one in use.
const cookie = await signIn(
  "dm@example.org",
  await signIn("lea@example.org", await signIn("dm.work@example.org")),
);
const home = await (await app.request("/", { headers: { cookie } })).text();
const csrf = must(/name="csrf" value="([^"]+)"/.exec(home)?.[1], "CSRF token");

const created = await app.request(GROUPS_PATH, post({ csrf, name: "Thursday Table" }, cookie));
const group = must(created.headers.get("location"), "group location");
const evening = await app.request(
  `${group}/events`,
  post(
    {
      csrf,
      title: "Session 14",
      location: "Martin's place",
      start: "2026-10-30T19:00",
      end: "2026-10-30T22:00",
      tzid: "Europe/Prague",
    },
    cookie,
  ),
);
const event = must(evening.headers.get("location"), "event location");

const pages: Record<string, string> = {
  home: "/",
  "event-new": `${group}/events/new`,
  "event-edit": `${event}/edit`,
  "poll-new": `${group}/polls/new`,
};
mkdirSync(OUT, { recursive: true });
for (const [name, path] of Object.entries(pages)) {
  const res = await app.request(path, { headers: { cookie } });
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
  writeFileSync(new URL(`${name}.html`, OUT), await res.text());
}
console.log(`rendered ${Object.keys(pages).length} pages`);
