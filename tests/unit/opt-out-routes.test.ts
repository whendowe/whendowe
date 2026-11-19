// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { createEvent } from "../../src/events/event.js";
import type { MailMessage } from "../../src/mail/port.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import {
  mailTrailOf,
  OPT_OUT_PATH,
  suppress,
  suppressingMailPort,
} from "../../src/privacy/suppression.js";
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
        pc_0: "e:ana@example.org",
        pt_0: "view",
        pv_0: "FULL",
        pa_0: "ack",
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
      { csrf: dm.csrf, ...PICNIC, pc_0: "e:Ana@Example.org", pt_0: "view", pv_0: "FULL" },
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
      { csrf: eva.csrf, ...PICNIC, pc_0: "e:ana@example.org", pt_0: "view", pv_0: "FULL" },
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

const NOW = "2101-11-01T10:00:00.000Z";

const FIELDS = {
  title: "Handover",
  description: null,
  location: null,
  allDay: false,
  startLocal: "2101-12-20T10:00",
  endLocal: "2101-12-20T11:00",
  tzid: "Europe/Prague",
};

/** Text as a person reads it: the page escapes what it writes in (§13). */
const asRead = (t: string) =>
  t
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The opt-out page as a person uses it: read its buttons, press one by its label. */
function optOutPage(h: H, token: string) {
  const read = async () =>
    (await h.app.request(`${OPT_OUT_PATH}?t=${encodeURIComponent(token)}`)).text();
  const buttons = (p: string) =>
    [...p.matchAll(/<form method="post" action="\/opt-out">([\s\S]*?)<\/form>/g)].map((m) =>
      asRead((/<button type="submit">([^<]*)<\/button>/.exec(m[1] ?? "")?.[1] ?? "").trim()),
    );
  const press = async (label: string) => {
    const p = await read();
    const form = [...p.matchAll(/<form method="post" action="\/opt-out">([\s\S]*?)<\/form>/g)]
      .map((m) => m[1] ?? "")
      .find((f) => asRead(f).includes(`>${label}</button>`));
    if (form === undefined) throw new Error(`no button "${label}"`);
    const fields = Object.fromEntries(
      [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)].map((m) => [
        m[1] ?? "",
        m[2] ?? "",
      ]),
    );
    const res = await h.app.request(OPT_OUT_PATH, post(fields));
    expect(res.status).toBe(200);
    return asRead(/<p>([^<]*)<\/p>/.exec(await res.text())?.[1] ?? "");
  };
  /** What the page says between its heading and its buttons, as words. */
  const words = (p: string) =>
    asRead(/<h1>Stop emails to[\s\S]*$/.exec(p)?.[0] ?? "")
      .replace(/<form[\s\S]*?<\/form>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return { read, buttons, press, words };
}

/** An email from dm about nothing in a group, as the seam sends it; its opt-out link. */
async function groupless(h: H, to: string, senderId: string) {
  const sent: MailMessage[] = [];
  const mail = suppressingMailPort(
    {
      send: (m) => {
        sent.push(m);
        return Promise.resolve();
      },
    },
    h.storage,
    { publicBaseUrl: "https://whendowe.example", now: () => new Date().toISOString() },
  );
  await mail.send({
    to,
    subject: "s",
    text: "t",
    cause: { kind: "from", senderId, groupId: null, why: "dm added this address" },
  });
  return optOutToken(sent[0]);
}

const SIGN_IN_LINE =
  "Sign-in links you ask for yourself still arrive: none of these stop you signing in.";

