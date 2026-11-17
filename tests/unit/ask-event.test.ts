// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { findEventForParticipant, listEventsFor } from "../../src/events/event.js";
import { acceptInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import {
  type AskDraft,
  askAsEvent,
  EMPTY_ASK,
  findAskDraft,
  makesEvent,
} from "../../src/plans/ask.js";
import { listThreadsFor } from "../../src/plans/thread.js";
import { ASK_PATH } from "../../src/web/routes/ask.js";
import { EVENTS_PATH } from "../../src/web/routes/events.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// Ask as the starting point (DESIGN §10 *Asking when*, rc50, A6c): one option of one event
// with a time, and nobody to ask — no addresses, nobody chosen, no group with anyone else in
// it — is made as an event at once, and the page after is the event's. Anything else is a
// question, as before.

const NOW = "2101-12-01T09:00:00.000Z";

const PIZZA = {
  title: "Pizza",
  location: "Ann's",
  note: "Bring a <dip>",
  tzid: "Europe/Prague",
  o0e0day: "2101-12-17",
  o0e0from: "19:00",
  o0e0to: "21:00",
  email: "",
  new_from: "19:00",
  new_hours: "2",
};

const MAKES = "Nobody to ask, so asking makes “Pizza” an event at once and tells nobody.";
const LATER = "Asking emails them a minute later; until then you can undo it.";

/** Mara signs in and starts a question, from a group when one is given. */
async function start(b: Browser, group: string | null = null) {
  await addAccount(b, "mara@example.org");
  const csrf = async () => (await home(b)).csrf;
  const res = await b.request(
    ASK_PATH,
    post({ csrf: await csrf(), ...(group === null ? {} : { group }) }),
  );
  const path = res.headers.get("location") ?? "";
  const mara = (await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW })).id;
  const send = async (fields: Record<string, string>) =>
    b.request(path, post({ csrf: await csrf(), ...fields }));
  return { path, id: path.split("/").at(-1) ?? "", mara, csrf, send };
}

/** Mara's group, and its members accepted from invites at the tiers given. */
async function group(b: Browser, invited: readonly (readonly [string, string])[]) {
  await addAccount(b, "mara@example.org");
  const csrf = async () => (await home(b)).csrf;
  const g = (await b.request("/groups", post({ csrf: await csrf(), name: "Table" }))).headers.get(
    "location",
  );
  for (const [email, visibility] of invited)
    await b.request(
      `${g}/invites`,
      post({ csrf: await csrf(), email, editTier: "view", visibility }),
    );
  const tokens = b.sent.flatMap((m) => [...m.text.matchAll(/\/invite\?t=([A-Za-z0-9_-]+)/g)]);
  for (const t of tokens) await acceptInvite(b.storage, t[1] ?? "", NOW);
  return g?.split("/").at(-1) ?? "";
}

it("one time and nobody to ask: the read-back says so, and Ask makes the event and tells nobody", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  // A new question's blank time is not a time yet: it reads as a question.
  const blank = await (await b.request(f.path)).text();
  expect(blank).toContain("Asking emails nobody yet — add people below");
  expect(blank).not.toContain(MAKES);

  await f.send({ ...PIZZA, act: "save" });
  const page = await (await b.request(f.path)).text();
  expect(page).toContain(`<p class="readback">${MAKES}</p>`);
  expect(page).not.toContain(LATER);
  expect(page).toContain(">Ask</button>"); // the button keeps its name

  const sent = b.sent.length;
  const res = await f.send({ ...PIZZA, act: "ask" });
  expect(res.status).toBe(303);
  const at = res.headers.get("location") ?? "";
  expect(at).toMatch(new RegExp(`^${EVENTS_PATH}/[0-9a-f-]{36}$`));
  const made = await findEventForParticipant(b.storage, at.split("/").at(-1) ?? "", f.mara);
  expect(made?.event).toMatchObject({
    title: "Pizza",
    location: "Ann's",
    description: "Bring a <dip>",
    allDay: false,
    startLocal: "2101-12-17T19:00:00",
    endLocal: "2101-12-17T21:00:00",
    tzid: "Europe/Prague",
    status: "scheduled",
    ownerId: f.mara,
    groupId: null,
  });
  expect(made?.participation).toMatchObject({ editTier: "edit", visibility: "FULL" });
  expect(b.sent.length).toBe(sent); // tells nobody
  expect(await listThreadsFor(b.storage, f.mara)).toEqual([]); // no question
  expect(await findAskDraft(b.storage, { id: f.id, authorId: f.mara })).toBeNull();
  expect(await (await b.request(at)).text()).toContain("Pizza");
  expect(await b.pass()).toBe(0); // nothing held
});

