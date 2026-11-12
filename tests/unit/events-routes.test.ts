// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { MailCapReachedError, SenderShareReachedError } from "../../src/mail/capped.js";
import type { MailMessage } from "../../src/mail/port.js";
import { createApp } from "../../src/web/app.js";
import { ACCOUNT_PATH } from "../../src/web/layout.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH, INVITE_PATH } from "../../src/web/routes/groups.js";
import { loadMigrationSql } from "../conftest.js";

// Event pages end to end (in-memory SQLite, recording mail). The centrepiece is
// DESIGN §9 visibility integrity: each tier is checked on the event page, the group
// list AND the change history — where a diff of a hidden field would leak it.

async function harness() {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const sent: MailMessage[] = [];
  // Set to make every send fail — the mail cap, a provider outage.
  const mailFailure: { error: Error | null } = { error: null };
  const app = createApp({
    auth: {
      storage,
      mail: {
        send: (m) => {
          if (mailFailure.error !== null) return Promise.reject(mailFailure.error);
          sent.push(m);
          return Promise.resolve();
        },
      },
      publicBaseUrl: "https://whendowe.example",
      secureCookies: false,
      now: () => new Date().toISOString(),
    },
  });
  return { app, sent, mailFailure, storage };
}
type H = Awaited<ReturnType<typeof harness>>;
interface Who {
  cookie: string;
  csrf: string;
}

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});
const get = (h: H, path: string, who?: Who) =>
  h.app.request(path, who ? { headers: { cookie: who.cookie } } : {});
const text = async (h: H, path: string, who?: Who) => (await get(h, path, who)).text();

async function csrfOf(h: H, cookie: string): Promise<string> {
  return (
    /name="csrf" value="([^"]+)"/.exec(
      await (await h.app.request("/", { headers: { cookie } })).text(),
    )?.[1] ?? ""
  );
}

async function signIn(h: H, email: string): Promise<Who> {
  await h.app.request(SIGN_IN_PATH, post({ email }));
  const t =
    new URL(/https?:\/\/\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "").searchParams.get("t") ??
    "";
  const cookie =
    ((await h.app.request(CONFIRM_PATH, post({ t }))).headers.get("set-cookie") ?? "").split(
      ";",
    )[0] ?? "";
  return named(h, { cookie, csrf: await csrfOf(h, cookie) }, email);
}

/**
 * People choose a name when they first sign in (DESIGN §10 rc21); here, the part of their
 * address before @, so "dm@example.org" appears to others as "dm" and never by address.
 */
async function named(h: H, who: Who, email: string): Promise<Who> {
  const handle = email.split("@")[0] ?? "";
  await h.app.request(ACCOUNT_PATH, post({ csrf: who.csrf, handle }, who.cookie));
  return who;
}

/** DM + group; returns the group path. */
async function setup(h: H) {
  const dm = await signIn(h, "dm@example.org");
  const res = await h.app.request(
    GROUPS_PATH,
    post({ csrf: dm.csrf, name: "Thursday Table" }, dm.cookie),
  );
  return { dm, group: res.headers.get("location") ?? "" };
}

/** Invite + join at the given tiers; returns the player's session. */
async function join(
  h: H,
  dm: Who,
  group: string,
  email: string,
  editTier: string,
  visibility: string,
): Promise<Who> {
  await h.app.request(
    `${group}/invites`,
    post({ csrf: dm.csrf, email, editTier, visibility }, dm.cookie),
  );
  const link = new URL(
    /https?:\/\/\S+\/invite\?t=\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "http://x/",
  );
  const res = await h.app.request(INVITE_PATH, post({ t: link.searchParams.get("t") ?? "" }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return named(h, { cookie, csrf: await csrfOf(h, cookie) }, email);
}

const NIGHT = {
  title: "Session 12: the Sunken Keep",
  location: "Ann's place",
  description: "SECRET-NOTE: Bob is anxious about the dragon",
  start: "2101-10-20T19:00",
  end: "2101-10-20T23:00",
  tzid: "Europe/Prague",
};

async function createVia(
  h: H,
  dm: Who,
  group: string,
  fields: Record<string, string> = NIGHT,
): Promise<string> {
  const res = await h.app.request(`${group}/events`, post({ csrf: dm.csrf, ...fields }, dm.cookie));
  expect(res.status).toBe(303);
  return res.headers.get("location") ?? "";
}

// --- create + view ------------------------------------------------------------------

it("a member creates an event; it shows on its page and in the group", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  const page = await text(h, event, dm);
  expect(page).toContain("Session 12: the Sunken Keep");
  expect(page).toContain("2101-10-20 19:00 – 23:00 · Europe/Prague");
  expect(page).toContain("SECRET-NOTE"); // the organizer sees FULL
  expect(page).toContain("created it");
  expect(await text(h, group, dm)).toContain("Session 12: the Sunken Keep");
});

it("re-shows the form with an explanation and the typed values on a bad time", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const res = await h.app.request(
    `${group}/events`,
    post({ csrf: dm.csrf, ...NIGHT, end: "2101-10-20T18:00" }, dm.cookie),
  );
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain("must end after it starts");
  expect(body).toContain('value="Session 12: the Sunken Keep"');
});

it("stores all-day events with an exclusive end but shows the last day inclusively", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group, {
    ...NIGHT,
    allDay: "on",
    start: "2101-10-24T00:00",
    end: "2101-10-25T00:00",
  });
  expect(await text(h, event, dm)).toContain("2101-10-24 – 2101-10-25 (all day)");
});

// --- visibility integrity (DESIGN §9, WORKFLOWS US-6) --------------------------------

it("DETAILS sees title, time and place — never notes, people, or notes in the history", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const petra = await join(h, dm, group, "petra@example.org", "view", "DETAILS");
  const event = await createVia(h, dm, group);

  // The organizer changes the private notes AND the place.
  const edit = await text(h, `${event}/edit`, dm);
  const revision = /name="revision" value="(\d+)"/.exec(edit)?.[1] ?? "";
  const saved = await h.app.request(
    event,
    post(
      {
        csrf: dm.csrf,
        revision,
        ...NIGHT,
        location: "Bob's place",
        description: "SECRET-NOTE-2: moved",
      },
      dm.cookie,
    ),
  );

  // Without this, a failed edit would leave nothing to leak and the test would pass vacuously.
  expect(saved.status).toBe(303);
  const page = await text(h, event, petra);
  expect(page).toContain("Session 12: the Sunken Keep");
  expect(page).toContain("Bob&#39;s place"); // the apostrophe arrives escaped
  expect(page).not.toContain("SECRET-NOTE"); // neither the old notes nor the new ones…
  expect(page).not.toContain("Taking part"); // …nor the participant list
  // …yet the place change IS in her history: filtered, not suppressed wholesale.
  expect(page).toMatch(/location: Ann&#39;s place → Bob&#39;s place/);
});

it("BUSY sees only that the time is taken — on the page and in the group list", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const grandma = await join(h, dm, group, "grandma@example.org", "view", "BUSY");
  const event = await createVia(h, dm, group);
  for (const body of [await text(h, event, grandma), await text(h, group, grandma)]) {
    expect(body).toContain("Busy");
    expect(body).toContain("2101-10-20 19:00");
    expect(body).not.toContain("Sunken Keep");
    expect(body).not.toContain("Ann&#39;s place");
    expect(body).not.toContain("SECRET-NOTE");
  }
});

it("HIDDEN sees nothing at all: no page, not in the list", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  // HIDDEN is a valid tier the server accepts; the invite form simply doesn't offer it.
  const ex = await join(h, dm, group, "hidden@example.org", "view", "HIDDEN");
  const event = await createVia(h, dm, group);
  expect((await get(h, event, ex)).status).toBe(404);
  const list = await text(h, group, ex);
  expect(list).not.toContain(event);
  expect(list).not.toContain("Busy");
  expect(list).toContain("Nothing planned yet.");
});

// --- editing ------------------------------------------------------------------------

async function revisionOf(h: H, event: string, who: Who): Promise<string> {
  return /name="revision" value="(\d+)"/.exec(await text(h, `${event}/edit`, who))?.[1] ?? "";
}

