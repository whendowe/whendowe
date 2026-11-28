// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { UNAVAILABLE, VERIFY_NEEDS_MAIL } from "../../src/people/capability.js";
import { findGroupForMember, setGroupDefaultVerified } from "../../src/people/group.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { shellSignInLink } from "../../src/people/setup.js";
import { createApp } from "../../src/web/app.js";
import { ASK_PATH } from "../../src/web/routes/ask.js";
import { CONFIRM_PATH } from "../../src/web/routes/auth.js";
import { EVENTS_PATH } from "../../src/web/routes/events.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { loadMigrationSql } from "../conftest.js";

// An instance that sends no email (DESIGN §10 rc60 *Running without email*), part two: an
// answer or vote link is copied in place of emailed, asking holds nothing to send, and
// verifying is unavailable, since a receipt in the person's own inbox is what it rests on.
// The mail port records, so "nothing was sent" is something each test can see.

/** How an interpolated string reads on the page: html`` escapes its apostrophes. */
const esc = (s: string) => s.replaceAll("'", "&#39;");

const COPY_INSTEAD =
  "This instance doesn't send email. Copy each person's own link instead, and send it to them.";

const COUNT = {
  response_token: "SELECT COUNT(*) AS n FROM response_token",
  plan_vote_token: "SELECT COUNT(*) AS n FROM plan_vote_token",
  held_action: "SELECT COUNT(*) AS n FROM held_action",
} as const;

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
  const rows = async (table: keyof typeof COUNT) =>
    (await storage.query({ sql: COUNT[table], params: [] }))[0]?.n;
  return { app, storage, sent, now, rows };
}

type H = Awaited<ReturnType<typeof harness>>;
interface Who {
  readonly cookie: string;
  readonly csrf: string;
}

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

/** Signed in the way an instance without mail signs someone in: a link from its shell. */
async function signIn(h: H, email: string): Promise<Who> {
  await findOrCreatePerson(h.storage, email, { now: h.now() });
  const link = await shellSignInLink(h.storage, email, { now: h.now() });
  if (!link.ok) throw new Error(link.reason);
  const cookie = cookieOf(await h.app.request(CONFIRM_PATH, post({ t: link.token })));
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "" };
}

/** Someone's shown name on an event, read off the button that removes them. */
function participantShown(page: string, personId: string): string {
  const name = new RegExp(
    `<li>([^<]+?) <form method="post" action="[^"]+/people/remove" style="display:inline"><input type="hidden" name="csrf" value="[^"]+" /><input type="hidden" name="person" value="${personId}" />`,
  ).exec(page)?.[1];
  if (name === undefined) throw new Error("no Remove for them");
  return name;
}

/** A thread member's shown name, read off the button that copies their link. */
function memberShown(page: string, personId: string): string {
  const name = new RegExp(
    `<strong>([^<]+)</strong></span><form method="post" action="[^"]+/links/copy"><input type="hidden" name="csrf" value="[^"]+" /><input type="hidden" name="person" value="${personId}" />`,
  ).exec(page)?.[1];
  if (name === undefined) throw new Error("no Copy link for them");
  return name;
}

const text = async (h: H, path: string, who: Who) =>
  (await h.app.request(path, { headers: { cookie: who.cookie } })).text();

const NIGHT = {
  title: "Board games",
  start: "2101-10-20T19:00",
  end: "2101-10-20T23:00",
  tzid: "Europe/Prague",
};

/** An event Mara made with Ann on it, by address. */
async function eventWithAnn(h: H) {
  const mara = await signIn(h, "mara@example.org");
  const made = await h.app.request(
    EVENTS_PATH,
    post({ csrf: mara.csrf, ...NIGHT, email: "ann@example.org" }, mara.cookie),
  );
  expect(made.status).toBe(303);
  const event = made.headers.get("location") ?? "";
  const annId = (await findOrCreatePerson(h.storage, "ann@example.org", { now: h.now() })).id;
  return { mara, event, annId };
}

