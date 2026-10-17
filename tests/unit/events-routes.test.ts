// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { MailCapReachedError } from "../../src/mail/capped.js";
import type { MailMessage } from "../../src/mail/port.js";
import { createApp } from "../../src/web/app.js";
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
  return { app, sent, mailFailure };
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
  return { cookie, csrf: await csrfOf(h, cookie) };
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
  return { cookie, csrf: await csrfOf(h, cookie) };
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
  expect(page).toContain("dm@example.org changed");
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

async function startPoll(h: H, dm: Who, group: string, fields: Record<string, string> = POLL) {
  const res = await h.app.request(`${group}/polls`, post({ csrf: dm.csrf, ...fields }, dm.cookie));
  expect(res.status).toBe(303);
  return res.headers.get("location") ?? "";
}

async function revisionOnPage(h: H, event: string, who: Who): Promise<string> {
  return /name="revision" value="(\d+)"/.exec(await text(h, event, who))?.[1] ?? "";
}

it("a poll shows its options in time order, not a placeholder time, and no edit link", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const poll = await startPoll(h, dm, group);
  const page = await text(h, poll, dm);
  expect(page).toContain("Voting on a time.");
  expect(page.indexOf("2101-10-20 19:00")).toBeLessThan(page.indexOf("2101-10-22 18:00"));
  expect(page).not.toContain(`${poll}/edit`);
  expect(await text(h, group, dm)).toContain("voting on a time");
  expect((await get(h, `${poll}/edit`, dm)).status).toBe(409);
});

it("refuses a poll with one option, keeping what was typed", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const res = await h.app.request(
    `${group}/polls`,
    post({ csrf: dm.csrf, ...POLL, start_1: "", end_1: "" }, dm.cookie),
  );
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain("at least 2");
  expect(body).toContain('value="2101-10-22T18:00"');
});

it("players vote, change their mind, and the DM sees who said what", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "view", "FULL");
  const poll = await startPoll(h, dm, group);
  expect(
    (
      await h.app.request(
        `${poll}/votes`,
        post({ csrf: ann.csrf, slot_0: "no", slot_1: "yes" }, ann.cookie),
      )
    ).status,
  ).toBe(303);
  expect(
    (await h.app.request(`${poll}/votes`, post({ csrf: ann.csrf, slot_0: "ifneedbe" }, ann.cookie)))
      .status,
  ).toBe(303);
  expect(
    (
      await h.app.request(
        `${poll}/votes`,
        post({ csrf: dm.csrf, slot_0: "yes", slot_1: "yes" }, dm.cookie),
      )
    ).status,
  ).toBe(303);

  const page = await text(h, poll, dm);
  expect(page).toContain("ann@example.org: If need be"); // replaced, not duplicated
  expect(page).not.toContain("ann@example.org: No");
  expect(page).toContain("2 yes · 0 if need be · 0 no");
  expect(page).toContain("works for everyone"); // Thursday: both said yes
  // Ann's own answers come back checked.
  const annPage = await text(h, poll, ann);
  expect(annPage).toMatch(/name="slot_1" value="yes" checked/);
});

it("a DETAILS player sees the counts but not who voted what", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const petra = await join(h, dm, group, "petra@example.org", "view", "DETAILS");
  const poll = await startPoll(h, dm, group);
  await h.app.request(`${poll}/votes`, post({ csrf: dm.csrf, slot_0: "yes" }, dm.cookie));
  const page = await text(h, poll, petra);
  expect(page).toContain("1 yes · 0 if need be · 0 no");
  // No voter names. (The organizer's address DOES appear once — as the author in the
  // history, "… created it" — which is attribution, a separate policy question.)
  expect(page).not.toContain("dm@example.org: Yes");
  expect(page.split("dm@example.org").length - 1).toBe(1);
  expect(page).toContain("dm@example.org created it");
});

it("the DM confirms; the event is scheduled at that time, logged, and voting is closed", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "view", "FULL");
  const poll = await startPoll(h, dm, group);
  const revision = await revisionOnPage(h, poll, dm);
  // Slot 1 in time order is Saturday the 22nd.
  const res = await h.app.request(
    `${poll}/confirm`,
    post({ csrf: dm.csrf, revision, slot: "1" }, dm.cookie),
  );
  expect(res.status).toBe(303);

  const page = await text(h, poll, ann);
  expect(page).toContain("2101-10-22 18:00 – 22:00 · Europe/Prague");
  expect(page).not.toContain("Voting on a time.");
  expect(page).toContain("status: proposed → scheduled");
  const late = await h.app.request(
    `${poll}/votes`,
    post({ csrf: ann.csrf, slot_0: "yes" }, ann.cookie),
  );
  expect(late.status).toBe(409);
  expect(await late.text()).toContain("Voting has closed");
});