it("an editor's change is saved and attributed in the history", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  const res = await h.app.request(
    event,
    post(
      {
        csrf: dm.csrf,
        revision: await revisionOf(h, event, dm),
        ...NIGHT,
        start: "2101-10-20T20:00",
      },
      dm.cookie,
    ),
  );
  expect(res.status).toBe(303);
  const page = await text(h, event, dm);
  expect(page).toContain("dm changed");
  expect(page).toContain("startLocal: 2101-10-20T19:00:00 → 2101-10-20T20:00:00");
});

it("someone with view tier gets no edit link and is refused if they try", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const player = await join(h, dm, group, "player@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);
  expect(await text(h, event, player)).not.toContain("/edit");
  expect((await get(h, `${event}/edit`, player)).status).toBe(403);
  const res = await h.app.request(
    event,
    post({ csrf: player.csrf, revision: "1", ...NIGHT, title: "Hijacked" }, player.cookie),
  );
  expect(res.status).toBe(403);
  expect(await text(h, event, dm)).not.toContain("Hijacked");
});

it("two editors from the same stale form: the second is told, and loses nothing silently", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  const seen = await revisionOf(h, event, dm); // both "tabs" opened the form here
  const first = await h.app.request(
    event,
    post({ csrf: dm.csrf, revision: seen, ...NIGHT, title: "First edit" }, dm.cookie),
  );
  expect(first.status).toBe(303);
  const second = await h.app.request(
    event,
    post({ csrf: dm.csrf, revision: seen, ...NIGHT, title: "Second edit" }, dm.cookie),
  );
  expect(second.status).toBe(409);
  const body = await second.text();
  expect(body).toContain("Someone else changed this event");
  expect(body).toContain('value="First edit"'); // the form now shows the CURRENT version
  expect(await text(h, event, dm)).toContain("First edit");
});

it("refuses create and edit without this session's CSRF token", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  expect((await h.app.request(`${group}/events`, post({ ...NIGHT }, dm.cookie))).status).toBe(403);
  const event = await createVia(h, dm, group);
  const res = await h.app.request(
    event,
    post({ revision: "1", ...NIGHT, title: "Forged" }, dm.cookie),
  );
  expect(res.status).toBe(403);
  expect(await text(h, event, dm)).not.toContain("Forged");
});

// --- access and escaping --------------------------------------------------------------

it("an outsider gets 404 for the event, its edit form, and an edit POST", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  const stranger = await signIn(h, "stranger@example.org");
  expect((await get(h, event, stranger)).status).toBe(404);
  expect((await get(h, `${event}/edit`, stranger)).status).toBe(404);
  expect(
    (
      await h.app.request(
        event,
        post({ csrf: stranger.csrf, revision: "1", ...NIGHT }, stranger.cookie),
      )
    ).status,
  ).toBe(404);
  expect((await get(h, `${group}/events/new`, stranger)).status).toBe(404);
});

it("escapes hostile titles, places and notes everywhere they appear", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const evil = '<img src=x onerror="alert(1)">';
  const event = await createVia(h, dm, group, {
    ...NIGHT,
    title: evil,
    location: evil,
    description: evil,
  });
  for (const body of [
    await text(h, event, dm),
    await text(h, group, dm),
    await text(h, `${event}/edit`, dm),
  ]) {
    expect(body).not.toContain("<img src=x");
  }
});

// --- time polls (slice 2C) ------------------------------------------------------------

const POLL = {
  title: "Session 13",
  location: "Ann's place",
  description: "",
  tzid: "Europe/Prague",
  start_0: "2101-10-22T18:00",
  end_0: "2101-10-22T22:00",
  start_1: "2101-10-20T19:00",
  end_1: "2101-10-20T23:00",
};

it("refuses a poll with no time, keeping what was typed; one time is a poll (rc33)", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const res = await h.app.request(
    `${group}/polls`,
    post({ csrf: dm.csrf, ...POLL, start_0: "", end_0: "", start_1: "", end_1: "" }, dm.cookie),
  );
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain("Offer a time.");
  expect(body).toContain(`value="${POLL.title}"`);
  const one = await h.app.request(
    `${group}/polls`,
    post({ csrf: dm.csrf, ...POLL, start_1: "", end_1: "" }, dm.cookie),
  );
  expect(one.status).toBe(303);
});

it("the form makes a thread: who sees what the group plans votes, busy-only members don't", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "petra@example.org", "view", "DETAILS");
  await join(h, dm, group, "gran@example.org", "view", "BUSY");
  const form = await text(h, `${group}/polls/new`, dm);
  expect(form).toContain(`action="${group}/polls"`);
  expect(form).toContain("Everyone in Thursday Table who sees what the group plans votes;");
  expect(form).not.toContain('name="tier_0"');
  expect(form).not.toContain('name="vis_0"');
  const res = await h.app.request(`${group}/polls`, post({ csrf: dm.csrf, ...POLL }, dm.cookie));
  expect(res.status).toBe(303);
  const thread = res.headers.get("location") ?? "";
  expect(thread).toMatch(/^\/plans\/[0-9a-f-]+$/);
  const [row] = await h.storage.query({
    sql: `SELECT count(*) AS n, sum(p.email = 'gran@example.org') AS gran FROM plan_thread_member m
          JOIN person p ON p.id = m.person_id WHERE m.thread_id = ?`,
    params: [thread.split("/").at(-1) ?? ""],
  });
  expect(row).toEqual({ n: 2, gran: 0 }); // the DM and Petra
});

it("a poll with nobody to ask is a poll of one, opened on sharing it (rc29)", async () => {
  const h = await harness();
  const dm = await signIn(h, "dm@example.org");
  const res = await h.app.request("/polls", post({ csrf: dm.csrf, ...POLL }, dm.cookie));
  expect(res.status).toBe(303);
  const location = res.headers.get("location") ?? "";
  expect(location).toMatch(/^\/plans\/[0-9a-f-]+#share$/);
  const page = await (
    await h.app.request(location.split("#")[0] ?? "", { headers: { cookie: dm.cookie } })
  ).text();
  expect(page).toContain('id="share"');
  expect(page).toContain("Nobody's in this yet.");
  expect(page).toContain("Share a link");
  expect(page).not.toContain("Email vote links");
});

it("starting a poll requires CSRF and membership", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const stranger = await signIn(h, "stranger@example.org");
  expect((await h.app.request(`${group}/polls`, post({ ...POLL }, dm.cookie))).status).toBe(403);
  expect(
    (await h.app.request(`${group}/polls`, post({ csrf: stranger.csrf, ...POLL }, stranger.cookie)))
      .status,
  ).toBe(404);
  expect((await get(h, `${group}/polls/new`, stranger)).status).toBe(404);
});

// --- account-less responses (slice 2D) ------------------------------------------------

/** The emailed response link for this address, from the most recent mail to it. */
function linkFor(h: H, email: string): string {
  const mail = [...h.sent].reverse().find((m) => m.to === email);
  const url = /https?:\/\/\S+\/respond\?t=\S+/.exec(mail?.text ?? "")?.[0];
  if (url === undefined) throw new Error(`no response link for ${email}`);
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

const tokenOf = (path: string) => new URL(path, "http://x").searchParams.get("t") ?? "";

async function sendLinks(h: H, dm: Who, event: string) {
  return h.app.request(`${event}/links`, post({ csrf: dm.csrf }, dm.cookie));
}

it("an organizer emails answer links: everyone but themself, and no title in a BUSY inbox", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  await join(h, dm, group, "grandma@example.org", "view", "BUSY");
  const event = await createVia(h, dm, group, { ...NIGHT, title: "Session 13" });
  const before = h.sent.length;
  const res = await sendLinks(h, dm, event);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Sent to 2 people.");
  const mails = h.sent.slice(before);
  expect(mails.map((m) => m.to).sort()).toEqual(["ann@example.org", "grandma@example.org"]);
  const ann = mails.find((m) => m.to === "ann@example.org");
  const grandma = mails.find((m) => m.to === "grandma@example.org");
  expect(ann?.subject).toBe('Are you coming to "Session 13"?');
  expect(ann?.text).toContain(
    'dm would like to know whether you\'re coming to "Session 13" (2101-10-20 19:00 – 23:00 · Europe/Prague).',
  );
  expect(`${grandma?.subject} ${grandma?.text}`).not.toContain("Session 13");
  expect(grandma?.subject).toBe("Are you coming? (2101-10-20 19:00 – 23:00 · Europe/Prague)");
  expect(grandma?.text).toContain(
    "dm would like to know whether you're coming (2101-10-20 19:00 – 23:00 · Europe/Prague).",
  );
  // It came through the group, so its opt-out link can stop the group's mail (rc24).
  const t =
    new URL(
      /https:\/\/\S+\/opt-out\?t=\S+/.exec(grandma?.text ?? "")?.[0] ?? "https://x/",
    ).searchParams.get("t") ?? "";
  expect(await text(h, `/opt-out?t=${t}`)).toContain("Stop emails through “Thursday Table”");
});

