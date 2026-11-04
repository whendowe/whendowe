// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { createTokenCipher } from "../../src/crypto/tokens.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { createApp } from "../../src/web/app.js";
import { ACCOUNT_PATH } from "../../src/web/layout.js";
import { CONFIRM_PATH, SIGN_IN_PATH, SWITCH_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
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
  const signedIn = must(confirmed.headers.get("set-cookie")?.split(";")[0], "session cookie");
  // Everyone chooses the name others see (DESIGN §10 rc21): here, the part before @.
  const page = await (await app.request("/", { headers: { cookie: signedIn } })).text();
  const token2 = must(/name="csrf" value="([^"]+)"/.exec(page)?.[1], "CSRF token");
  await app.request(
    ACCOUNT_PATH,
    post({ csrf: token2, handle: email.split("@")[0] ?? "" }, signedIn),
  );
  return signedIn;
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

// Plans (DESIGN §10 rc19): a game table of three, where the DM decides, with Lea's
// answer to the DM's plan on the table; and a pair planning week-long stretches.
const asPost = (fields: Record<string, string | string[]>, c: string): RequestInit => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: c },
    body: body.toString(),
  };
};
const csrfOf = async (c: string) =>
  must(
    /name="csrf" value="([^"]+)"/.exec(
      await (await app.request("/", { headers: { cookie: c } })).text(),
    )?.[1],
    "CSRF token",
  );
async function startThread(c: string, name: string, emails: string[]): Promise<string> {
  const res = await app.request(
    PLANS_PATH,
    asPost({ csrf: await csrfOf(c), name, tzid: "Europe/Prague", email: emails }, c),
  );
  return must(res.headers.get("location"), "thread location");
}
async function draw(
  c: string,
  thread: string,
  events: Record<string, string | string[]>[],
  from?: string,
): Promise<void> {
  const token = await csrfOf(c);
  await app.request(
    `${thread}/drafts`,
    asPost({ csrf: token, ...(from === undefined ? {} : { from }) }, c),
  );
  for (const e of events)
    await app.request(`${thread}/draft/events`, asPost({ csrf: token, ...e }, c));
}
async function send(c: string, thread: string, name: string, message: string): Promise<string> {
  const res = await app.request(
    `${thread}/draft/details`,
    asPost({ csrf: await csrfOf(c), name, message, after: "send" }, c),
  );
  return must(res.headers.get("location"), "plan location").replace("?sent=1", "");
}
const session = (title: string, day: string, start = "19:00", length = "240") => ({
  title,
  kind: "time",
  day,
  start,
  length,
});
// Cat signs in once, in a browser of her own, so she has a name: a guest's name comes from
// random ids, and a screenshot must not (guests are covered by the route tests).
await signIn("cat@example.org");
const table = await startThread(cookie, "Thursday Table", ["lea@example.org", "cat@example.org"]);
await draw(cookie, table, [
  session("Session 15", "2026-11-05"),
  session("Session 16", "2026-11-19"),
  session("Session 17", "2026-12-03"),
]);
const planA = await send(cookie, table, "Every other Thursday", "Same as before, to Christmas.");

const leaCookie = await (async () => {
  const h = await (await app.request("/", { headers: { cookie } })).text();
  const lea = must(
    /name="session" value="([^"]+)" \/>\s*<input type="hidden" name="back"[^>]*>\s*<button type="submit">Switch to <strong>lea@/.exec(
      h,
    )?.[1],
    "Lea's session",
  );
  const sw = await app.request(
    SWITCH_PATH,
    post(
      { csrf: must(/name="csrf" value="([^"]+)"/.exec(h)?.[1], "csrf"), session: lea, back: "/" },
      cookie,
    ),
  );
  return must(sw.headers.get("set-cookie")?.split(";")[0], "Lea's cookie");
})();
// Lea answers: the 19th moves a week, and a Saturday session is new.
await app.request(
  `${table}/drafts`,
  asPost(
    { csrf: await csrfOf(leaCookie), from: must(planA.split("/p/")[1], "plan id") },
    leaCookie,
  ),
);
const leaDraft = await (
  await app.request(`${table}/draft`, { headers: { cookie: leaCookie } })
).text();
const moved = must(
  /draft\?e=([0-9a-f-]+)#w-[^"]*" data-sid="[^"]+" data-kind="plan"[^>]*aria-label="Thu 19 Nov/.exec(
    leaDraft,
  )?.[1],
  "the 19th",
);
await app.request(
  `${table}/draft/events/${moved}`,
  asPost({ csrf: await csrfOf(leaCookie), ...session("Session 16", "2026-11-26") }, leaCookie),
);
await app.request(
  `${table}/draft/events`,
  asPost(
    { csrf: await csrfOf(leaCookie), ...session("Session 18", "2026-12-12", "15:00", "360") },
    leaCookie,
  ),
);
const planB = await send(leaCookie, table, "", "I'm away on the 19th.");