it("mail that stops (rc51): the page warns first, offers the link instead, and starts them again", async () => {
  const h = await harness();
  await signIn(h, "dm@example.org", "dm");
  const dm = await findOrCreatePerson(h.storage, "dm@example.org", { now: NOW });
  const ann = await findOrCreatePerson(h.storage, "ann@example.org", { now: NOW });
  const o = optOutPage(h, await groupless(h, "ann@example.org", dm.id));
  const head = `Stop emails to ann@example.org ${SIGN_IN_LINE}`;

  // Not in a verified plan of two: the page is as it was, and the link choice is refused.
  let p = await o.read();
  expect(o.words(p)).toBe(
    `${head} Or delete everything This address has never signed in. Deleting removes it from every group, event and plan it was added to, at once, and stops all email to it. This can't be undone.`,
  );
  expect(o.buttons(p)).toEqual([
    "Stop emails from the person who sent this",
    "Stop emails from anyone on WhenDoWe",
    "Delete everything about this address",
  ]);
  const t = /name="t" value="([^"]+)"/.exec(p)?.[1] ?? "";
  expect((await h.app.request(OPT_OUT_PATH, post({ t, do: "links" }))).status).toBe(400);

  const event = await createEvent(h.storage, {
    creatorId: dm.id,
    group: null,
    fields: FIELDS,
    now: NOW,
    verified: true,
    people: [{ personId: ann.id, editTier: "view", visibility: "FULL" }],
  });
  p = await o.read();
  // Before the buttons, about whoever sent this email, the other one there — named as
  // the page names them: with no group, never by a name from elsewhere (rc21).
  expect(o.words(p)).toMatch(
    new RegExp(
      `^${head} The person who sent this will see in the history of a verified plan you share with only them that you stopped these emails, and when\\. Or delete`,
    ),
  );
  expect(o.buttons(p)).toEqual([
    "Stop emails from the person who sent this",
    "Stop emails — the person who sent this can send me the link",
    "Stop emails from anyone on WhenDoWe",
    "Delete everything about this address",
  ]);

  expect(await o.press("Stop emails — the person who sent this can send me the link")).toBe(
    "You won't get email from that person any more. They'll see that you asked for the link instead.",
  );
  const trail = async () =>
    (await mailTrailOf(h.storage, { kind: "event", id: event.id })).map((e) => e.kind);
  expect(await trail()).toEqual(["stopped_links"]);
  p = await o.read();
  // Nothing of dm's reaches her any more, so nothing is left to warn about.
  expect(o.words(p)).toMatch(new RegExp(`^${head} You've stopped these emails Or delete`));
  expect(o.buttons(p)).toEqual([
    "Start emails from the person who sent this again",
    "Stop emails — the person who sent this can send me the link",
    "Stop emails from anyone on WhenDoWe",
    "Delete everything about this address",
  ]);

  // A plain stop replaces the preference; starting again is recorded.
  expect(await o.press("Start emails from the person who sent this again")).toBe(
    "Emails from that person will reach you again.",
  );
  expect(await o.press("Stop emails from the person who sent this")).toBe(
    "You won't get email from that person any more.",
  );
  expect(await o.press("Start emails from the person who sent this again")).toBe(
    "Emails from that person will reach you again.",
  );
  expect(await trail()).toEqual(["stopped_links", "again", "stopped", "again"]);

  // Opt-outs this link didn't make aren't its to start again.
  const cat = await findOrCreatePerson(h.storage, "cat@example.org", { now: NOW });
  await suppress(h.storage, "ann@example.org", { kind: "person", id: cat.id }, NOW);
  await suppress(h.storage, "ann@example.org", { kind: "group", id: "another-group" }, NOW);
  p = await o.read();
  expect(o.words(p)).not.toContain("You've stopped these emails");
  expect(o.buttons(p)[0]).toBe("Stop emails from the person who sent this");
});

it("mail that stops (rc51): through a group, it starts again from the same link", async () => {
  const h = await harness();
  await invited(h, "ann@example.org");
  const o = optOutPage(h, optOutToken(h.sent.at(-1)));
  expect(await o.press("Stop emails through “Thursday Table”")).toBe(
    "You won't get email through that group any more.",
  );
  let p = await o.read();
  expect(o.words(p)).toBe(
    `Stop emails to ann@example.org ${SIGN_IN_LINE} You've stopped these emails Or delete everything This address has never signed in. Deleting removes it from every group, event and plan it was added to, at once, and stops all email to it. This can't be undone.`,
  );
  expect(o.buttons(p)).toEqual([
    "Start emails through “Thursday Table” again",
    "Stop emails from dm",
    "Stop emails from anyone on WhenDoWe",
    "Delete everything about this address",
  ]);
  expect(await o.press("Start emails through “Thursday Table” again")).toBe(
    "Emails through that group will reach you again.",
  );
  p = await o.read();
  expect(o.buttons(p)[0]).toBe("Stop emails from dm");
  expect(o.buttons(p)).toContain("Stop emails through “Thursday Table”");
  // From everyone: as before (rc24), the links go with it, so this one no longer opens.
  expect(await o.press("Stop emails from anyone on WhenDoWe")).toBe(
    "You won't get email from anyone on WhenDoWe. Sign-in links you ask for still arrive.",
  );
  expect(await o.read()).toContain("This link has expired");
});

it("mail that stops (rc51): with someone else as the other one, the warning names nobody", async () => {
  const h = await harness();
  await signIn(h, "dm@example.org", "dm");
  const dm = await findOrCreatePerson(h.storage, "dm@example.org", { now: NOW });
  const o = optOutPage(h, await groupless(h, "ann@example.org", dm.id));
  const cat = await findOrCreatePerson(h.storage, "cat@example.org", { now: NOW });
  const ann = await findOrCreatePerson(h.storage, "ann@example.org", { now: NOW });
  await createEvent(h.storage, {
    creatorId: cat.id,
    group: null,
    fields: FIELDS,
    now: NOW,
    verified: true,
    people: [{ personId: ann.id, editTier: "view", visibility: "FULL" }],
  });
  const p = await o.read();
  expect(o.words(p)).toContain(
    "In a verified plan with only one other person, they'll see in its history that you stopped these emails, and when.",
  );
  expect(p).not.toContain("cat");
  expect(p).not.toContain("Handover");
  expect(o.buttons(p).some((b) => b.includes("can send me the link"))).toBe(false);
});