it("a player answers from the link with no account: GET changes nothing, POST saves, nobody is signed in", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);
  await sendLinks(h, dm, event);
  const link = linkFor(h, "ann@example.org");

  // No cookie at all: the link is the identity. Opening it (twice, like a mail
  // scanner) records nothing and sets no session.
  for (let i = 0; i < 2; i++) {
    const page = await h.app.request(link);
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("Are you coming?");
  }
  expect(await text(h, event, dm)).toContain("0 going · 0 maybe · 0 can't make it");

  const res = await h.app.request("/respond", post({ t: tokenOf(link), attendance: "going" }));
  expect(res.status).toBe(303);
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(await (await h.app.request(res.headers.get("location") ?? "")).text()).toContain(
    "your answer is saved",
  );
  expect(await text(h, event, dm)).toContain("ann: Going");
});

it("a response link answers only for its own event and person — and a dead link says so", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);
  await sendLinks(h, dm, event);
  const t = tokenOf(linkFor(h, "ann@example.org"));
  // The link can't be turned on another event by path or body: there is no event id to send.
  const other = await createVia(h, dm, group, { ...NIGHT, title: "Another" });
  await h.app.request("/respond", post({ t, attendance: "going" }));
  expect(await text(h, other, dm)).toContain("0 going · 0 maybe · 0 can't make it");
  expect(await text(h, event, dm)).toContain("1 going");
  for (const bad of ["/respond?t=not-a-token", "/respond", `/respond?t=${t}x`]) {
    const res = await h.app.request(bad);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This link no longer works");
  }
  expect((await h.app.request("/respond", post({ t: "nope", attendance: "going" }))).status).toBe(
    404,
  );
});

it("once an event is cancelled, its link says so and refuses a late answer", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);
  await sendLinks(h, dm, event);
  const link = linkFor(h, "ann@example.org");
  await h.app.request(`${event}/cancel`, post({ csrf: dm.csrf }, dm.cookie));
  expect(await (await h.app.request(link)).text()).toContain("nothing to answer here any more");
  expect(
    (await h.app.request("/respond", post({ t: tokenOf(link), attendance: "going" }))).status,
  ).toBe(409);
});

it("attendance and notes by link; a DETAILS member sees the counts but not who or their notes", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  const petra = await join(h, dm, group, "petra@example.org", "view", "DETAILS");
  const event = await createVia(h, dm, group);
  await sendLinks(h, dm, event);
  const link = linkFor(h, "ann@example.org");
  expect(await (await h.app.request(link)).text()).toContain("Are you coming?");
  const res = await h.app.request(
    "/respond",
    post({ t: tokenOf(link), attendance: "maybe", note: "NOTE-7: running late" }),
  );
  expect(res.status).toBe(303);

  const dmPage = await text(h, event, dm);
  expect(dmPage).toContain("ann: Maybe");
  expect(dmPage).toContain("ann: <span");
  expect(dmPage).toContain("NOTE-7: running late");
  const petraPage = await text(h, event, petra);
  expect(petraPage).toContain("0 going · 1 maybe · 0 can't make it"); // literal template text
  expect(petraPage).not.toContain("ann@example.org");
  expect(petraPage).not.toContain("ann: "); // nor her name: DETAILS doesn't see who
  // A marker, not "might be late": the note form's own example text says that.
  expect(petraPage).not.toContain("NOTE-7");
});

it("a resend within the hour sends nothing new; a failed send can be retried at once", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);

  // The cap is hit: nothing goes out, and the page says so.
  h.mailFailure.error = new MailCapReachedError({ daily: 1, monthly: 1 });
  const capped = await sendLinks(h, dm, event);
  expect(capped.status).toBe(503);
  expect(await capped.text()).toContain("Sent to 0 people. Couldn&#39;t send to 1");
  // Mail is back: the retry goes out immediately — the undelivered link was withdrawn,
  // so the resend throttle doesn't lock Ann out for an hour.
  h.mailFailure.error = null;
  expect(await (await sendLinks(h, dm, event)).text()).toContain("Sent to 1 person.");
  const before = h.sent.length;
  expect(await (await sendLinks(h, dm, event)).text()).toContain(
    "1 already got a link in the last hour.",
  );
  expect(h.sent.length).toBe(before);
});

it("signed in: say you're coming and leave a note from the event page", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);
  expect(
    (
      await h.app.request(
        `${event}/attendance`,
        post({ csrf: ann.csrf, attendance: "going" }, ann.cookie),
      )
    ).status,
  ).toBe(303);
  expect(
    (
      await h.app.request(
        `${event}/feedback`,
        post({ csrf: ann.csrf, note: "bringing dice" }, ann.cookie),
      )
    ).status,
  ).toBe(303);
  const page = await text(h, event, dm);
  expect(page).toContain("ann: Going");
  expect(page).toContain("bringing dice");
  // Ann's own answer is pre-selected for her.
  expect(await text(h, event, ann)).toMatch(/name="attendance" value="going" checked/);
});

it("response routes require CSRF, membership, and an editor to send links", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);
  const stranger = await signIn(h, "stranger@example.org");
  for (const path of ["attendance", "feedback", "links"]) {
    expect(
      (await h.app.request(`${event}/${path}`, post({ attendance: "going", note: "x" }, dm.cookie)))
        .status,
    ).toBe(403);
    expect(
      (
        await h.app.request(
          `${event}/${path}`,
          post({ csrf: stranger.csrf, attendance: "going", note: "x" }, stranger.cookie),
        )
      ).status,
    ).toBe(404);
  }
  expect(await text(h, event, ann)).not.toContain("Email everyone");
  const before = h.sent.length;
  expect((await h.app.request(`${event}/links`, post({ csrf: ann.csrf }, ann.cookie))).status).toBe(
    403,
  );
  expect(h.sent.length).toBe(before);
});

// --- agreement & acknowledgment (slice 2E-1) ------------------------------------------

/** The person id behind a member's "Ask people" select on the new-event form. */
async function memberId(h: H, dm: Who, group: string, email: string): Promise<string> {
  const formPage = await text(h, `${group}/events/new`, dm);
  const id = new RegExp(`${email.split("@")[0]}\\s*<select name="req_([0-9a-f-]{36})"`).exec(
    formPage,
  )?.[1];
  if (id === undefined) throw new Error(`no request select for ${email}`);
  return id;
}

async function household(h: H) {
  const { dm: mara, group } = await setup(h);
  const david = await join(h, mara, group, "david@example.org", "view", "FULL");
  const petra = await join(h, mara, group, "petra@example.org", "view", "DETAILS");
  return {
    mara,
    group,
    david,
    petra,
    davidId: await memberId(h, mara, group, "david@example.org"),
  };
}

const act = (h: H, event: string, who: Who, path: string, fields: Record<string, string> = {}) =>
  h.app.request(`${event}/${path}`, post({ csrf: who.csrf, ...fields }, who.cookie));

it("asking someone to agree: only the parties see it until they do, then everyone does", async () => {
  const h = await harness();
  const { mara, group, david, petra, davidId } = await household(h);
  const event = await createVia(h, mara, group, { ...NIGHT, [`req_${davidId}`]: "accept" });

  expect(await text(h, event, mara)).toContain("(waiting for agreement)");
  expect(await text(h, event, mara)).toContain("david: must agree — not answered yet");
  expect((await get(h, event, petra)).status).toBe(404); // US-3: scheduled reality only
  expect(await text(h, group, petra)).not.toContain(event);
  const davidPage = await text(h, event, david);
  expect(davidPage).toContain("You're asked to agree to this.");

  expect((await act(h, event, david, "answer", { answer: "accept" })).status).toBe(303);
  expect((await get(h, event, petra)).status).toBe(200);
  const after = await text(h, event, mara);
  expect(after).not.toContain("waiting for agreement");
  expect(after).toContain("david: must agree — agreed ✓");
  expect(after).toContain("status: proposed → scheduled");
});