const kid = await startThread(cookie, "Kiddo's weeks", ["lea@example.org"]);
await app.request(`${kid}/drafts`, asPost({ csrf: await csrfOf(cookie) }, cookie));
const ids = [
  ...(
    await (
      await app.request(`${kid}/draft?add=2026-11-02&kind=days`, { headers: { cookie } })
    ).text()
  ).matchAll(/name="who" value="([^"]+)" \/> ([^<]+)<\/label>/g),
];
const who = (n: string) => must(ids.find((m) => m[2] === n)?.[1], `${n}'s id`);
const week = (title: string, from: string, to: string, w: string) => ({
  title,
  kind: "days",
  from,
  to,
  who: w,
});
for (const e of [
  week("With dm", "2026-11-02", "2026-11-08", who("dm")),
  week("With lea", "2026-11-09", "2026-11-15", who("lea")),
  week("Scout trip: dm on standby", "2026-11-14", "2026-11-17", who("dm")),
  week("With dm", "2026-11-16", "2026-11-22", who("dm")),
])
  await app.request(`${kid}/draft/events`, asPost({ csrf: await csrfOf(cookie), ...e }, cookie));
const kidDraft = await (await app.request(`${kid}/draft`, { headers: { cookie } })).text();
const stretch = must(
  /draft\?e=([0-9a-f-]+)#w-[^"]*" data-sid="[^"]+" data-kind="plan"[^>]*aria-label="Mon 9 Nov/.exec(
    kidDraft,
  )?.[1],
  "Lea's week",
);

const pages: Record<string, string> = {
  home: "/",
  "plan-thread": table,
  "plan-answer": planB,
  "plan-draft": `${kid}/draft`,
  "plan-draft-editing": `${kid}/draft?e=${stretch}`,
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

// The table's shared link (DESIGN §10 rc25), opened on a phone with no account: after
// the pages above, so the thread page is drawn before it was shared.
const shared = await (
  await app.request(`${table}/share`, asPost({ csrf: await csrfOf(cookie) }, cookie))
).text();
const shareUrl = new URL(
  must(
    /you\? (https:\/\/whendowe\.example\/s\?t=[^\s<]+)<\/textarea>/.exec(shared)?.[1],
    "shared link",
  ),
);
// The page that made the link: the message to paste, with Share… and Copy (rc25).
writeFileSync(new URL("plan-thread-shared.html", OUT), shared);
const guestPage = await app.request(`${shareUrl.pathname}${shareUrl.search}`);
if (guestPage.status !== 200) throw new Error(`the shared link answered ${guestPage.status}`);
const guestHtml = await guestPage.text();
writeFileSync(new URL("share-guest.html", OUT), guestHtml);

// Kestrel claims a name there and votes (rc30): the one page that shows the claim link,
// with Confirm with email below.
const firstPlan = must(/name="(plan_[^"]+)"/.exec(guestHtml)?.[1], "a plan to vote on");
const claimed = await app.request(
  shareUrl.pathname,
  asPost({ t: shareUrl.searchParams.get("t") ?? "", name: "Kestrel", [firstPlan]: "yes" }, ""),
);
if (claimed.status !== 200) throw new Error(`claiming a name answered ${claimed.status}`);
writeFileSync(new URL("share-claimed.html", OUT), await claimed.text());

