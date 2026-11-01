// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { OPT_OUT_PATH } from "../../src/privacy/suppression.js";
import { createApp } from "../../src/web/app.js";
import { ACCOUNT_PATH } from "../../src/web/layout.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import { loadMigrationSql } from "../conftest.js";

// The opt-out link end to end (DESIGN §10 rc24): every email someone else caused carries
// it; its page renders on GET and acts on POST; the scope comes from the link; sign-in
// links are never stopped.

async function harness() {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
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
      publicBaseUrl: "https://whendowe.example",
      secureCookies: false,
      now: () => new Date().toISOString(),
    },
  });
  return { app, sent, storage };
}
type H = Awaited<ReturnType<typeof harness>>;

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});

async function signIn(h: H, email: string, handle: string) {
  await h.app.request(SIGN_IN_PATH, post({ email }));
  const t =
    new URL(/https?:\/\/\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "").searchParams.get("t") ??
    "";
  const res = await h.app.request(CONFIRM_PATH, post({ t }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "";
  await h.app.request(ACCOUNT_PATH, post({ csrf, handle }, cookie));
  return { cookie, csrf };
}

/** dm's group, and an invite to `email`; returns the group path. */
async function invited(h: H, email: string) {
  const dm = await signIn(h, "dm@example.org", "dm");
  const res = await h.app.request(
    GROUPS_PATH,
    post({ csrf: dm.csrf, name: "Thursday Table" }, dm.cookie),
  );
  const group = res.headers.get("location") ?? "";
  const invite = () =>
    h.app.request(
      `${group}/invites`,
      post({ csrf: dm.csrf, email, editTier: "view", visibility: "FULL" }, dm.cookie),
    );
  await invite();
  return { dm, group, invite };
}

const optOutToken = (m: MailMessage | undefined) =>
  new URL(
    /https:\/\/\S+\/opt-out\?t=\S+/.exec(m?.text ?? "")?.[0] ?? "https://x/",
  ).searchParams.get("t") ?? "";

const suppressions = async (h: H) =>
  (await h.storage.query({ sql: "SELECT scope FROM mail_suppression", params: [] })).length;

it("an invite says who and why, and its link offers that person, that group, or everyone", async () => {
  const h = await harness();
  await invited(h, "ana@example.org");
  const mail = h.sent.at(-1);
  expect(mail?.text).toContain(
    'You got this because dm invited this address to the group "Thursday Table".',
  );
  const t = optOutToken(mail);
  for (let i = 0; i < 2; i += 1) {
    const res = await h.app.request(`${OPT_OUT_PATH}?t=${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await res.text();
    expect(page).toContain("Stop emails from dm");
    expect(page).toContain("Stop emails through “Thursday Table”");
    expect(page).toContain("Stop emails from anyone on WhenDoWe");
    expect(page).toContain("Delete everything about this address");
  }
  // GET never mutates.
  expect(await suppressions(h)).toBe(0);
});

it("stopping a group's mail drops its next invite; a sign-in link still arrives, with no opt-out", async () => {
  const h = await harness();
  const { invite } = await invited(h, "ana@example.org");
  const t = optOutToken(h.sent.at(-1));
  const res = await h.app.request(OPT_OUT_PATH, post({ t, do: "group" }));
  expect(res.status).toBe(200);
  const before = h.sent.length;
  await invite();
  expect(h.sent.length).toBe(before);
  await h.app.request(OPT_OUT_PATH, post({ t, do: "all" }));
  await h.app.request(SIGN_IN_PATH, post({ email: "ana@example.org" }));
  const signIn = h.sent.at(-1);
  expect(signIn?.to).toBe("ana@example.org");
  expect(signIn?.subject).toBe("Your WhenDoWe sign-in link");
  expect(signIn?.text).not.toContain(OPT_OUT_PATH);
});

it("delete everything erases an address that never signed in, at once", async () => {
  const h = await harness();
  await invited(h, "ana@example.org");
  const t = optOutToken(h.sent.at(-1));
  const res = await h.app.request(OPT_OUT_PATH, post({ t, do: "delete" }));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Everything about this address is deleted");
  const left = await h.storage.query({
    sql: "SELECT 1 FROM group_invite WHERE email = ? UNION ALL SELECT 1 FROM opt_out_token WHERE email = ?",
    params: ["ana@example.org", "ana@example.org"],
  });
  expect(left).toHaveLength(0);
  // The link is spent, and says so.
  expect((await h.app.request(`${OPT_OUT_PATH}?t=${t}`)).status).toBe(400);
});

it("an address with an account is told to sign in to delete it, and the POST refuses", async () => {
  const h = await harness();
  await signIn(h, "kim@example.org", "kim");
  await invited(h, "kim@example.org");
  const t = optOutToken(h.sent.at(-1));
  const page = await (await h.app.request(`${OPT_OUT_PATH}?t=${t}`)).text();
  expect(page).not.toContain("Delete everything about this address");
  expect(page).toContain("This address has an account");
  const res = await h.app.request(OPT_OUT_PATH, post({ t, do: "delete" }));
  expect(res.status).toBe(409);
  expect(await suppressions(h)).toBe(0);
});

it("an unknown link, or an action the link doesn't carry, does nothing", async () => {
  const h = await harness();
  await invited(h, "ana@example.org");
  expect((await h.app.request(`${OPT_OUT_PATH}?t=nope`)).status).toBe(400);
  expect((await h.app.request(OPT_OUT_PATH)).status).toBe(400);
  expect((await h.app.request(OPT_OUT_PATH, post({ t: "nope", do: "all" }))).status).toBe(400);
  const t = optOutToken(h.sent.at(-1));
  expect((await h.app.request(OPT_OUT_PATH, post({ t, do: "everything" }))).status).toBe(400);
  expect(await suppressions(h)).toBe(0);
});

it("stopping one person's mail stops it through every group, and nobody else's", async () => {
  const h = await harness();
  const { dm } = await invited(h, "ana@example.org");
  const t = optOutToken(h.sent.at(-1));
  expect((await h.app.request(OPT_OUT_PATH, post({ t, do: "person" }))).status).toBe(200);
  const groupBy = async (who: { cookie: string; csrf: string }, name: string) => {
    const res = await h.app.request(GROUPS_PATH, post({ csrf: who.csrf, name }, who.cookie));
    const group = res.headers.get("location") ?? "";
    const before = h.sent.length;
    await h.app.request(
      `${group}/invites`,
      post(
        { csrf: who.csrf, email: "ana@example.org", editTier: "view", visibility: "FULL" },
        who.cookie,
      ),
    );
    return h.sent.length - before;
  };
  expect(await groupBy(dm, "Another table")).toBe(0);
  const eva = await signIn(h, "eva@example.org", "eva");
  expect(await groupBy(eva, "Eva's table")).toBe(1);
});

it("never names the sender by their account name, which could join two of their names", async () => {
  const h = await harness();
  const dm = await signIn(h, "dm@example.org", "Lena");
  // An event made by email, no group: the mail names her as the event sees her.
  const res = await h.app.request(
    "/events",
    post(
      {
        csrf: dm.csrf,
        title: "Picnic",
        start: "2101-10-20T12:00",
        end: "2101-10-20T15:00",
        tzid: "Europe/Prague",
        email_0: "ana@example.org",
        tier_0: "view",
        vis_0: "FULL",
        ask_0: "ack",
      },
      dm.cookie,
    ),
  );
  expect(res.status).toBe(303);
  const event = res.headers.get("location") ?? "";
  await h.app.request(`${event}/me`, post({ csrf: dm.csrf, handle: "Kestrel" }, dm.cookie));
  await h.app.request(`${event}/links`, post({ csrf: dm.csrf }, dm.cookie));
  const mail = h.sent.find((m) => m.to === "ana@example.org");
  expect(mail?.text).toContain("Kestrel");
  const page = await (await h.app.request(`${OPT_OUT_PATH}?t=${optOutToken(mail)}`)).text();
  expect(page).toContain("Stop emails from the person who sent this");
  expect(page).not.toContain("Lena");
});

// --- where addresses are added (R5b) --------------------------------------------------

const PICNIC = {
  title: "Picnic",
  start: "2101-10-20T12:00",
  end: "2101-10-20T15:00",
  tzid: "Europe/Prague",
};

it("an opted-out address can't be added anywhere, and nothing is created for it", async () => {
  const h = await harness();
  const { dm, invite } = await invited(h, "ana@example.org");
  const t = optOutToken(h.sent.at(-1));
  await h.app.request(OPT_OUT_PATH, post({ t, do: "person" }));

  const again = await invite();
  expect(again.status).toBe(422);
  expect(await again.text()).toMatch(/Couldn(&#39;|')t add ana@example\.org\./);

  const events = async () =>
    (await h.storage.query({ sql: "SELECT id FROM canonical_event", params: [] })).length;
  const before = await events();
  const made = await h.app.request(
    "/events",
    post(
      { csrf: dm.csrf, ...PICNIC, email_0: "Ana@Example.org", tier_0: "view", vis_0: "FULL" },
      dm.cookie,
    ),
  );
  expect(made.status).toBe(400);
  expect(await made.text()).toMatch(/Couldn(&#39;|')t add ana@example\.org\./);
  expect(await events()).toBe(before);

  const plan = await h.app.request(
    PLANS_PATH,
    post(
      { csrf: dm.csrf, name: "Summer", tzid: "Europe/Prague", email: "ana@example.org" },
      dm.cookie,
    ),
  );
  expect(plan.status).toBe(400);
  expect(await plan.text()).toMatch(/Couldn(&#39;|')t add ana@example\.org\./);

  // Added to an existing event, one at a time.
  const own = await h.app.request("/events", post({ csrf: dm.csrf, ...PICNIC }, dm.cookie));
  const event = own.headers.get("location") ?? "";
  const add = await h.app.request(
    `${event}/people`,
    post(
      { csrf: dm.csrf, email: "ana@example.org", editTier: "view", visibility: "FULL" },
      dm.cookie,
    ),
  );
  expect(add.status).toBe(422);
  const taking = await h.storage.query({
    sql: `SELECT 1 FROM event_participation ep JOIN person p ON p.id = ep.person_id
          WHERE p.email = 'ana@example.org'`,
    params: [],
  });
  expect(taking).toHaveLength(0);

  // Someone else still can: the opt-out was from dm.
  const eva = await signIn(h, "eva@example.org", "eva");
  const evas = await h.app.request(
    "/events",
    post(
      { csrf: eva.csrf, ...PICNIC, email_0: "ana@example.org", tier_0: "view", vis_0: "FULL" },
      eva.cookie,
    ),
  );
  expect(evas.status).toBe(303);
});

it("your account lists what you stopped, and you can undo it", async () => {
  const h = await harness();
  const { invite } = await invited(h, "ana@example.org");
  const t = optOutToken(h.sent.at(-1));
  await h.app.request(OPT_OUT_PATH, post({ t, do: "group" }));
  expect((await invite()).status).toBe(422);
  // Signing in is never stopped.
  const ana = await signIn(h, "ana@example.org", "ana");
  const page = await (
    await h.app.request(ACCOUNT_PATH, { headers: { cookie: ana.cookie } })
  ).text();
  expect(page).toContain("Email through “Thursday Table”");
  const scopeId = /name="scope_id" value="([^"]*)"/.exec(page)?.[1] ?? "";
  // Only your own: a forged form can't undo someone else's, it has no address to name.
  const forged = await h.app.request(
    "/account/email-again",
    post({ csrf: "nope", scope: "group", scope_id: scopeId }, ana.cookie),
  );
  expect(forged.status).toBe(403);
  const undo = await h.app.request(
    "/account/email-again",
    post({ csrf: ana.csrf, scope: "group", scope_id: scopeId }, ana.cookie),
  );
  expect(undo.status).toBe(303);
  expect(
    await (await h.app.request(ACCOUNT_PATH, { headers: { cookie: ana.cookie } })).text(),
  ).not.toContain("Email you stopped");
  expect((await invite()).status).toBe(200);
});

it("deleting your account can also stop anyone emailing the address", async () => {
  for (const checked of [true, false]) {
    const h = await harness();
    const kim = await signIn(h, "kim@example.org", "kim");
    const ask = await h.app.request(
      "/account/delete",
      post(
        { csrf: kim.csrf, confirm: "kim@example.org", ...(checked ? { suppress: "1" } : {}) },
        kim.cookie,
      ),
    );
    expect(ask.status).toBe(200);
    const link = new URL(
      /https:\/\/\S+\/account\/deletion\?t=\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ??
        "https://x/",
    );
    await h.app.request(
      "/account/deletion",
      post({ t: link.searchParams.get("t") ?? "", do: "now" }),
    );
    const { invite } = await invited(h, "kim@example.org");
    expect((await invite()).status).toBe(checked ? 422 : 200);
  }
});