it("one decline turns it down; the creator sees who and can no longer withdraw", async () => {
  const h = await harness();
  const { mara, group, david, davidId } = await household(h);
  const event = await createVia(h, mara, group, { ...NIGHT, [`req_${davidId}`]: "accept" });
  expect(await text(h, event, david)).not.toContain("Withdraw");
  expect((await act(h, event, david, "answer", { answer: "decline" })).status).toBe(303);
  const page = await text(h, event, mara);
  expect(page).toContain("(declined)");
  expect(page).toMatch(/david changed<ul><li>status: proposed → declined/);
  expect(page).not.toContain("Withdraw");
  expect((await act(h, event, mara, "withdraw")).status).toBe(409);
});

it("the creator withdraws a proposal nobody answered", async () => {
  const h = await harness();
  const { mara, group, david, davidId } = await household(h);
  const event = await createVia(h, mara, group, { ...NIGHT, [`req_${davidId}`]: "accept" });
  expect((await act(h, event, david, "withdraw")).status).toBe(403);
  expect((await act(h, event, mara, "withdraw")).status).toBe(303);
  expect(await text(h, event, mara)).toContain("(withdrawn)");
  expect((await act(h, event, david, "answer", { answer: "accept" })).status).toBe(409);
});

it("an acknowledgment request: scheduled at once, 'seen ✓' with a time, asked again after a move", async () => {
  const h = await harness();
  const { mara, group, david, petra, davidId } = await household(h);
  const event = await createVia(h, mara, group, { ...NIGHT, [`req_${davidId}`]: "ack" });
  expect((await get(h, event, petra)).status).toBe(200); // never gates
  expect(await text(h, event, david)).toContain("You&#39;re asked to acknowledge this."); // an interpolated string: escaped
  expect((await act(h, event, david, "acknowledge")).status).toBe(303);
  expect(await text(h, event, mara)).toMatch(
    /david: please acknowledge — seen ✓ <span class="muted">\d{4}-/,
  );
  expect((await act(h, event, david, "acknowledge")).status).toBe(400); // nothing left to acknowledge

  // A retitle doesn't nag; a move does.
  const revision = async () =>
    /name="revision" value="(\d+)"/.exec(await text(h, `${event}/edit`, mara))?.[1] ?? "";
  await h.app.request(
    event,
    post({ csrf: mara.csrf, revision: await revision(), ...NIGHT, title: "Renamed" }, mara.cookie),
  );
  expect(await text(h, event, david)).not.toContain("please look again");
  await h.app.request(
    event,
    post(
      {
        csrf: mara.csrf,
        revision: await revision(),
        ...NIGHT,
        title: "Renamed",
        start: "2101-10-20T20:00",
      },
      mara.cookie,
    ),
  );
  expect(await text(h, event, david)).toContain(
    "This changed since you last saw it — please look again.",
  );
  expect(await text(h, event, mara)).toContain("david: please acknowledge — asked to look again");
});

it("a DETAILS member sees only their own request line, not everyone's", async () => {
  const h = await harness();
  const { mara, group, petra, davidId } = await household(h);
  const petraId = await memberId(h, mara, group, "petra@example.org");
  const event = await createVia(h, mara, group, {
    ...NIGHT,
    [`req_${davidId}`]: "ack",
    [`req_${petraId}`]: "ack",
  });
  const page = await text(h, event, petra);
  expect(page).toContain("petra: please acknowledge");
  expect(page).not.toContain("david: please acknowledge");
});

it("editors cancel and restore; others don't get the buttons and are refused", async () => {
  const h = await harness();
  const { mara, group, david } = await household(h);
  const event = await createVia(h, mara, group);
  expect(await text(h, event, david)).not.toContain("Cancel the event");
  expect((await act(h, event, david, "cancel")).status).toBe(403);
  expect((await act(h, event, mara, "cancel")).status).toBe(303);
  expect(await text(h, event, david)).toContain("(cancelled)");
  expect(await text(h, group, david)).toContain("(cancelled)");
  expect((await act(h, event, mara, "restore")).status).toBe(303);
  const page = await text(h, event, mara);
  expect(page).toContain("status: cancelled → scheduled");
  expect(page).toContain("Cancel the event");
});

it("by emailed link: David agrees with no account; acknowledgment by link too", async () => {
  const h = await harness();
  const { mara, group, davidId } = await household(h);
  const proposal = await createVia(h, mara, group, { ...NIGHT, [`req_${davidId}`]: "accept" });
  const before = h.sent.length;
  expect(await (await sendLinks(h, mara, proposal)).text()).toContain("Sent to 1 person."); // not Petra
  expect(h.sent.slice(before).map((m) => [m.to, m.subject])).toEqual([
    ["david@example.org", 'dm asks you to agree: "Session 12: the Sunken Keep"'],
  ]);
  expect(h.sent.at(-1)?.text).toContain(
    'dm proposes "Session 12: the Sunken Keep" (2101-10-20 19:00 – 23:00 · Europe/Prague) and asks whether you agree.',
  );
  const link = linkFor(h, "david@example.org");
  expect(await (await h.app.request(link)).text()).toContain("Do you agree?");
  expect(
    (await h.app.request("/respond", post({ t: tokenOf(link), decision: "accept" }))).status,
  ).toBe(303);
  expect(await (await h.app.request(link)).text()).toContain("It's settled.");
  expect(await text(h, proposal, mara)).toContain("david: must agree — agreed ✓");

  const fyi = await createVia(h, mara, group, {
    ...NIGHT,
    title: "Dentist",
    [`req_${davidId}`]: "ack",
  });
  await sendLinks(h, mara, fyi);
  const ackLink = linkFor(h, "david@example.org");
  expect(await (await h.app.request(ackLink)).text()).toContain("I&#39;ve seen this");
  expect((await h.app.request("/respond", post({ t: tokenOf(ackLink), ack: "on" }))).status).toBe(
    303,
  );
  expect(await text(h, fyi, mara)).toContain("david: please acknowledge — seen ✓");
});

it("lifecycle buttons require CSRF and membership", async () => {
  const h = await harness();
  const { mara, group } = await household(h);
  const event = await createVia(h, mara, group);
  const stranger = await signIn(h, "stranger@example.org");
  for (const path of [
    "answer",
    "acknowledge",
    "withdraw",
    "cancel",
    "restore",
    "proposal",
    "proposal/withdraw",
  ]) {
    expect(
      (await h.app.request(`${event}/${path}`, post({ answer: "accept" }, mara.cookie))).status,
    ).toBe(403);
    expect((await act(h, event, stranger, path, { answer: "accept" })).status).toBe(404);
  }
});

// --- change proposals: the propose tier (slice 2E-2) ----------------------------------

/** Submit the edit form as `who`, from the revision their form page carried. */
async function submitEdit(h: H, event: string, who: Who, fields: Record<string, string>) {
  const revision = /name="revision" value="(\d+)"/.exec(await text(h, `${event}/edit`, who))?.[1];
  return h.app.request(
    event,
    post({ csrf: who.csrf, revision: revision ?? "", ...fields }, who.cookie),
  );
}
const proposalIdOf = (page: string) =>
  /name="proposal" value="([0-9a-f-]{36})"/.exec(page)?.[1] ?? "";

it("a propose-tier change waits for an editor; accepted, history names both", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "propose", "FULL");
  const petra = await join(h, dm, group, "petra@example.org", "view", "DETAILS");
  const event = await createVia(h, dm, group);

  expect(await text(h, event, ann)).toContain("Propose a change");
  expect(await text(h, event, petra)).not.toContain("Propose a change");
  expect(await text(h, `${event}/edit`, ann)).toContain("Send proposal");
  expect((await submitEdit(h, event, ann, { ...NIGHT, location: "Bob's place" })).status).toBe(303);

  const before = await text(h, event, dm);
  expect(before).toContain("📍 Ann&#39;s place"); // nothing changed yet
  expect(before).toContain("<strong>ann</strong> proposes:");
  expect(before).toContain("location: Ann&#39;s place → Bob&#39;s place");
  expect(await text(h, event, ann)).toContain("You proposed a change — waiting");
  expect(await text(h, event, petra)).not.toContain("Proposed changes");

  const id = proposalIdOf(before);
  expect((await act(h, event, ann, "proposal", { proposal: id, decision: "accept" })).status).toBe(
    403,
  );
  expect((await act(h, event, dm, "proposal", { proposal: id, decision: "accept" })).status).toBe(
    303,
  );
  const after = await text(h, event, petra); // attribution reaches every tier (rc13)
  expect(after).toContain("📍 Bob&#39;s place");
  expect(after).toContain("dm accepted ann&#39;s proposal");
  expect(await text(h, event, ann)).toContain("Your proposal was accepted by dm.");
  expect(await text(h, event, dm)).not.toContain("Proposed changes");
});