/** A question Mara asked Ann and Bo on the Ask page, and the thread it made. */
async function askedThread(h: H) {
  const mara = await signIn(h, "mara@example.org");
  const draft =
    (await h.app.request(ASK_PATH, post({ csrf: mara.csrf }, mara.cookie))).headers.get(
      "location",
    ) ?? "";
  const fields = {
    csrf: mara.csrf,
    title: "Pizza",
    tzid: "Europe/Prague",
    o0e0day: "2101-12-17",
    o0e0from: "19:00",
    o0e0to: "21:00",
    o1e0day: "2101-12-18",
    o1e0from: "19:00",
    o1e0to: "21:00",
    new_from: "19:00",
    new_hours: "2",
    email: "ann@example.org bo@example.org",
  };
  await h.app.request(draft, post({ ...fields, act: "save" }, mara.cookie));
  const page = await text(h, draft, mara);
  // A question that can't be asked yet is drawn again, as the page is drawn.
  const refusedRes = await h.app.request(
    draft,
    post({ ...fields, o0e0day: "", act: "ask" }, mara.cookie),
  );
  expect(refusedRes.status).toBe(400);
  const refused = await refusedRes.text();
  const asked = await h.app.request(draft, post({ ...fields, act: "ask" }, mara.cookie));
  expect(asked.status).toBe(303);
  const location = asked.headers.get("location") ?? "";
  const thread = location.split("#")[0] ?? "";
  return { mara, page, refused, location, thread };
}

it("an event's answer links are copied: no Email button, adding emails nobody, and its POST sends nothing", async () => {
  const h = await harness();
  const { mara, event, annId } = await eventWithAnn(h);
  const page = await text(h, event, mara);
  expect(page).not.toContain("Email everyone a link");
  expect(page).not.toContain(`action="${event}/links"`);
  expect(page).toContain("Copy their link");
  expect(page).toContain("Each can answer by a link you copy for them, no account needed.");
  expect(page).not.toContain("Each gets an email");
  expect(page).toContain('<button type="submit">Add them</button>');

  const links = await h.app.request(`${event}/links`, post({ csrf: mara.csrf }, mara.cookie));
  expect(links.status).toBe(409);
  expect(await links.text()).toContain(esc(COPY_INSTEAD));
  expect(await h.rows("response_token")).toBe(0);

  const added = await h.app.request(
    `${event}/people`,
    post({ csrf: mara.csrf, email: "bo@example.org" }, mara.cookie),
  );
  expect(added.status).toBe(200);
  expect(await added.text()).toContain(
    "Added bo@example.org. To ask them, copy their link below and send it to them.",
  );
  expect(await h.rows("response_token")).toBe(0);
  const boId = (await findOrCreatePerson(h.storage, "bo@example.org", { now: h.now() })).id;
  expect(await text(h, event, mara)).toContain(
    `<input type="hidden" name="person" value="${boId}" /><button type="submit">Copy their link</button>`,
  );

  // The link is still there to copy.
  const copied = await h.app.request(
    `${event}/people/link`,
    post({ csrf: mara.csrf, person: annId }, mara.cookie),
  );
  expect(copied.status).toBe(200);
  expect(await copied.text()).toMatch(/https:\/\/whendowe\.example\/respond\?t=/);
  expect(h.sent).toEqual([]);
});

it("someone who takes answers only from their own email answers signed in, said so", async () => {
  const h = await harness();
  const { mara, event, annId } = await eventWithAnn(h);
  const name = participantShown(await text(h, event, mara), annId);
  const ann = await signIn(h, "ann@example.org");
  await h.app.request(`${event}/own-answers`, post({ csrf: ann.csrf, on: "1" }, ann.cookie));
  expect(await text(h, event, mara)).toContain(
    '<span class="muted">· answers only signed in</span>',
  );
  const refused = await h.app.request(
    `${event}/people/link`,
    post({ csrf: mara.csrf, person: annId }, mara.cookie),
  );
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain(
    esc(
      `${name} takes answers only from their own email, and this instance doesn't send email, so they answer signed in.`,
    ),
  );
});

it("with mail, an event still emails its links and the own-email line is as it was", async () => {
  const h = await harness(false);
  const { mara, event, annId } = await eventWithAnn(h);
  const page = await text(h, event, mara);
  expect(page).toContain("Email everyone a link to say if they&#39;re coming");
  expect(page).toContain("Each gets an email with a link to answer, no account needed.");
  expect(page).toContain('<button type="submit">Add and email them a link</button>');
  expect(page).not.toContain("Each can answer by a link you copy");

  const added = await h.app.request(
    `${event}/people`,
    post({ csrf: mara.csrf, email: "bo@example.org" }, mara.cookie),
  );
  expect(added.status).toBe(303);
  expect(h.sent.map((m) => m.to)).toEqual(["bo@example.org"]);
  const links = await h.app.request(`${event}/links`, post({ csrf: mara.csrf }, mara.cookie));
  expect(links.status).toBe(200);
  expect(await links.text()).toContain("Sent to 1 person.");

  const name = participantShown(await text(h, event, mara), annId);
  const ann = await signIn(h, "ann@example.org");
  await h.app.request(`${event}/own-answers`, post({ csrf: ann.csrf, on: "1" }, ann.cookie));
  expect(await text(h, event, mara)).toContain(
    '<span class="muted">· takes answers only from their own email</span>',
  );
  expect(
    await (
      await h.app.request(
        `${event}/people/link`,
        post({ csrf: mara.csrf, person: annId }, mara.cookie),
      )
    ).text(),
  ).toContain(
    esc(
      `${name} takes answers only from their own email. You can still send them their link by email.`,
    ),
  );
});

