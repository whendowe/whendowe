// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { findPersonByEmail } from "../../src/people/person.js";
import { EVENTS_PATH, POLLS_PATH } from "../../src/web/routes/events.js";
import { GROUPS_PATH, INVITE_PATH } from "../../src/web/routes/groups.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import {
  addAccount,
  type Browser,
  browser,
  home,
  nameActive,
  post,
} from "../property/one-browser.js";

// An event names its people directly (DESIGN §10 rc15): by email, each on their own
// terms, with a group only a way to fill the list.

const NIGHT = {
  title: "Board games",
  location: "",
  description: "",
  start: "2101-11-20T19:00",
  end: "2101-11-20T22:00",
  tzid: "Europe/Prague",
};

async function create(b: Browser, path: string, fields: Record<string, string>) {
  return b.request(path, post({ csrf: (await home(b)).csrf, ...fields }));
}

const participants = async (b: Browser, event: string) =>
  /<h2>Taking part<\/h2><ul>(.*?)<\/ul>/s.exec(await (await b.request(event)).text())?.[1] ?? "";

it("creates an event for people by email alone, each on their own terms", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  await nameActive(b, "ann@example.org");
  const form = await (await b.request(`${EVENTS_PATH}/new`)).text();
  expect(form).toContain('name="email_0"');
  expect(form).toContain('name="ask_0"');

  const res = await create(b, EVENTS_PATH, {
    ...NIGHT,
    email_0: "Bob@Example.org",
    tier_0: "edit",
    vis_0: "FULL",
    email_1: "cat@example.org",
    tier_1: "view",
    vis_1: "BUSY",
    email_2: "ann@example.org", // the creator: stays edit + FULL, not demoted by a row
    tier_2: "view",
    vis_2: "BUSY",
  });
  expect(res.status).toBe(303);
  const event = res.headers.get("location") ?? "";
  const people = await participants(b, event);
  // Ann by her handle; Bob and Cat have never signed in, so they show as guests — and
  // nobody's address appears (DESIGN §10 rc21).
  expect(people).toMatch(/ann <span class="muted">· can edit/);
  expect(people).toMatch(/Guest \d{4} <span class="muted">· can edit/);
  expect(people.match(/<li>/g)).toHaveLength(3);
  expect(people).not.toContain("@example.org");

  await addAccount(b, "cat@example.org"); // Cat, in no group, sees it at her tier
  const asCat = await (await b.request(event)).text();
  expect(asCat).not.toContain("Board games");
  expect((await home(b)).text).toContain(">Busy</a>");
});

it("asking someone to agree by email makes it a proposal they can answer", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  const res = await create(b, EVENTS_PATH, {
    ...NIGHT,
    email_0: "bob@example.org",
    tier_0: "view",
    vis_0: "FULL",
    ask_0: "accept",
  });
  const event = res.headers.get("location") ?? "";
  expect(await (await b.request(event)).text()).toContain("waiting for agreement");
});

it("a refused form keeps what was typed and creates no one", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  for (const fields of [
    { ...NIGHT, email_0: "good@example.org", email_1: "not an address" },
    { ...NIGHT, end: "2101-11-20T18:00", email_0: "good@example.org" }, // ends before it starts
  ]) {
    const res = await create(b, EVENTS_PATH, fields);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('value="good@example.org"');
    expect(await findPersonByEmail(b.storage, "good@example.org")).toBeNull();
  }
  // A poll with one option is refused the same way.
  const poll = await create(b, POLLS_PATH, {
    title: "When?",
    tzid: "Europe/Prague",
    start_0: "2101-11-10T19:00",
    end_0: "2101-11-10T22:00",
    email_0: "good@example.org",
  });
  expect(poll.status).toBe(400);
  expect(await findPersonByEmail(b.storage, "good@example.org")).toBeNull();
  expect(await (await create(b, EVENTS_PATH, { ...NIGHT, email_0: "x y" })).text()).toContain(
    "Not an email address: x y",
  );
});