it("the proposer is told when it is turned down, or when the event moved on first", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "propose", "FULL");
  const event = await createVia(h, dm, group);

  await submitEdit(h, event, ann, { ...NIGHT, location: "Bob's place" });
  expect((await submitEdit(h, event, dm, { ...NIGHT, title: "Session 12, moved" })).status).toBe(
    303,
  );
  expect(await text(h, event, dm)).not.toContain("Proposed changes");
  expect(await text(h, event, ann)).toContain("wasn&#39;t decided before the event changed");

  await submitEdit(h, event, ann, { ...NIGHT, title: "Session 12, moved", location: "Park" });
  const id = proposalIdOf(await text(h, event, dm));
  expect((await act(h, event, dm, "proposal", { proposal: id, decision: "reject" })).status).toBe(
    303,
  );
  expect(await text(h, event, ann)).toContain("Your proposal was turned down by dm.");
  expect(await text(h, event, dm)).toContain("📍 Ann&#39;s place");
});

it("the proposer can withdraw; view tier can't propose; cancelled events take no proposals", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "propose", "FULL");
  const bob = await join(h, dm, group, "bob@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);

  await submitEdit(h, event, ann, { ...NIGHT, location: "Park" });
  const mine = await text(h, event, ann);
  expect(
    (await act(h, event, ann, "proposal/withdraw", { proposal: proposalIdOf(mine) })).status,
  ).toBe(303);
  expect(await text(h, event, dm)).not.toContain("Proposed changes");

  expect(await text(h, event, bob)).not.toContain("Propose a change");
  expect((await get(h, `${event}/edit`, bob)).status).toBe(403);
  expect((await submitEdit(h, event, bob, { ...NIGHT, location: "Park" })).status).toBe(403);

  await act(h, event, dm, "cancel");
  expect(await text(h, event, ann)).not.toContain("Propose a change");
  expect((await get(h, `${event}/edit`, ann)).status).toBe(409);
});

it("the edit form never shows a field the tier can't see, and saving keeps it", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "propose", "DETAILS");
  const carl = await join(h, dm, group, "carl@example.org", "edit", "DETAILS");
  const gran = await join(h, dm, group, "gran@example.org", "propose", "BUSY");
  const event = await createVia(h, dm, group);

  for (const who of [ann, carl]) {
    const form = await text(h, `${event}/edit`, who);
    expect(form).toContain("Ann&#39;s place");
    expect(form).not.toContain("SECRET-NOTE");
    expect(form).not.toContain('name="description"');
  }
  const busyForm = await text(h, `${event}/edit`, gran);
  expect(busyForm).not.toContain("Sunken Keep");
  expect(busyForm).not.toContain("Ann&#39;s place");

  // Carl edits the place; Ann proposes a later start and it is accepted.
  const { description: _notes, ...visible } = NIGHT;
  expect((await submitEdit(h, event, carl, { ...visible, location: "Bob's place" })).status).toBe(
    303,
  );
  await submitEdit(h, event, ann, {
    ...visible,
    location: "Bob's place",
    start: "2101-10-20T20:00",
  });
  const id = proposalIdOf(await text(h, event, dm));
  await act(h, event, dm, "proposal", { proposal: id, decision: "accept" });

  const page = await text(h, event, dm);
  expect(page).toContain("📍 Bob&#39;s place");
  expect(page).toContain("2101-10-20 20:00");
  expect(page).toContain("SECRET-NOTE: Bob is anxious"); // the notes survived both saves
  expect(page).not.toMatch(/description:/);
});

it("a pending proposal is shown at the editor's own tier", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "propose", "FULL");
  const carl = await join(h, dm, group, "carl@example.org", "edit", "DETAILS");
  const event = await createVia(h, dm, group);

  await submitEdit(h, event, ann, {
    ...NIGHT,
    location: "Park",
    description: "SECRET-NOTE-3: bring the map",
  });
  expect(await text(h, event, dm)).toContain("SECRET-NOTE-3"); // FULL sees the whole proposal
  const page = await text(h, event, carl);
  expect(page).toContain("location: Ann&#39;s place → Park");
  expect(page).not.toContain("SECRET-NOTE");
});

// --- recurring series (slice 2E-3) ---------------------------------------------------

it("a weekly series: described in words, its next dates listed, editable as a whole", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group, {
    ...NIGHT,
    repeat: "FREQ=WEEKLY",
    until: "2101-12-31",
  });
  const page = await text(h, event, dm);
  expect(page).toContain("↻ Every week, until 2101-12-31");
  expect(page).toMatch(
    /Next:<\/p><ul><li>2101-10-20 19:00 – 23:00 · Europe\/Prague<\/li><li>2101-10-27 19:00/,
  );
  expect(await text(h, group, dm)).toContain("↻ Every week, until 2101-12-31");

  const form = await text(h, `${event}/edit`, dm);
  expect(form).toContain('<option value="FREQ=WEEKLY" selected>');
  expect(form).toContain('name="until" value="2101-12-31"');

  // Every 2 weeks, open-ended; then back to a single event.
  expect(
    (await submitEdit(h, event, dm, { ...NIGHT, repeat: "FREQ=WEEKLY;INTERVAL=2" })).status,
  ).toBe(303);
  const after = await text(h, event, dm);
  expect(after).toContain("↻ Every 2 weeks");
  expect(after).toContain("2101-11-03 19:00");
  expect(after).not.toContain("2101-10-27 19:00");
  expect(after).toContain("rrule: Every week, until 2101-12-31 → Every 2 weeks");
  expect((await submitEdit(h, event, dm, { ...NIGHT, repeat: "" })).status).toBe(303);
  const single = await text(h, event, dm);
  expect(single).not.toContain("↻");
  expect(single).toContain("rrule: Every 2 weeks → doesn&#39;t repeat");
});

it("a series is time: BUSY sees when it repeats, never what it is", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const gran = await join(h, dm, group, "gran@example.org", "view", "BUSY");
  const event = await createVia(h, dm, group, { ...NIGHT, repeat: "FREQ=MONTHLY" });
  await submitEdit(h, event, dm, { ...NIGHT, repeat: "FREQ=YEARLY" });
  const page = await text(h, event, gran);
  expect(page).toContain("↻ Every year");
  expect(page).toContain("2102-10-20 19:00");
  expect(page).toContain("rrule: Every month → Every year"); // in her history too
  expect(page).not.toContain("Sunken Keep");
});

it("a rule the presets don't cover is offered as itself, and kept on save", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group, { ...NIGHT, repeat: "FREQ=WEEKLY;BYDAY=TU,TH" });
  expect(await text(h, event, dm)).toContain("↻ Every week on Tuesday, Thursday");
  const form = await text(h, `${event}/edit`, dm);
  expect(form).toContain(
    '<option value="FREQ=WEEKLY;BYDAY=TU,TH" selected>Every week on Tuesday, Thursday</option>',
  );
  await submitEdit(h, event, dm, {
    ...NIGHT,
    title: "Renamed",
    repeat: "FREQ=WEEKLY;BYDAY=TU,TH",
  });
  const page = await text(h, event, dm);
  expect(page).toContain("Renamed");
  expect(page).toContain("↻ Every week on Tuesday, Thursday");

  // Cancelled: still says how it repeated, but lists no dates that won't happen.
  await act(h, event, dm, "cancel");
  const cancelled = await text(h, event, dm);
  expect(cancelled).toContain("↻ Every week on Tuesday, Thursday");
  expect(cancelled).not.toContain("Next:");
});

it("refuses an unsupported rule and a series that ends before it starts", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const bad = async (fields: Record<string, string>) => {
    const res = await h.app.request(
      `${group}/events`,
      post({ csrf: dm.csrf, ...NIGHT, ...fields }, dm.cookie),
    );
    expect(res.status).toBe(400);
    return res.text();
  };
  expect(await bad({ repeat: "FREQ=HOURLY" })).toContain("isn&#39;t supported");
  expect(await bad({ repeat: "FREQ=WEEKLY", until: "2101-10-01" })).toContain(
    "must end after its first date",
  );
});

