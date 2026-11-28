// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { z } from "zod";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { createSession, listSessions, revokeSession } from "../../src/people/session.js";
import { deviceSignInLink, shellSignInLink } from "../../src/people/setup.js";
import { createApp } from "../../src/web/app.js";
import { ACCOUNT_PATH } from "../../src/web/layout.js";
import { DEVICE_SIGN_IN_PATH } from "../../src/web/routes/account.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { loadMigrationSql } from "../conftest.js";

// Sign in on another device (DESIGN §10 rc60 *Running without email*, way in 3): the account
// page makes a sign-in link for the account it is pressed in, shown once, used once, in 15
// minutes, recorded as `device`; and the page lists where the account is signed in, and how.

async function harness(noMail = true) {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const sent: MailMessage[] = [];
  let clock = Date.parse("2101-03-01T10:00:00.000Z");
  const now = () => new Date(clock).toISOString();
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
      noMail,
    },
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { app, storage, sent, now, advance };
}

type H = Awaited<ReturnType<typeof harness>>;

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";

/** Signed in from the shell, as an instance with no mail signs someone in first. */
async function signIn(h: H, email: string) {
  await findOrCreatePerson(h.storage, email, { now: h.now() });
  const link = await shellSignInLink(h.storage, email, { now: h.now() });
  if (!link.ok) throw new Error(link.reason);
  const cookie = cookieOf(await h.app.request(CONFIRM_PATH, post({ t: link.token })));
  const account = await (await h.app.request(ACCOUNT_PATH, { headers: { cookie } })).text();
  return { cookie, csrf: csrfOf(account), account };
}

/** The link the device page shows, as a path to request. */
function linkOn(page: string): string {
  const url = /(https:\/\/whendowe\.example\/auth\/confirm\?t=[A-Za-z0-9_-]+)<\/textarea>/.exec(
    page,
  )?.[1];
  if (url === undefined) throw new Error("no sign-in link on the page");
  const u = new URL(url);
  return u.pathname + u.search;
}

it("the account page offers Sign in on another device and lists where you're signed in", async () => {
  const h = await harness();
  const me = await signIn(h, "ann@example.org");
  expect(me.account).toContain("<h2>Sign in on another device</h2>");
  expect(me.account).toContain(
    `<form method="post" action="${DEVICE_SIGN_IN_PATH}">\n  <input type="hidden" name="csrf" value="${me.csrf}" />\n  <p><button type="submit">Make a sign-in link</button></p>`,
  );
  expect(me.account).toContain("It works once, for 15 minutes.");
  expect(me.account).toContain(
    "<h2>Where you're signed in</h2>\n<ul><li>Since 2101-03-01 10:00 UTC, by a sign-in link from whoever runs this instance <strong>· this browser</strong></li></ul>",
  );
});

it("its link is shown once, signs this account in elsewhere, once, and is recorded as a device", async () => {
  const h = await harness();
  const me = await signIn(h, "ann@example.org");
  const res = await h.app.request(DEVICE_SIGN_IN_PATH, post({ csrf: me.csrf }, me.cookie));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  const page = await res.text();
  expect(page).toContain("<title>Sign in on another device · WhenDoWe</title>");
  expect(page).toContain(
    "<strong>Anyone with this link can sign in as you until it's used.</strong>",
  );
  expect(page).toContain("It works once, for the next 15 minutes");
  expect(page).toContain('aria-label="Your sign-in link"');
  expect(page).toContain("data-share");
  expect(page).toContain(`<p><a href="${ACCOUNT_PATH}">Back</a></p>`);
  const link = linkOn(page);

  // The other device: no cookie. GET only asks; POST signs in.
  const asked = await (await h.app.request(link)).text();
  expect(asked).toContain("Sign in as ann@example.org?");
  const t = new URL(link, "https://x").searchParams.get("t") ?? "";
  const used = await h.app.request(CONFIRM_PATH, post({ t }));
  expect(used.status).toBe(303);
  const phone = cookieOf(used);
  const there = await (await h.app.request(ACCOUNT_PATH, { headers: { cookie: phone } })).text();
  expect(there).toContain(
    "<li>Since 2101-03-01 10:00 UTC, by Sign in on another device <strong>· this browser</strong></li>",
  );
  expect(there).toContain(
    "<li>Since 2101-03-01 10:00 UTC, by a sign-in link from whoever runs this instance</li>",
  );
  // Once only.
  expect((await h.app.request(CONFIRM_PATH, post({ t }))).status).toBe(400);
  expect(h.sent).toEqual([]);
});

it("making another stops the first; after 15 minutes neither works", async () => {
  const h = await harness();
  const me = await signIn(h, "ann@example.org");
  const make = async () =>
    linkOn(
      await (await h.app.request(DEVICE_SIGN_IN_PATH, post({ csrf: me.csrf }, me.cookie))).text(),
    );
  const first = await make();
  const second = await make();
  expect(second).not.toBe(first);
  expect((await h.app.request(first)).status).toBe(400);
  expect((await h.app.request(second)).status).toBe(200);
  h.advance(15 * 60 * 1000);
  expect((await h.app.request(second)).status).toBe(400);
});

