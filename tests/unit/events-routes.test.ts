// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
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
  return { app, sent };
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