it("from a group: its members are copied in, and anyone else can be added by email", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  const made = await create(b, GROUPS_PATH, { name: "Table" });
  const group = made.headers.get("location") ?? "";
  await create(b, `${group}/invites`, {
    email: "dan@example.org",
    editTier: "view",
    visibility: "FULL",
  });
  const t = new URL(
    /https?:\/\/\S+\/invite\?t=\S+/.exec(b.sent.at(-1)?.text ?? "")?.[0] ?? "",
  ).searchParams.get("t");
  await b.request(INVITE_PATH, post({ t: t ?? "" })); // Dan joins, here
  await nameActive(b, "dan@example.org");
  const h = await home(b);
  const annSession = h.others[0]?.sessionId ?? "";
  await b.request("/auth/switch", post({ csrf: h.csrf, session: annSession, back: "/" }));

  const form = await (await b.request(`${group}/events/new`)).text();
  expect(form).toContain("Everyone in Table takes part");
  const res = await create(b, `${group}/events`, {
    ...NIGHT,
    email_0: "eve@example.org",
    tier_0: "view",
    vis_0: "DETAILS",
    email_1: "dan@example.org", // a member named here: these terms win
    tier_1: "edit",
    vis_1: "FULL",
  });
  const event = res.headers.get("location") ?? "";
  const people = await participants(b, event);
  expect(people).toMatch(/dan <span class="muted">· can edit/);
  expect(people).toMatch(/<li>Guest \d{4}/); // Eve, who has never signed in
  expect(people).not.toContain("@example.org");

  // Eve is on the event, not in the group: joining an event is not joining a group.
  await addAccount(b, "eve@example.org");
  expect((await b.request(event)).status).toBe(200);
  expect((await b.request(group)).status).toBe(404);
});

it("a poll for people by email: a thread they vote in, and between two the second yes agrees it", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  const form = await (await b.request(`${POLLS_PATH}/new`)).text();
  expect(form).toContain('name="email_0"');
  expect(form).toContain('aria-label="Email 1"');
  expect(form).toContain("Who are you finding a time with?");
  expect(form).not.toContain('name="ask_0"'); // a poll asks everyone the same thing
  // Everyone in a poll's thread sees what it says (rc26): no terms to pick.
  expect(form).not.toContain('name="tier_0"');
  expect(form).not.toContain('name="vis_0"');
  expect(form).toContain("everyone in the poll sees these");
  const res = await create(b, POLLS_PATH, {
    title: "When next?",
    location: "",
    description: "",
    tzid: "Europe/Prague",
    start_0: "2101-11-10T19:00",
    end_0: "2101-11-10T22:00",
    start_1: "2101-11-11T19:00",
    end_1: "2101-11-11T22:00",
    email_0: "bob@example.org",
  });
  expect(res.status).toBe(303);
  const thread = res.headers.get("location") ?? "";
  expect(thread).toMatch(new RegExp(`^${PLANS_PATH}/[0-9a-f-]+$`));
  await addAccount(b, "bob@example.org");
  expect((await home(b)).text).toContain("2 waiting for your vote");
  const asBob = await (await b.request(thread)).text();
  const plans = [...asBob.matchAll(/href="(\/plans\/[^"]+\/p\/[^"]+)"/g)].map((m) => m[1] ?? "");
  const first = plans[0] ?? "";
  const voted = await b.request(
    `${first}/vote`,
    post({ csrf: (await home(b)).csrf, answer: "yes" }),
  );
  expect(voted.status).toBe(303);
  expect(await (await b.request(first)).text()).toContain("Both said yes to it");
});

it("home offers both, with no group needed", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  const text = (await home(b)).text;
  expect(text).toContain(`href="${EVENTS_PATH}/new"`);
  expect(text).toContain(`href="${POLLS_PATH}/new"`);
});