it("an event of its own name is made under that name", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const res = await f.send({ ...PIZZA, o0e0name: "Pizza at Ann's", act: "ask" });
  const made = await findEventForParticipant(
    b.storage,
    res.headers.get("location")?.split("/").at(-1) ?? "",
    f.mara,
  );
  expect(made?.event.title).toBe("Pizza at Ann's");
});

it("with anyone to ask, or more than one time, it is a question as before", async () => {
  const b = await browser({ now: () => NOW });
  // An address: asked by email, held a minute.
  const asked = await start(b);
  await asked.send({ ...PIZZA, email: "lea@example.org", act: "save" });
  expect(await (await b.request(asked.path)).text()).not.toContain(MAKES);
  const res = await asked.send({ ...PIZZA, email: "lea@example.org", act: "ask" });
  expect(res.headers.get("location")).toMatch(new RegExp(`^${PLANS_PATH}/`));

  // Two options and nobody: a question to share by its link (rc29), not two events.
  const two = await start(b);
  await two.send({ ...PIZZA, act: "option" });
  expect(await (await b.request(two.path)).text()).not.toContain(MAKES);
  const shared = await two.send({
    ...PIZZA,
    o1e0day: "2101-12-18",
    o1e0from: "19:00",
    o1e0to: "21:00",
    act: "ask",
  });
  expect(shared.headers.get("location")).toMatch(new RegExp(`^${PLANS_PATH}/`));

  // One option of two events and nobody: a question too.
  const and = await start(b);
  await and.send({ ...PIZZA, act: "and:0" });
  expect(await (await b.request(and.path)).text()).not.toContain(MAKES);

  expect(await listEventsFor(b.storage, asked.mara)).toEqual([]);
});

it("from a group of only you, the event is the group's; with anyone else in it, even busy-only, it asks", async () => {
  const b = await browser({ now: () => NOW });
  const alone = await group(b, []);
  const f = await start(b, alone);
  await f.send({ ...PIZZA, act: "save" });
  expect(await (await b.request(f.path)).text()).toContain(MAKES);
  const res = await f.send({ ...PIZZA, act: "ask" });
  const made = await findEventForParticipant(
    b.storage,
    res.headers.get("location")?.split("/").at(-1) ?? "",
    f.mara,
  );
  expect(made?.event.groupId).toBe(alone);

  // Someone in the group who sees only busy time is not emailed the question, but is still
  // someone: it is not "nobody to ask".
  const c = await browser({ now: () => NOW });
  const busy = await group(c, [["busy@example.org", "BUSY"]]);
  const g = await start(c, busy);
  await g.send({ ...PIZZA, act: "save" });
  expect(await (await c.request(g.path)).text()).not.toContain(MAKES);
  const asked = await g.send({ ...PIZZA, act: "ask" });
  expect(asked.headers.get("location")).toMatch(new RegExp(`^${PLANS_PATH}/`));
});

it("asked twice at once, it is made once; anyone else's draft makes nothing", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...PIZZA, act: "save" });
  const lea = (await findOrCreatePerson(b.storage, "lea@example.org", { now: NOW })).id;
  expect(await askAsEvent(b.storage, { id: f.id, authorId: lea, now: NOW })).toBeNull();
  const [one, two] = await Promise.all([
    askAsEvent(b.storage, { id: f.id, authorId: f.mara, now: NOW }),
    askAsEvent(b.storage, { id: f.id, authorId: f.mara, now: NOW }),
  ]);
  expect([one, two].filter((x) => x !== null)).toHaveLength(1);
  expect(await listEventsFor(b.storage, f.mara)).toHaveLength(1);
});