it("needs a session and its CSRF token; it is there with mail on too", async () => {
  const h = await harness(false);
  const me = await signIn(h, "ann@example.org");
  expect(me.account).toContain("<h2>Sign in on another device</h2>");
  const signedOut = await h.app.request(DEVICE_SIGN_IN_PATH, post({ csrf: me.csrf }));
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.get("location")).toContain(SIGN_IN_PATH);
  const forged = await h.app.request(DEVICE_SIGN_IN_PATH, post({ csrf: "nope" }, me.cookie));
  expect(forged.status).toBe(403);
  expect(
    await h.storage.query({ sql: "SELECT id FROM login_token WHERE via = 'device'", params: [] }),
  ).toEqual([]);
  // Mail on: a device link is still copied, never emailed.
  expect(
    (await h.app.request(DEVICE_SIGN_IN_PATH, post({ csrf: me.csrf }, me.cookie))).status,
  ).toBe(200);
  expect(h.sent).toEqual([]);
});

it("the sign-in page without mail names Sign in on another device among the ways in", async () => {
  const h = await harness();
  const page = await (await h.app.request(SIGN_IN_PATH)).text();
  expect(page).toContain(
    "<li><strong>Invited to a group?</strong> Ask whoever invited you for a new invite link.</li>\n  <li><strong>Signed in on another device?</strong> Open your account page there and use <em>Sign in on another device</em>.</li>\n  <li><strong>Otherwise</strong>",
  );
});

it("a device link is only for an account that is still there", async () => {
  const h = await harness();
  const ann = await findOrCreatePerson(h.storage, "ann@example.org", { now: h.now() });
  expect((await deviceSignInLink(h.storage, ann.id, { now: h.now() })).ok).toBe(true);
  expect(await deviceSignInLink(h.storage, "nobody", { now: h.now() })).toEqual({
    ok: false,
    reason: "no_account",
  });
  await h.storage.query({
    sql: "UPDATE person SET erased_at = ? WHERE id = ?",
    params: [h.now(), ann.id],
  });
  expect((await deviceSignInLink(h.storage, ann.id, { now: h.now() })).ok).toBe(false);
});

it("listSessions: newest first, without revoked or expired ones, and an unrecorded how as null", async () => {
  const h = await harness();
  const ann = await findOrCreatePerson(h.storage, "ann@example.org", { now: h.now() });
  const bo = await findOrCreatePerson(h.storage, "bo@example.org", { now: h.now() });
  const old = await createSession(h.storage, ann.id, { now: h.now(), via: "google" });
  h.advance(60_000);
  const gone = await createSession(h.storage, ann.id, { now: h.now(), via: "magic" });
  await revokeSession(h.storage, gone.token, h.now());
  h.advance(60_000);
  const fresh = await createSession(h.storage, ann.id, { now: h.now(), via: "device" });
  await createSession(h.storage, bo.id, { now: h.now(), via: "invite" });
  await h.storage.query({
    sql: "UPDATE session SET via = NULL WHERE id = ?",
    params: [old.sessionId],
  });
  expect(await listSessions(h.storage, ann.id, h.now())).toEqual([
    { id: fresh.sessionId, createdAt: "2101-03-01T10:02:00.000Z", via: "device" },
    { id: old.sessionId, createdAt: "2101-03-01T10:00:00.000Z", via: null },
  ]);
  // Expired: not listed.
  const { expires_at: expiresAt } = z.object({ expires_at: z.string() }).parse(
    (
      await h.storage.query({
        sql: "SELECT expires_at FROM session WHERE id = ?",
        params: [fresh.sessionId],
      })
    )[0],
  );
  expect(await listSessions(h.storage, ann.id, expiresAt)).toEqual([]);
});

it("a session from before how was recorded says so; an account gone meanwhile gets no link", async () => {
  const h = await harness();
  const me = await signIn(h, "ann@example.org");
  await h.storage.query({ sql: "UPDATE session SET via = NULL", params: [] });
  expect(
    await (await h.app.request(ACCOUNT_PATH, { headers: { cookie: me.cookie } })).text(),
  ).toContain(
    "<li>Since 2101-03-01 10:00 UTC, how isn&#39;t recorded <strong>· this browser</strong></li>",
  );
  await h.storage.query({
    sql: "UPDATE person SET erased_at = ? WHERE email = ?",
    params: [h.now(), "ann@example.org"],
  });
  const res = await h.app.request(DEVICE_SIGN_IN_PATH, post({ csrf: me.csrf }, me.cookie));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(ACCOUNT_PATH);
  expect(
    await h.storage.query({ sql: "SELECT id FROM login_token WHERE via = 'device'", params: [] }),
  ).toEqual([]);
});