// --- people on an existing event (DESIGN rc15, slice 2F) ------------------------------

const addVia = (h: H, who: Who, event: string, email: string, extra = {}) =>
  h.app.request(
    `${event}/people`,
    post({ csrf: who.csrf, email, editTier: "view", visibility: "FULL", ...extra }, who.cookie),
  );

it("an editor adds someone by email: they're mailed a link, and can then sign in to it", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  const before = h.sent.length;
  const res = await addVia(h, dm, event, "Newcomer@Example.org");
  expect(res.status).toBe(303);
  expect(h.sent.slice(before).map((m) => m.to)).toEqual(["newcomer@example.org"]);
  expect(h.sent.at(-1)?.text).toMatch(/https:\/\/whendowe\.example\/respond\?t=/);

  const page = await text(h, event, dm);
  // Never signed in, so no handle: a guest name, and never their address (§10 rc21).
  expect(page).toMatch(/<li>Guest \d{4}/);
  expect(page).toMatch(/dm added Guest \d{4}/);
  expect(page).not.toContain("newcomer@example.org");
  // Not in the group: joining an event is not joining its group.
  const newcomer = await signIn(h, "newcomer@example.org");
  expect((await get(h, event, newcomer)).status).toBe(200);
  expect((await get(h, group, newcomer)).status).toBe(404);
});

it("who was added is in the trail only for a tier that sees the people", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const petra = await join(h, dm, group, "petra@example.org", "view", "DETAILS");
  const event = await createVia(h, dm, group);
  expect((await addVia(h, dm, event, "secret-guest@example.org")).status).toBe(303);
  const page = await text(h, event, petra);
  expect(page).toContain("Session 12"); // she does see the event…
  expect(page).not.toContain("secret-guest"); // …but not who was added to it
  expect(page).not.toContain("Add someone by email");
});

it("only editors add or remove; the creator has no Remove button", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "propose", "FULL");
  const event = await createVia(h, dm, group);
  const asAnn = await text(h, event, ann);
  expect(asAnn).not.toContain("Add someone by email");
  expect(asAnn).not.toContain(">Remove<");
  expect((await addVia(h, ann, event, "x@example.org")).status).toBe(403);

  const asDm = await text(h, event, dm);
  // Remove buttons only: the Copy their link buttons (rc36) carry a person too.
  const removable = [
    ...asDm.matchAll(/name="person" value="([^"]+)" \/><button type="submit">Remove</g),
  ].map((m) => m[1]);
  expect(removable).toHaveLength(1); // Ann, not the DM
  const refused = await h.app.request(
    `${event}/people/remove`,
    post({ csrf: ann.csrf, person: removable[0] ?? "" }, ann.cookie),
  );
  expect(refused.status).toBe(403);
});

it("removing someone ends their access and their emailed link", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  await addVia(h, dm, event, "guest@example.org");
  const link = /https?:\/\/\S+\/respond\?t=\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "";
  expect((await h.app.request(new URL(link).pathname + new URL(link).search)).status).toBe(200);
  const guest = await signIn(h, "guest@example.org");

  const person =
    /name="person" value="([^"]+)" \/><button type="submit">Remove</.exec(
      await text(h, event, dm),
    )?.[1] ?? "";
  const res = await h.app.request(
    `${event}/people/remove`,
    post({ csrf: dm.csrf, person }, dm.cookie),
  );
  expect(res.status).toBe(303);
  expect((await get(h, event, guest)).status).toBe(404);
  expect((await h.app.request(new URL(link).pathname + new URL(link).search)).status).not.toBe(200);
  const after = await text(h, event, dm);
  // They signed in (and so chose a name) before being removed.
  expect(after).toContain("dm removed guest");
  expect(after).not.toContain("guest@example.org");
});

it("a failed mail keeps the person and says so; a resend then works at once", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  h.mailFailure.error = new MailCapReachedError({ daily: 1, monthly: 1 });
  const res = await addVia(h, dm, event, "unlucky@example.org");
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("Added unlucky@example.org, but couldn&#39;t email them");
  expect(await text(h, event, dm)).toMatch(/<li>Guest \d{4}/);

  h.mailFailure.error = null;
  const before = h.sent.length;
  await h.app.request(`${event}/links`, post({ csrf: dm.csrf }, dm.cookie));
  expect(h.sent.slice(before).map((m) => m.to)).toContain("unlucky@example.org");
});

it("an organizer whose own share of mail is used is told so, not that mail is down (rc37)", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  h.mailFailure.error = new SenderShareReachedError({ daily: 1, monthly: 1 }, "day", null);
  const res = await addVia(h, dm, event, "unlucky@example.org");
  expect(res.status).toBe(503);
  expect(await res.text()).toContain(
    "Added unlucky@example.org, but couldn&#39;t email them. You&#39;ve sent as much email today as one person can. You can send more tomorrow, or copy their links to send yourself.",
  );
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  const bulk = await sendLinks(h, dm, event);
  expect(bulk.status).toBe(503);
  expect(await bulk.text()).toMatch(
    /Sent to 0 people\. Couldn&#39;t send to \d+\. You&#39;ve sent as much email today as one person can\./,
  );
});

it("refuses a bad address, someone already there, a hidden tier, and no CSRF", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  expect((await addVia(h, dm, event, "not an address")).status).toBe(400);
  expect((await addVia(h, dm, event, "dm@example.org")).status).toBe(409);
  expect((await addVia(h, dm, event, "h@example.org", { visibility: "HIDDEN" })).status).toBe(400);
  expect(
    (
      await h.app.request(
        `${event}/people`,
        post({ email: "c@example.org", editTier: "view", visibility: "FULL" }, dm.cookie),
      )
    ).status,
  ).toBe(403);
});

it("in an event: your name there, and your address only if you show it (§10 rc21)", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);
  expect(await text(h, event, dm)).not.toContain("ann@example.org");
  expect(await text(h, event, ann)).toContain("You appear here as <strong>ann</strong>");

  expect((await act(h, event, ann, "me", { handle: "Annie", show_email: "1" })).status).toBe(303);
  const page = await text(h, event, dm);
  expect(page).toContain('<li>Annie <span class="muted">ann@example.org</span>');
  // The group is untouched: the event's setting is the event's.
  expect(await text(h, group, dm)).not.toContain("ann@example.org");

  const forged = await h.app.request(
    `${event}/me`,
    post({ csrf: "nope", handle: "X" }, ann.cookie),
  );
  expect(forged.status).toBe(403);
  // An account needs a name: empty is refused, and changes nothing.
  const empty = await h.app.request(
    ACCOUNT_PATH,
    post({ csrf: ann.csrf, handle: " " }, ann.cookie),
  );
  expect(empty.status).toBe(400);
  expect(await text(h, group, dm)).toContain("<li>ann");
});

it("leaving and deleting: a page that says what will happen, then a POST that does it (§10 rc21)", async () => {
  const h = await harness();
  const { mara, group, david } = await household(h);
  const event = await createVia(h, mara, group);

  // David leaves: the page says so, the POST needs his token, and afterwards he's gone
  // from it and the history says he left.
  const confirm = await text(h, `${event}/leave`, david);
  expect(confirm).toContain("Your answers, votes and notes here go");
  expect(confirm).not.toContain("deletes it");
  const forged = await h.app.request(`${event}/leave`, post({ csrf: "nope" }, david.cookie));
  expect(forged.status).toBe(403);
  expect((await act(h, event, david, "leave")).status).toBe(303);
  expect((await get(h, event, david)).status).toBe(404);
  expect(await text(h, event, mara)).toContain("david left");

  // Deleting: only editors, and not while it's still ahead and on.
  expect(await text(h, event, mara)).toContain("Delete it for everyone");
  const ahead = await get(h, `${event}/delete`, mara);
  expect(ahead.status).toBe(409);
  expect(await ahead.text()).toContain("Cancel it first");
  expect((await act(h, event, mara, "cancel")).status).toBe(303);
  expect(await text(h, `${event}/delete`, mara)).toContain("This can't be undone");
  expect((await act(h, event, mara, "delete")).status).toBe(303);
  expect((await get(h, event, mara)).status).toBe(404);

  // The last editor leaving is warned that it deletes the event for the others.
  const other = await createVia(h, mara, group);
  expect(await text(h, `${other}/leave`, mara)).toContain(
    "leaving deletes it for the 2 other people",
  );
});