it("asking holds nothing to send and lands on each person's link to copy", async () => {
  const h = await harness();
  const { mara, page, refused: redrawn, location, thread } = await askedThread(h);
  expect(page).toContain(">Ask 2 people</button>");
  expect(redrawn).toContain(">Ask 2 people</button>");
  expect(page).toContain("Asking puts to 2 people one question:");
  expect(page).toContain(
    esc(
      "This instance doesn't send email: after asking, copy each person's own link and send it to them.",
    ),
  );
  expect(page).not.toContain("Asking emails");
  expect(location).toBe(`${thread}#links`);
  expect(await h.rows("held_action")).toBe(0);

  const tpage = await text(h, thread, mara);
  expect(tpage).not.toContain("Email vote links");
  expect(tpage).not.toContain("Emailing vote links");
  expect(tpage).toContain(
    esc(
      "Each answers as that person. This instance doesn't send email: copy each one and send it to them.",
    ),
  );
  const annId = (await findOrCreatePerson(h.storage, "ann@example.org", { now: h.now() })).id;
  const name = memberShown(tpage, annId);
  expect(tpage).toContain(`Copy ${name}'s link`);
  expect(tpage).toContain("Everyone in it sees the result here. You'll have a minute to undo it.");
  expect(tpage).not.toContain("Choosing emails");

  const links = await h.app.request(`${thread}/links`, post({ csrf: mara.csrf }, mara.cookie));
  expect(links.status).toBe(409);
  expect(await links.text()).toContain(esc(COPY_INSTEAD));
  expect(await h.rows("held_action")).toBe(0);

  const copied = await h.app.request(
    `${thread}/links/copy`,
    post({ csrf: mara.csrf, person: annId }, mara.cookie),
  );
  expect(copied.status).toBe(200);
  expect(await copied.text()).toMatch(/https:\/\/whendowe\.example\/vote\?t=/);
  expect(await h.rows("plan_vote_token")).toBe(1); // the copied one, and none to email

  const ann = await signIn(h, "ann@example.org");
  await h.app.request(`${thread}/own-answers`, post({ csrf: ann.csrf, on: "1" }, ann.cookie));
  expect(await text(h, thread, mara)).toContain(
    `<strong>${name}</strong> <span class="muted">· answers only signed in</span>`,
  );
  const refused = await h.app.request(
    `${thread}/links/copy`,
    post({ csrf: mara.csrf, person: annId }, mara.cookie),
  );
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain(
    esc(
      `${name} takes answers only from their own email, and this instance doesn't send email, so they answer signed in.`,
    ),
  );

  // Accepting a plan says where the result is, not that it emails it.
  const plan = /href="(\/plans\/[^"/]+\/p\/[^"]+)"/.exec(tpage)?.[1] ?? "";
  const confirm = await text(h, `${plan}?confirm=1`, mara);
  expect(confirm).toContain(
    "Everyone in it sees the result here. You'll have a minute to undo it.",
  );
  expect(confirm).toContain('<button class="primary" type="submit">Yes, accept it</button>');
  expect(h.sent).toEqual([]);
});

it("with mail, asking holds the vote links and the thread offers to email them", async () => {
  const h = await harness(false);
  const { mara, page, refused: redrawn, location, thread } = await askedThread(h);
  expect(page).toContain(">Ask 2 people by email</button>");
  expect(redrawn).toContain(">Ask 2 people by email</button>");
  expect(page).toContain("Asking emails 2 people one question:");
  expect(page).toContain("Asking emails them a minute later; until then you can undo it.");
  expect(location).toBe(thread);
  expect(await h.rows("held_action")).toBe(1);
  const tpage = await text(h, thread, mara);
  expect(tpage).toContain("Copy one to send in a chat instead of by email.");
  expect(tpage).toContain("Choosing emails everyone in it the result.");
  const plan = /href="(\/plans\/[^"/]+\/p\/[^"]+)"/.exec(tpage)?.[1] ?? "";
  const confirm = await text(h, `${plan}?confirm=1`, mara);
  expect(confirm).toContain("Accepting emails everyone in it the result.");
  expect(confirm).toContain("Yes, accept and email everyone");

  const annId = (await findOrCreatePerson(h.storage, "ann@example.org", { now: h.now() })).id;
  const name = memberShown(tpage, annId);
  const ann = await signIn(h, "ann@example.org");
  await h.app.request(`${thread}/own-answers`, post({ csrf: ann.csrf, on: "1" }, ann.cookie));
  expect(await text(h, thread, mara)).toContain(
    `<strong>${name}</strong> <span class="muted">· takes answers only from their own email</span>`,
  );
  expect(
    await (
      await h.app.request(
        `${thread}/links/copy`,
        post({ csrf: mara.csrf, person: annId }, mara.cookie),
      )
    ).text(),
  ).toContain(
    `${name} takes answers only from their own email. You can still email them their link.`,
  );
});