it("only an editor can confirm; a stale confirm button is refused", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const ann = await join(h, dm, group, "ann@example.org", "view", "FULL");
  const poll = await startPoll(h, dm, group);
  expect(await text(h, poll, ann)).not.toContain("/confirm");
  expect(
    (
      await h.app.request(
        `${poll}/confirm`,
        post({ csrf: ann.csrf, revision: "1", slot: "0" }, ann.cookie),
      )
    ).status,
  ).toBe(403);

  // Two tabs: the first confirms Thursday, the second (same page) tries Saturday.
  const revision = await revisionOnPage(h, poll, dm);
  await h.app.request(`${poll}/confirm`, post({ csrf: dm.csrf, revision, slot: "0" }, dm.cookie));
  const second = await h.app.request(
    `${poll}/confirm`,
    post({ csrf: dm.csrf, revision, slot: "1" }, dm.cookie),
  );
  expect(second.status).toBe(409);
  expect(await text(h, poll, dm)).toContain("2101-10-20 19:00");
});

it("poll actions require CSRF and membership", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  const poll = await startPoll(h, dm, group);
  const stranger = await signIn(h, "stranger@example.org");
  expect((await h.app.request(`${group}/polls`, post({ ...POLL }, dm.cookie))).status).toBe(403);
  expect((await h.app.request(`${poll}/votes`, post({ slot_0: "yes" }, dm.cookie))).status).toBe(
    403,
  );
  expect(
    (await h.app.request(`${poll}/confirm`, post({ revision: "1", slot: "0" }, dm.cookie))).status,
  ).toBe(403);
  expect(
    (
      await h.app.request(
        `${poll}/votes`,
        post({ csrf: stranger.csrf, slot_0: "yes" }, stranger.cookie),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await h.app.request(
        `${poll}/confirm`,
        post({ csrf: stranger.csrf, revision: "1", slot: "0" }, stranger.cookie),
      )
    ).status,
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

it("an organizer emails vote links: everyone but themself, and no title in a BUSY inbox", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  await join(h, dm, group, "grandma@example.org", "view", "BUSY");
  const poll = await startPoll(h, dm, group);
  const before = h.sent.length;
  const res = await sendLinks(h, dm, poll);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Sent to 2 people.");
  const mails = h.sent.slice(before);
  expect(mails.map((m) => m.to).sort()).toEqual(["ann@example.org", "grandma@example.org"]);
  const ann = mails.find((m) => m.to === "ann@example.org");
  const grandma = mails.find((m) => m.to === "grandma@example.org");
  expect(ann?.subject).toContain("Session 13");
  expect(`${grandma?.subject} ${grandma?.text}`).not.toContain("Session 13");
});

it("a player votes from the link with no account: GET changes nothing, POST saves, nobody is signed in", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  const poll = await startPoll(h, dm, group);
  await sendLinks(h, dm, poll);
  const link = linkFor(h, "ann@example.org");

  // No cookie at all: the link is the identity. Opening it (twice, like a mail
  // scanner) records nothing and sets no session.
  for (let i = 0; i < 2; i++) {
    const page = await h.app.request(link);
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("Which times work for you?");
  }
  expect(await text(h, poll, dm)).toContain("0 yes · 0 if need be · 0 no");

  const res = await h.app.request(
    "/respond",
    post({ t: tokenOf(link), slot_0: "yes", slot_1: "no", note: "Thursday's bad for me" }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(await (await h.app.request(res.headers.get("location") ?? "")).text()).toContain(
    "your answer is saved",
  );

  const dmPage = await text(h, poll, dm);
  expect(dmPage).toContain("ann@example.org: Yes");
  // The note is user text: escaped, inside its own element.
  expect(dmPage).toMatch(/ann@example\.org: <span[^>]*>Thursday&#39;s bad for me<\/span>/);
});

it("a response link answers only for its own event and person — and a dead link says so", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  const poll = await startPoll(h, dm, group);
  await sendLinks(h, dm, poll);
  const t = tokenOf(linkFor(h, "ann@example.org"));
  // The link can't be turned on another event by path or body: there is no event id to send.
  const other = await startPoll(h, dm, group, { ...POLL, title: "Another" });
  await h.app.request("/respond", post({ t, slot_0: "yes" }));
  expect(await text(h, other, dm)).toContain("0 yes · 0 if need be · 0 no");
  for (const bad of ["/respond?t=not-a-token", "/respond", `/respond?t=${t}x`]) {
    const res = await h.app.request(bad);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This link no longer works");
  }
  expect((await h.app.request("/respond", post({ t: "nope", slot_0: "yes" }))).status).toBe(404);
});

it("after the time is picked, a vote link says so and refuses a late vote", async () => {
  const h = await harness();
  const { dm, group } = await setup(h);
  await join(h, dm, group, "ann@example.org", "view", "FULL");
  const poll = await startPoll(h, dm, group);
  await sendLinks(h, dm, poll);
  const link = linkFor(h, "ann@example.org");
  const revision = await revisionOnPage(h, poll, dm);
  await h.app.request(`${poll}/confirm`, post({ csrf: dm.csrf, revision, slot: "0" }, dm.cookie));
  expect(await (await h.app.request(link)).text()).toContain("Voting has closed.");
  expect((await h.app.request("/respond", post({ t: tokenOf(link), slot_0: "no" }))).status).toBe(
    409,
  );
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
  expect(dmPage).toContain("ann@example.org: Maybe");
  expect(dmPage).toContain("ann@example.org: <span");
  expect(dmPage).toContain("NOTE-7: running late");
  const petraPage = await text(h, event, petra);
  expect(petraPage).toContain("0 going · 1 maybe · 0 can't make it"); // literal template text
  expect(petraPage).not.toContain("ann@example.org");
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
  expect(page).toContain("ann@example.org: Going");
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
  const id = new RegExp(
    `${email.replace(/\./g, "\\.")}\\s*<select name="req_([0-9a-f-]{36})"`,
  ).exec(formPage)?.[1];
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
  expect(await text(h, event, mara)).toContain("david@example.org: must agree — not answered yet");
  expect((await get(h, event, petra)).status).toBe(404); // US-3: scheduled reality only
  expect(await text(h, group, petra)).not.toContain(event);
  const davidPage = await text(h, event, david);
  expect(davidPage).toContain("You're asked to agree to this.");

  expect((await act(h, event, david, "answer", { answer: "accept" })).status).toBe(303);
  expect((await get(h, event, petra)).status).toBe(200);
  const after = await text(h, event, mara);
  expect(after).not.toContain("waiting for agreement");
  expect(after).toContain("david@example.org: must agree — agreed ✓");
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
  expect(page).toMatch(/david@example\.org changed<ul><li>status: proposed → declined/);
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
    /david@example\.org: please acknowledge — seen ✓ <span class="muted">\d{4}-/,
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
  expect(await text(h, event, mara)).toContain(
    "david@example.org: please acknowledge — asked to look again",
  );
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
  expect(page).toContain("petra@example.org: please acknowledge");
  expect(page).not.toContain("david@example.org: please acknowledge");
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
    ["david@example.org", 'dm@example.org asks you to agree: "Session 12: the Sunken Keep"'],
  ]);
  const link = linkFor(h, "david@example.org");
  expect(await (await h.app.request(link)).text()).toContain("Do you agree?");
  expect(
    (await h.app.request("/respond", post({ t: tokenOf(link), decision: "accept" }))).status,
  ).toBe(303);
  expect(await (await h.app.request(link)).text()).toContain("It's settled.");
  expect(await text(h, proposal, mara)).toContain("david@example.org: must agree — agreed ✓");

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
  expect(await text(h, fyi, mara)).toContain("david@example.org: please acknowledge — seen ✓");
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
  expect(before).toContain("<strong>ann@example.org</strong> proposes:");
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
  expect(after).toContain("dm@example.org accepted ann@example.org&#39;s proposal");
  expect(await text(h, event, ann)).toContain("Your proposal was accepted by dm@example.org.");
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
  expect(await text(h, event, ann)).toContain("Your proposal was turned down by dm@example.org.");
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