// The same phone, later signed in as an account (rc30): the page offers to move Kestrel's
// answers to it.
const claims = must(claimed.headers.get("set-cookie")?.split(";")[0], "claim cookie");
const kestrelAccount = await signIn("kestrel@example.org");
const over = await app.request(`${shareUrl.pathname}${shareUrl.search}`, {
  headers: { cookie: `${kestrelAccount}; ${claims}` },
});
if (over.status !== 200) throw new Error(`the shared link, signed in, answered ${over.status}`);
writeFileSync(new URL("share-over-claim.html", OUT), await over.text());

// A poll of one time, shared (rc33): "who's in?" is answered in one tap.
const pizza = await app.request(
  "/polls",
  asPost(
    {
      csrf: await csrfOf(cookie),
      title: "Pizza at Ann's",
      tzid: "Europe/Prague",
      start_0: "2026-11-05T19:00",
      end_0: "2026-11-05T22:00",
    },
    cookie,
  ),
);
const pizzaThread = must(pizza.headers.get("location"), "pizza poll").split("#")[0] ?? "";
const pizzaShared = await (
  await app.request(`${pizzaThread}/share`, asPost({ csrf: await csrfOf(cookie) }, cookie))
).text();
const pizzaUrl = new URL(
  // The link ends the message to paste (rc25), whatever the message asks.
  must(
    / (https:\/\/whendowe\.example\/s\?t=[^\s<]+)<\/textarea>/.exec(pizzaShared)?.[1],
    "pizza link",
  ),
);
const pizzaGuest = await app.request(`${pizzaUrl.pathname}${pizzaUrl.search}`);
if (pizzaGuest.status !== 200) throw new Error(`the pizza link answered ${pizzaGuest.status}`);
writeFileSync(new URL("share-one-time.html", OUT), await pizzaGuest.text());

// Back on the DM's thread page (rc30): Kestrel is marked "not confirmed", with Remove.
const withGuest = await app.request(table, { headers: { cookie } });
if (withGuest.status !== 200) throw new Error(`${table} with a guest answered ${withGuest.status}`);
writeFileSync(new URL("plan-thread-guest.html", OUT), await withGuest.text());

// Lea is signed in here but not in the group; switched to her, the DM's event offers
// the switch back (DESIGN §13 rc18). A 404, as the page is not hers to see.
const leaSession = must(
  /name="session" value="([^"]+)" \/>\s*<input type="hidden" name="back"[^>]*>\s*<button type="submit">Switch to <strong>lea@/.exec(
    home,
  )?.[1],
  "Lea's session",
);
const switched = await app.request(
  SWITCH_PATH,
  post({ csrf, session: leaSession, back: "/" }, cookie),
);
const asLea = must(switched.headers.get("set-cookie")?.split(";")[0], "Lea's cookie");
const elsewhere = await app.request(event, { headers: { cookie: asLea } });
if (elsewhere.status !== 404) throw new Error(`${event} as Lea answered ${elsewhere.status}`);
writeFileSync(new URL("visible-elsewhere.html", OUT), await elsewhere.text());

// Signed out, on an instance with Google credentials: the sign-in page offers Google
// beside the email link (DESIGN §13 rc20). Placeholder credentials; nothing is called.
const withGoogle = createApp({
  auth: {
    storage: sqliteStoragePort(client),
    mail: { send: () => Promise.resolve() },
    publicBaseUrl: "https://whendowe.example",
    secureCookies: false,
    now: () => NOW,
  },
  oauth: {
    storage: sqliteStoragePort(client),
    cipher: await createTokenCipher([{ id: 1, material: `${"A".repeat(43)}=` }], 1),
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
    redirectUri: "https://whendowe.example/oauth/google/callback",
    now: () => NOW,
    secureCookies: false,
  },
});
const signInPage = await withGoogle.request(SIGN_IN_PATH);
if (signInPage.status !== 200) throw new Error(`sign-in answered ${signInPage.status}`);
writeFileSync(new URL("sign-in.html", OUT), await signInPage.text());
console.log(`rendered ${Object.keys(pages).length + 3} pages`);
