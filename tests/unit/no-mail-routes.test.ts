// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { shellSignInLink } from "../../src/people/setup.js";
import { createPollThread } from "../../src/plans/plan.js";
import { createApp } from "../../src/web/app.js";
import { DELETE_ACCOUNT_PATH } from "../../src/web/routes/account.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH, INVITE_PATH } from "../../src/web/routes/groups.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import { SHARE_PATH } from "../../src/web/routes/share.js";
import { loadMigrationSql } from "../conftest.js";

// An instance that sends no email (DESIGN §10 rc60 *Running without email*): no page offers to
// email anything, a group invite is a link its inviter copies, and the sign-in page lists the
// ways in. The mail port here records, so "nothing was sent" is something the test can see;
// deployed, it is the disabled port, which drops everything.

const WAYS_IN = "This instance doesn't send email, so signing in is by a link someone gives you";

/** `noMail: false` is the same instance with mail, for what must stay as it was. */
async function harness(noMail = true) {
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
      noMail,
    },
  });
  const loginTokens = async () =>
    (await storage.query({ sql: "SELECT id FROM login_token", params: [] })).length;
  return { app, storage, sent, now, loginTokens };
}

type H = Awaited<ReturnType<typeof harness>>;

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

/** Signed in the way an instance without mail signs someone in: a link from its shell. */
async function signIn(h: H, email: string): Promise<{ cookie: string; csrf: string }> {
  await findOrCreatePerson(h.storage, email, { now: h.now() });
  const link = await shellSignInLink(h.storage, email, { now: h.now() });
  if (!link.ok) throw new Error(link.reason);
  const cookie = cookieOf(await h.app.request(CONFIRM_PATH, post({ t: link.token })));
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "" };
}