it("verifying is unavailable everywhere it is turned on, and its POSTs are refused", async () => {
  const h = await harness();
  const { mara, event } = await eventWithAnn(h);
  const disabled = `<button type="button" disabled>Verify answers here</button> <span class="muted">${esc(VERIFY_NEEDS_MAIL)}</span>`;
  expect(await text(h, event, mara)).toContain(disabled);
  const verify = await h.app.request(`${event}/verify`, post({ csrf: mara.csrf }, mara.cookie));
  expect(verify.status).toBe(403);
  expect(await verify.text()).toContain(esc(VERIFY_NEEDS_MAIL));

  const box = `<input type="checkbox" name="verified" disabled /> Verified: answers count only from each person's own email, or signed in</label><br />
  <span class="muted">${esc(VERIFY_NEEDS_MAIL)}</span>`;
  expect(await text(h, `${EVENTS_PATH}/new`, mara)).toContain(box);
  const made = await h.app.request(
    EVENTS_PATH,
    post({ csrf: mara.csrf, ...NIGHT, verified: "on" }, mara.cookie),
  );
  expect(made.status).toBe(403);
  expect(await made.text()).toContain(esc(VERIFY_NEEDS_MAIL));

  const group =
    (
      await h.app.request(GROUPS_PATH, post({ csrf: mara.csrf, name: "Jam" }, mara.cookie))
    ).headers.get("location") ?? "";
  expect(await text(h, group, mara)).toContain(
    `<input type="checkbox" name="on" disabled /> Verify answers on new events from this group</label><br />
  <span class="muted">${esc(VERIFY_NEEDS_MAIL)}</span>`,
  );
  const on = await h.app.request(
    `${group}/verified`,
    post({ csrf: mara.csrf, on: "1" }, mara.cookie),
  );
  expect(on.status).toBe(403);
  const onText = await on.text();
  expect(onText).toContain("<title>Not allowed · WhenDoWe</title>");
  expect(onText).toContain(esc(VERIFY_NEEDS_MAIL));
  // Turning it off is never refused.
  expect(
    (await h.app.request(`${group}/verified`, post({ csrf: mara.csrf }, mara.cookie))).status,
  ).toBe(303);
  // A default turned on before (mail on then) can still be turned off.
  const maraId = (await findOrCreatePerson(h.storage, "mara@example.org", { now: h.now() })).id;
  const membership = await findGroupForMember(h.storage, group.split("/").at(-1) ?? "", maraId);
  if (membership === null) throw new Error("no group");
  await setGroupDefaultVerified(h.storage, membership, true);
  expect(await text(h, group, mara)).toContain(
    '<input type="checkbox" name="on" value="1" checked /> Verify answers on new events from this group</label> <button type="submit">Save</button>',
  );

  const { thread } = await askedThread(h);
  expect(await text(h, thread, mara)).toContain(disabled);
  const tverify = await h.app.request(`${thread}/verify`, post({ csrf: mara.csrf }, mara.cookie));
  expect(tverify.status).toBe(403);
  expect(await tverify.text()).toContain(esc(VERIFY_NEEDS_MAIL));
  expect(h.sent).toEqual([]);
  // Not the capability's line: it is this instance, not this account.
  expect(await text(h, event, mara)).not.toContain(esc(UNAVAILABLE.verify));
});

it("with mail, verifying is offered as before", async () => {
  const h = await harness(false);
  const { mara, event } = await eventWithAnn(h);
  expect(await text(h, event, mara)).toContain("<summary>Verify answers here</summary>");
  expect(await text(h, `${EVENTS_PATH}/new`, mara)).toContain(
    '<input type="checkbox" name="verified" /> Verified',
  );
  const group =
    (
      await h.app.request(GROUPS_PATH, post({ csrf: mara.csrf, name: "Jam" }, mara.cookie))
    ).headers.get("location") ?? "";
  expect(await text(h, group, mara)).toContain(
    '<input type="checkbox" name="on" value="1" /> Verify answers on new events from this group</label>',
  );
  const { thread } = await askedThread(h);
  expect(await text(h, thread, mara)).toContain("<summary>Verify answers here</summary>");
});