it("your data: a download of your own, and deleting your account behind a typed address (§10 rc21/rc22)", async () => {
  const h = await harness();
  const { mara, group, david } = await household(h);
  const event = await createVia(h, mara, group);
  await act(h, event, david, "feedback", { note: "NOTE-42 bringing snacks" });

  const exported = await get(h, "/account/export", david);
  expect(exported.headers.get("content-disposition")).toContain("attachment");
  expect(exported.headers.get("cache-control")).toBe("no-store");
  const data = JSON.stringify(await exported.json());
  expect(data).toContain("david@example.org"); // his own address, in his own file
  expect(data).toContain("NOTE-42");
  expect(data).not.toContain("dm@example.org"); // nobody else's

  const page = await text(h, "/account/delete", david);
  expect(page).toContain("a former member");
  // A wrong address deletes nothing; neither does a missing token.
  const wrong = await h.app.request(
    "/account/delete",
    post({ csrf: david.csrf, confirm: "dm@example.org" }, david.cookie),
  );
  expect(wrong.status).toBe(400);
  const forged = await h.app.request(
    "/account/delete",
    post({ csrf: "nope", confirm: "david@example.org" }, david.cookie),
  );
  expect(forged.status).toBe(403);
  expect((await get(h, event, david)).status).toBe(200);

  const asked = await h.app.request(
    "/account/delete",
    post({ csrf: david.csrf, confirm: "David@Example.org" }, david.cookie),
  );
  expect(asked.status).toBe(200);
  // It waits 7 days (§10 rc22)…
  const day =
    /will be deleted on (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/.exec(await asked.text())?.[1] ?? "";
  expect(Date.parse(`${day.replace(" ", "T")}Z`) - Date.now()).toBeGreaterThan(
    6.9 * 24 * 3600 * 1000,
  );
  // …he's signed out everywhere at once: this cookie signs nobody in…
  expect((await get(h, event, david)).status).toBe(303);
  // …and nothing changed for anyone else.
  expect(await text(h, event, mara)).toContain("NOTE-42");

  // The email names the day and carries one link. Opening it acts on nothing.
  const mail = h.sent.at(-1);
  expect(mail?.to).toBe("david@example.org");
  expect(mail?.subject).toContain(`${day} UTC`);
  const link = new URL(
    /https:\/\/whendowe\.example\/account\/deletion\?t=\S+/.exec(mail?.text ?? "")?.[0] ??
      "http://x/",
  );
  const t = link.searchParams.get("t") ?? "";
  const opened = await h.app.request(`${link.pathname}${link.search}`);
  expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await opened.text()).toContain("Keep my account");
  expect(await text(h, event, mara)).toContain("NOTE-42");

  // "Delete it now": gone, and the link is spent.
  const done = await h.app.request("/account/deletion", post({ t, do: "now" }));
  expect(done.status).toBe(200);
  expect(await done.text()).toContain("Your account is deleted");
  expect((await h.app.request("/account/deletion", post({ t, do: "keep" }))).status).toBe(400);
  // His note went with him; nothing in the history needed a stand-in for him here.
  const after = await text(h, event, mara);
  expect(after).not.toContain("david");
  expect(after).not.toContain("NOTE-42");
});

it("the 7-day wait can be undone: from the emailed link, or signed in again (§10 rc22)", async () => {
  const h = await harness();
  const { mara, group, david } = await household(h);
  const event = await createVia(h, mara, group);
  const ask = (who: Who) =>
    h.app.request(
      "/account/delete",
      post({ csrf: who.csrf, confirm: "david@example.org" }, who.cookie),
    );
  const linkIn = () =>
    new URL(
      /https?:\/\/\S+\/account\/deletion\?t=\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ??
        "http://x/",
    ).searchParams.get("t") ?? "";

  expect((await ask(david)).status).toBe(200);
  const kept = await h.app.request("/account/deletion", post({ t: linkIn(), do: "keep" }));
  expect(await kept.text()).toContain("Your account is kept");

  // Signed in again: the same account, its events intact, and no banner.
  const back = await signIn(h, "david@example.org");
  expect(await text(h, event, back)).not.toContain("will be deleted");
  expect((await get(h, event, back)).status).toBe(200);

  // Asked again, then signed in during the wait: every page says when, with a keep button.
  // Signing in alone doesn't cancel it.
  expect((await ask(back)).status).toBe(200);
  const during = await signIn(h, "david@example.org");
  const home = await text(h, "/", during);
  expect(home).toMatch(/This account will be deleted on \d{4}-\d{2}-\d{2}/);
  expect(await text(h, "/account/delete", during)).toContain("Your account is being deleted");
  const keep = await h.app.request("/account/keep", post({ csrf: during.csrf }, during.cookie));
  expect(keep.status).toBe(303);
  expect(await text(h, "/", during)).not.toContain("will be deleted");
  // A forged keep does nothing (CSRF), and a made-up link works for nobody.
  expect((await h.app.request("/account/keep", post({ csrf: "nope" }, during.cookie))).status).toBe(
    403,
  );
  expect((await get(h, "/account/deletion?t=made-up")).status).toBe(400);
});

it("if the email can't go, the deletion still stands and the page says so (§10 rc22)", async () => {
  const h = await harness();
  const { david } = await household(h);
  h.mailFailure.error = new MailCapReachedError({ daily: 1, monthly: 1 });
  const asked = await h.app.request(
    "/account/delete",
    post({ csrf: david.csrf, confirm: "david@example.org" }, david.cookie),
  );
  h.mailFailure.error = null;
  expect(asked.status).toBe(200);
  const page = await asked.text();
  expect(page).toContain("will be deleted on");
  expect(page).toContain("We couldn't email you just now");
  const during = await signIn(h, "david@example.org");
  expect(await text(h, "/", during)).toContain("This account will be deleted on");
});

// --- retention (DESIGN §10 rc23) ----------------------------------------------------

async function retainOf(h: H, table: "canonical_event" | "person_group", path: string) {
  const id = path.split("/").at(-1) ?? "";
  const rows = await h.storage.query({
    sql:
      table === "canonical_event"
        ? "SELECT retain_days AS d, revision, updated_at FROM canonical_event WHERE id = ?"
        : "SELECT retain_days AS d FROM person_group WHERE id = ?",
    params: [id],
  });
  return rows[0];
}

it("a group's organizers choose its period; it applies to events made afterwards", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const before = await createVia(h, dm, group);
  expect(await text(h, group, dm)).toContain("kept for <strong>1 year</strong>");
  const res = await h.app.request(
    `${group}/retention`,
    post({ csrf: dm.csrf, retain_days: "90" }, dm.cookie),
  );
  expect(res.status).toBe(303);
  const page = await text(h, group, dm);
  expect(page).toContain("kept for <strong>3 months</strong>");
  expect(page).toContain("events already made keep theirs");
  // The form opens on the period in force, so saving it unchanged changes nothing.
  expect(page).toContain('<option value="90" selected>3 months</option>');
  expect(page).not.toContain('<option value="365" selected>');
  const after = await createVia(h, dm, group);
  expect((await retainOf(h, "canonical_event", after))?.d).toBe(90);
  // The earlier event keeps its own: its organizer might not have been able to edit it.
  expect((await retainOf(h, "canonical_event", before))?.d).toBe(365);
});

it("a member sees the group's period but can't change it", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const player = await join(h, dm, group, "player@example.org", "edit", "FULL");
  const page = await text(h, group, player);
  expect(page).toContain("kept for <strong>1 year</strong>");
  expect(page).not.toContain("/retention");
  const res = await h.app.request(
    `${group}/retention`,
    post({ csrf: player.csrf, retain_days: "30" }, player.cookie),
  );
  expect(res.status).toBe(403);
  expect((await retainOf(h, "person_group", group))?.d).toBe(365);
});