it("the sign-in page lists the ways in and has no email form, and its POST makes no link", async () => {
  const h = await harness();
  const page = await (await h.app.request(SIGN_IN_PATH)).text();
  expect(page).toContain("<h1>Sign in</h1>");
  expect(page).toContain(WAYS_IN);
  expect(page).toContain("Ask whoever invited you for a new invite link");
  expect(page).toContain("ask whoever runs this instance for a sign-in link");
  expect(page).not.toContain('name="email"');
  expect(page).not.toContain("Email me a sign-in link");
  // No Google configured: nothing offers it, and nothing follows the list.
  expect(page).not.toContain("Sign in with Google");
  expect(page).toContain("for a sign-in link.</li>\n</ul>\n</body>");

  for (const email of ["someone@example.org", "not an address"]) {
    const res = await h.app.request(SIGN_IN_PATH, post({ email }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain(WAYS_IN);
    expect(text).not.toContain("Check your email");
  }
  expect(h.sent).toEqual([]);
  expect(await h.loginTokens()).toBe(0);

  expect(
    await (await h.app.request(SIGN_IN_PATH, post({ email: "x@example.org" }))).text(),
  ).toContain("<title>Sign in · WhenDoWe</title>");

  // Signed in, it adds another account the same way, the form's POST too.
  const me = await signIn(h, "ann@example.org");
  const adding = await (
    await h.app.request(SIGN_IN_PATH, { headers: { cookie: me.cookie } })
  ).text();
  expect(adding).toContain("<h1>Add another account</h1>");
  expect(adding).toContain(WAYS_IN);
  const posted = await (
    await h.app.request(SIGN_IN_PATH, post({ email: "bo@example.org" }, me.cookie))
  ).text();
  expect(posted).toContain("<h1>Add another account</h1>");
});

it("an invite is a link to copy, shown once, that joins and signs in; nothing is emailed", async () => {
  const h = await harness();
  const dm = await signIn(h, "dm@example.org");
  const made = await h.app.request(GROUPS_PATH, post({ csrf: dm.csrf, name: "Jam" }, dm.cookie));
  const group = made.headers.get("location") ?? "";
  const groupPage = await (await h.app.request(group, { headers: { cookie: dm.cookie } })).text();
  expect(groupPage).toContain("Each gets a link to join, for you to send them");
  expect(groupPage).toContain("Make invite links");
  expect(groupPage).not.toContain("Send invites");
  expect(groupPage).not.toContain("Each gets an email");

  const res = await h.app.request(
    `${group}/invites`,
    post(
      { csrf: dm.csrf, email: "Friend@Example.org", editTier: "view", visibility: "FULL" },
      dm.cookie,
    ),
  );
  expect(res.status).toBe(200);
  // The page carries a sign-in link: out of caches and Referer headers.
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  const text = await res.text();
  expect(text).toContain(
    "<p><strong>friend@example.org</strong>'s invite link. Send it only to them: it works once, for 7 days",
  );
  expect(text).not.toContain("Invite sent");
  expect(text).toContain('aria-label="friend@example.org&#39;s invite link"');
  // The form again below, still without mail.
  expect(text).toContain("Make invite links");
  // The copy buttons are wired on this page.
  expect(text).toContain('<button type="button" data-copy hidden>Copy</button>');
  expect(text).toContain('document.querySelectorAll("[data-share]")');
  const link = new URL(
    (
      /(https:\/\/whendowe\.example\/invite\?t=[^\s<]+)<\/textarea>/.exec(text)?.[1] ?? ""
    ).replaceAll("&amp;", "&"),
  );
  expect(link.pathname).toBe(INVITE_PATH);
  expect(h.sent).toEqual([]);

  // A friend opens it: it joins, and signs them in, as an emailed invite does.
  const t = link.searchParams.get("t") ?? "";
  expect(await (await h.app.request(`${INVITE_PATH}?t=${t}`)).text()).toContain("Join “Jam”?");
  const joined = await h.app.request(INVITE_PATH, post({ t }));
  expect(joined.status).toBe(303);
  expect(joined.headers.get("location")).toBe(group);
  const friend = cookieOf(joined);
  expect((await h.app.request(group, { headers: { cookie: friend } })).status).toBe(200);
  // Once only.
  expect((await h.app.request(INVITE_PATH, post({ t }))).status).toBe(400);
});

it("several invites at once each get their own link", async () => {
  const h = await harness();
  const dm = await signIn(h, "dm2@example.org");
  const group =
    (await h.app.request(GROUPS_PATH, post({ csrf: dm.csrf, name: "Jam" }, dm.cookie))).headers.get(
      "location",
    ) ?? "";
  // Pasted at once, they are two chips (rc48).
  const res = await h.app.request(
    `${group}/invites`,
    post(
      {
        csrf: dm.csrf,
        email: "a@example.org, b@example.org",
        editTier: "view",
        visibility: "FULL",
      },
      dm.cookie,
    ),
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("<li><strong>a@example.org</strong>'s invite link.");
  expect(text).toContain("<li><strong>b@example.org</strong>'s invite link.");
  expect(text.match(/\/invite\?t=/g)).toHaveLength(2);
  expect(h.sent).toEqual([]);
});

it("a shared link's guest is not offered Confirm with email, and its POST makes no link", async () => {
  const h = await harness();
  const mara = await signIn(h, "mara@example.org");
  const maraId = (await findOrCreatePerson(h.storage, "mara@example.org", { now: h.now() })).id;
  const { threadId, planIds } = await createPollThread(h.storage, {
    creatorId: maraId,
    group: null,
    fields: { title: "Picnic", description: null, location: null, allDay: true, tzid: null },
    candidates: [{ startLocal: "2101-11-21", endLocal: "2101-11-22" }],
    people: [],
    now: h.now(),
  });
  const shared = await (
    await h.app.request(`${PLANS_PATH}/${threadId}/share`, post({ csrf: mara.csrf }, mara.cookie))
  ).text();
  const url = new URL(
    (/(https:\/\/whendowe\.example\/s\?t=[^\s<]+)<\/textarea>/.exec(shared)?.[1] ?? "").replaceAll(
      "&amp;",
      "&",
    ),
  );
  const t = url.searchParams.get("t") ?? "";
  const voted = await h.app.request(
    SHARE_PATH,
    post({ t, name: "Kestrel", [`plan_${planIds[0]}`]: "yes" }),
  );
  const guest = cookieOf(voted);
  expect(guest).not.toBe("");
  const page = await (
    await h.app.request(`${SHARE_PATH}?t=${encodeURIComponent(t)}`, { headers: { cookie: guest } })
  ).text();
  expect(page).toContain("Kestrel");
  expect(page).not.toContain("Confirm with email");

  const tokens = await h.loginTokens(); // Mara's own, from the shell
  const res = await h.app.request(
    `${SHARE_PATH}/confirm`,
    post({ t, email: "kestrel@example.org" }, guest),
  );
  expect(res.status).toBe(400);
  expect(await res.text()).toContain(WAYS_IN);
  expect(h.sent).toEqual([]);
  expect(await h.loginTokens()).toBe(tokens);
});

it("deleting an account says to sign in again to keep it, and emails nothing", async () => {
  const h = await harness();
  const me = await signIn(h, "leaving@example.org");
  const ask = await (
    await h.app.request(DELETE_ACCOUNT_PATH, { headers: { cookie: me.cookie } })
  ).text();
  expect(ask).toContain("and to keep the account you sign in again before then");
  expect(ask).not.toContain("we email you a link");
  const res = await h.app.request(
    DELETE_ACCOUNT_PATH,
    post({ csrf: me.csrf, confirm: "leaving@example.org" }, me.cookie),
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("Your account will be deleted on");
  expect(text).toContain(
    "To keep it, sign in again before then. This instance doesn't send email, so ask whoever runs it for a sign-in link.",
  );
  expect(text).not.toContain("We've emailed");
  expect(text).not.toContain("couldn't email");
  expect(h.sent).toEqual([]);
});

it("with mail, the same pages email as before: no links to copy, nothing said about no email", async () => {
  const h = await harness(false);
  const sign = await (await h.app.request(SIGN_IN_PATH)).text();
  expect(sign).toContain("Email me a sign-in link");
  expect(sign).not.toContain(WAYS_IN);

  const dm = await signIn(h, "dm3@example.org");
  const group =
    (await h.app.request(GROUPS_PATH, post({ csrf: dm.csrf, name: "Jam" }, dm.cookie))).headers.get(
      "location",
    ) ?? "";
  const groupPage = await (await h.app.request(group, { headers: { cookie: dm.cookie } })).text();
  expect(groupPage).toContain(
    "Each gets an email with a link to join. What they can change and see is their default on this group&#39;s events.",
  );
  expect(groupPage).toContain('<p><button type="submit">Send invites</button></p>');
  expect(groupPage).not.toContain("Make invite links");

  const one = await h.app.request(
    `${group}/invites`,
    post(
      { csrf: dm.csrf, email: "pal@example.org", editTier: "view", visibility: "FULL" },
      dm.cookie,
    ),
  );
  expect(one.status).toBe(200);
  expect(one.headers.get("cache-control")).toBeNull();
  const oneText = await one.text();
  expect(oneText).toContain("<p>Invite sent to <strong>pal@example.org</strong>.</p>\n<form");
  expect(oneText).toContain("Each gets an email with a link to join.");
  expect(oneText).toContain('<p><button type="submit">Send invites</button></p>');
  expect(oneText).not.toContain("data-share");
  const two = await (
    await h.app.request(
      `${group}/invites`,
      post(
        {
          csrf: dm.csrf,
          email: "c@example.org, d@example.org",
          editTier: "view",
          visibility: "FULL",
        },
        dm.cookie,
      ),
    )
  ).text();
  expect(two).toContain(
    "<ul><li>Invite sent to <strong>c@example.org</strong>.</li><li>Invite sent to <strong>d@example.org</strong>.</li></ul>",
  );
  expect(h.sent.map((m) => m.to)).toEqual(["pal@example.org", "c@example.org", "d@example.org"]);

  const ask = await (
    await h.app.request(DELETE_ACCOUNT_PATH, { headers: { cookie: dm.cookie } })
  ).text();
  expect(ask).toContain("and we email you a link to keep the account, or to delete it at once.");
});