it("a time the event form would refuse is refused here too, and the draft is kept", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const res = await f.send({ ...PIZZA, o0e0to: "18:00", act: "ask" });
  expect(res.status).toBe(400);
  expect(await listEventsFor(b.storage, f.mara)).toEqual([]);
  expect(await findAskDraft(b.storage, { id: f.id, authorId: f.mara })).not.toBeNull();
});

it("home, a group's page and the plans page start with Ask; the event form is a quieter link", async () => {
  const b = await browser({ now: () => NOW });
  const g = await group(b, []);
  const page = await (await b.request(`/groups/${g}`)).text();
  expect(page).toContain(">Ask Table when</button>");
  expect(page).toContain(
    `<p class="muted"><a href="/groups/${g}/events/new">New repeating event</a></p>`,
  );
  expect(page).not.toContain("/polls/new");
  const plans = await (await b.request(PLANS_PATH)).text();
  expect(plans).not.toContain(`${PLANS_PATH}/new`);
  // The old routes stay, for links already out.
  for (const path of [
    `${EVENTS_PATH}/new`,
    "/polls/new",
    `${PLANS_PATH}/new`,
    `/groups/${g}/polls/new`,
  ])
    expect((await b.request(path)).status, path).toBe(200);
});

it("nobody to ask means nobody chosen either, and a group the asker is in", async () => {
  const b = await browser({ now: () => NOW });
  const g = await group(b, []);
  const mara = (await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW })).id;
  const lea = (await findOrCreatePerson(b.storage, "lea@example.org", { now: NOW })).id;
  const time = { allDay: false, startLocal: "2101-12-17T19:00", endLocal: "2101-12-17T21:00" };
  const draft = (over: Partial<AskDraft["body"]>, groupId: string | null = null): AskDraft => ({
    id: "d",
    groupId,
    updatedAt: NOW,
    body: { ...EMPTY_ASK, title: "Pizza", options: [[time]], ...over },
  });
  expect(await makesEvent(b.storage, draft({}), mara)).toBe(true);
  expect(await makesEvent(b.storage, draft({ people: [] }), mara)).toBe(true);
  // Someone chosen from the suggestions is someone to ask.
  expect(await makesEvent(b.storage, draft({ people: [{ id: lea, from: null }] }), mara)).toBe(
    false,
  );
  expect(await makesEvent(b.storage, draft({ emails: ["lea@example.org"] }), mara)).toBe(false);
  // A group of only Mara makes her event; it is no one's for someone not in it.
  expect(await makesEvent(b.storage, draft({}, g), mara)).toBe(true);
  expect(await makesEvent(b.storage, draft({}, g), lea)).toBe(false);
});

it("a name of only spaces is the question's title; a name is trimmed; the id may be given", async () => {
  const b = await browser({ now: () => NOW });
  const blank = await start(b);
  const made = await blank.send({ ...PIZZA, o0e0name: "   ", act: "ask" });
  const id = made.headers.get("location")?.split("/").at(-1) ?? "";
  expect((await findEventForParticipant(b.storage, id, blank.mara))?.event.title).toBe("Pizza");

  const padded = await start(b);
  await padded.send({ ...PIZZA, o0e0name: "  Pizza at Ann's  ", act: "save" });
  const given = "0198a3a0-0000-7000-8000-000000000001";
  expect(
    await askAsEvent(b.storage, {
      id: padded.id,
      authorId: padded.mara,
      now: NOW,
      newId: () => given,
    }),
  ).toEqual({ eventId: given });
  expect((await findEventForParticipant(b.storage, given, padded.mara))?.event.title).toBe(
    "Pizza at Ann's",
  );
});

it("with no title yet, the read-back says it makes this an event", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...PIZZA, title: "  ", act: "save" });
  expect(await (await b.request(f.path)).text()).toContain(
    "Nobody to ask, so asking makes this an event at once and tells nobody.",
  );
});