it("an event's editors change its period without editing it; others can't", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const viewer = await join(h, dm, group, "viewer@example.org", "view", "FULL");
  const proposer = await join(h, dm, group, "proposer@example.org", "propose", "FULL");
  const event = await createVia(h, dm, group);
  const was = await retainOf(h, "canonical_event", event);
  const res = await h.app.request(
    `${event}/retention`,
    post({ csrf: dm.csrf, retain_days: "730" }, dm.cookie),
  );
  expect(res.status).toBe(303);
  const now = await retainOf(h, "canonical_event", event);
  expect(now?.d).toBe(730);
  // Not a change to the event: same revision, same updated_at, no history line.
  expect(now?.revision).toBe(was?.revision);
  expect(now?.updated_at).toBe(was?.updated_at);
  expect(await text(h, event, dm)).not.toContain("dm changed");
  expect(await text(h, event, dm)).toContain("kept for <strong>2 years</strong>");
  for (const who of [viewer, proposer]) {
    const page = await text(h, event, who);
    expect(page).toContain("kept for <strong>2 years</strong>");
    expect(page).not.toContain("/retention");
    const refused = await h.app.request(
      `${event}/retention`,
      post({ csrf: who.csrf, retain_days: "30" }, who.cookie),
    );
    expect(refused.status).toBe(403);
  }
  expect((await retainOf(h, "canonical_event", event))?.d).toBe(730);
});

it("retention routes take only a listed period, with CSRF, from someone in it", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const event = await createVia(h, dm, group);
  const outsider = await signIn(h, "outsider@example.org");
  for (const path of [`${group}/retention`, `${event}/retention`]) {
    for (const days of ["0", "31", "3650", "1e3", "forever", ""]) {
      const res = await h.app.request(path, post({ csrf: dm.csrf, retain_days: days }, dm.cookie));
      expect(res.status).toBe(400);
    }
    const forged = await h.app.request(path, post({ csrf: "nope", retain_days: "30" }, dm.cookie));
    expect(forged.status).toBe(403);
    const outside = await h.app.request(
      path,
      post({ csrf: outsider.csrf, retain_days: "30" }, outsider.cookie),
    );
    expect(outside.status).toBe(404);
  }
  expect((await retainOf(h, "person_group", group))?.d).toBe(365);
  expect((await retainOf(h, "canonical_event", event))?.d).toBe(365);
});

// --- Copying someone's answer link (rc36) -----------------------------------------------

it("an editor copies a person's link instead of emailing it: fresh each time, shown once, with what it is", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);
  const page = await text(h, event, dm);
  expect(page).toContain(`action="${event}/people/link"`);
  expect(page).toContain("Copy their link");
  const annId = /name="person" value="([^"]+)" \/><button type="submit">Copy their link/.exec(
    page.slice(page.indexOf("ann")),
  )?.[1];
  if (annId === undefined) throw new Error("no copy button for ann");

  const before = h.sent.length;
  const copy = () =>
    h.app.request(`${event}/people/link`, post({ csrf: dm.csrf, person: annId }, dm.cookie));
  const res = await copy();
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  const body = await res.text();
  expect(body).toContain("This link answers as ann. Send it only to ann.");
  expect(body).toContain("It works for 14 days.");
  expect(body).toContain('aria-label="ann&#39;s link"');
  expect(body).toMatch(/<title>[^<]*Their link/);
  expect(body).toContain(`<a href="${event}">Back</a>`);
  expect(h.sent.length).toBe(before); // copied, not mailed
  const link = /https:\/\/[^\s"<]+\/respond\?t=[A-Za-z0-9_-]+/.exec(body)?.[0] ?? "";
  const path = new URL(link).pathname + new URL(link).search;
  expect(await (await h.app.request(path)).text()).toContain("Are you coming?");

  // Again at once: no resend throttle for a copy, and the first link stops working.
  const again =
    /https:\/\/[^\s"<]+\/respond\?t=[A-Za-z0-9_-]+/.exec(await (await copy()).text())?.[0] ?? "";
  expect(again).not.toBe(link);
  expect((await h.app.request(path)).status).toBe(404);

  // Ann can't copy anyone's link, and nobody without the CSRF token can.
  expect(await text(h, event, ann)).not.toContain("Copy their link");
  expect(
    (
      await h.app.request(
        `${event}/people/link`,
        post({ csrf: ann.csrf, person: annId }, ann.cookie),
      )
    ).status,
  ).toBe(403);
  expect(
    (await h.app.request(`${event}/people/link`, post({ person: annId }, dm.cookie))).status,
  ).toBe(403);
  const refused = await h.app.request(
    `${event}/people/link`,
    post({ csrf: ann.csrf, person: annId }, ann.cookie),
  );
  expect(await refused.text()).toContain("Only people who can edit it copy links");
  // Someone not on the event, or HIDDEN from it, can't even find it.
  const ghost = await join(h, dm, group, "ghost2@example.org", "view", "HIDDEN");
  const stranger = await signIn(h, "stranger@example.org");
  for (const who of [ghost, stranger])
    expect(
      (
        await h.app.request(
          `${event}/people/link`,
          post({ csrf: who.csrf, person: annId }, who.cookie),
        )
      ).status,
    ).toBe(404);
});

it("the pages say how an answer arrived (rc42): the emailed link, or the link someone copied", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "view", "FULL");
  await join(h, dm, group, "bob@example.org", "view", "FULL");
  const event = await createVia(h, dm, group);

  // Bob answers with the link he was mailed. Its page names nobody.
  await sendLinks(h, dm, event);
  const bobLink = linkFor(h, "bob@example.org");
  expect(await (await h.app.request(bobLink)).text()).not.toContain("gave you this link");
  await h.app.request(bobLink, post({ t: tokenOf(bobLink), attendance: "maybe" }));

  // Ann answers with a link the DM copied. Her page says who gave it to her.
  const annId = /name="person" value="([^"]+)" \/><button type="submit">Copy their link/.exec(
    (await text(h, event, dm)).split("ann")[1] ?? "",
  )?.[1];
  if (annId === undefined) throw new Error("no copy button for ann");
  const copied = await (
    await h.app.request(`${event}/people/link`, post({ csrf: dm.csrf, person: annId }, dm.cookie))
  ).text();
  const url = new URL(/https:\/\/[^\s"<]+\/respond\?t=[A-Za-z0-9_-]+/.exec(copied)?.[0] ?? "");
  const annLink = `${url.pathname}${url.search}`;
  expect(await (await h.app.request(annLink)).text()).toContain(
    "dm gave you this link, and your answer will say so.",
  );
  await h.app.request(
    annLink,
    post({ t: tokenOf(annLink), attendance: "going", note: "see you there" }),
  );

  // The DM, who copied it, reads "you"; Ann reads the DM's name, and "for you".
  const asDm = await text(h, event, dm);
  expect(asDm).toContain("· by the link you copied for them</span>");
  expect(asDm).toContain("· by their emailed link</span>");
  expect(asDm.match(/by the link you copied for them/g)).toHaveLength(2); // the answer and the note
  const asAnn = await text(h, event, ann);
  expect(asAnn).toContain("· by the link dm copied for you</span>");
  expect(asAnn).toContain("· by their emailed link</span>");

  // Signed in, an answer says nothing extra, and replaces the label on that answer only.
  await h.app.request(
    `${event}/attendance`,
    post({ csrf: ann.csrf, attendance: "maybe" }, ann.cookie),
  );
  expect((await text(h, event, dm)).match(/by the link you copied for them/g)).toHaveLength(1);
});

it("a cancelled event offers no link to copy; someone not on it gets none; HIDDEN has no button", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  await join(h, dm, group, "ghost@example.org", "view", "HIDDEN");
  const event = await createVia(h, dm, group);
  const annId = /name="person" value="([^"]+)" \/><button type="submit">Copy their link/.exec(
    await text(h, event, dm),
  )?.[1];
  const stranger = await h.app.request(
    `${event}/people/link`,
    post({ csrf: dm.csrf, person: "nobody" }, dm.cookie),
  );
  // Ann has a button; the HIDDEN member, who can't see the event at all, has none.
  expect((await text(h, event, dm)).match(/>Copy their link</g)).toHaveLength(1);
  expect(stranger.status).toBe(409);
  expect(await stranger.text()).toContain("They have nothing to answer here.");
  await h.app.request(`${event}/cancel`, post({ csrf: dm.csrf }, dm.cookie));
  expect(await text(h, event, dm)).not.toContain("Copy their link");
  expect(
    (
      await h.app.request(
        `${event}/people/link`,
        post({ csrf: dm.csrf, person: annId ?? "" }, dm.cookie),
      )
    ).status,
  ).toBe(409);
});
