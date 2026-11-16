// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { findOrCreatePerson } from "../../src/people/person.js";
import { findAskDraft } from "../../src/plans/ask.js";
import { listPlans } from "../../src/plans/plan.js";
import { findThreadForMember } from "../../src/plans/thread.js";
import { ASK_PATH } from "../../src/web/routes/ask.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// Ask when as a plain page (DESIGN §10 *Asking when*, rc46, A2): started from home, saved by
// every button, lettered options with "or" between and "+ and" inside, a read-back that says
// what will happen, and asking that makes the thread and holds the email a minute.

const NOW = "2101-12-01T09:00:00.000Z";

async function start(b: Browser) {
  await addAccount(b, "mara@example.org");
  const h = await home(b);
  expect(h.text).toContain(`<form method="post" action="${ASK_PATH}">`);
  expect(h.text).toContain(">Ask when</button>");
  const res = await b.request(ASK_PATH, post({ csrf: h.csrf }));
  expect(res.status).toBe(303);
  const path = res.headers.get("location") ?? "";
  expect(path).toMatch(new RegExp(`^${ASK_PATH}/[0-9a-f-]+$`));
  const mara = await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW });
  const send = async (fields: Record<string, string>) =>
    b.request(path, post({ csrf: (await home(b)).csrf, ...fields }));
  return { path, id: path.split("/").at(-1) ?? "", mara: mara.id, send };
}

const PIZZA = {
  title: "Pizza",
  location: "Ann's",
  tzid: "Europe/Prague",
  o0e0day: "2101-12-17",
  o0e0from: "19:00",
  o0e0to: "21:00",
  emails: "lea@example.org, cat@example.org",
};

it("a new question: one time to fill in, the status line, a read-back; GET writes nothing", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const writes = b.writes;
  const page = await (await b.request(f.path)).text();
  expect(b.writes).toBe(writes);
  expect(page).toContain("<strong>Draft</strong> · step 1 of 4 · nobody has been told");
  expect(page).toMatch(/<legend><span class="letter" style="background:var\(--o0\)">A<\/span>/);
  expect(page).toContain('name="o0e0day"');
  expect(page).not.toContain('name="o1e0day"');
  expect(page).toContain("Asking emails nobody yet — add people below one question");
  expect(page).toContain(">Ask</button>");
});

it("every button saves first; the read-back and the button say who and what", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const res = await f.send({ ...PIZZA, act: "save" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${f.path}?saved=1`);
  const page = await (await b.request(`${f.path}?saved=1`)).text();
  expect(page).toContain('<span class="muted">Saved</span>');
  expect(page).toContain('value="Pizza"');
  expect(page).toContain('name="o0e0from" value="19:00"');
  expect(page).toContain("lea@example.org\ncat@example.org");
  expect(page).toContain(
    "Asking emails 2 people one question: does <strong>A</strong> suit for “Pizza”? If it suits, it happens.",
  );
  expect(page).toContain(">Ask 2 people by email</button>");

  // "+ A time" saves what was typed too, then adds B: "or" between them.
  await f.send({ ...PIZZA, title: "Pizza night", act: "option" });
  const two = await (await b.request(f.path)).text();
  expect(two).toContain('value="Pizza night"');
  expect(two).toContain('<p class="or">or</p>');
  expect(two).toMatch(/<legend><span class="letter" style="background:var\(--o1\)">B<\/span>/);
  expect(two).toContain(
    "does <strong>A or B</strong> suit for “Pizza night”? One of them will happen.",
  );
});

it("+ and makes an option several events; Remove takes one, and an empty option goes", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...PIZZA, act: "and:0" });
  const page = await (await b.request(f.path)).text();
  expect(page).toContain('name="o0e1day"');
  expect(page).toContain('<p class="and">and</p>');
  await f.send({
    ...PIZZA,
    o0e1day: "2101-12-18",
    o0e1last: "2101-12-19",
    act: "save",
  });
  const draft = await findAskDraft(b.storage, { id: f.id, authorId: f.mara });
  expect(draft?.body.options).toEqual([
    [
      { allDay: false, startLocal: "2101-12-17T19:00", endLocal: "2101-12-17T21:00" },
      { allDay: true, startLocal: "2101-12-18", endLocal: "2101-12-20" }, // two days, end exclusive
    ],
  ]);
  expect(await (await b.request(f.path)).text()).toContain('name="o0e1last" value="2101-12-19"');
  await f.send({ ...PIZZA, o0e1day: "2101-12-18", act: "drop:0:0" });
  expect((await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options).toEqual([
    [{ allDay: true, startLocal: "2101-12-18", endLocal: "2101-12-19" }],
  ]);
});

it("asking makes the thread, holds the email a minute with Undo, and the draft is gone from home", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...PIZZA, act: "option" });
  const res = await f.send({
    ...PIZZA,
    o1e0day: "2101-12-18",
    o1e0from: "19:00",
    o1e0to: "21:00",
    act: "ask",
  });
  expect(res.status).toBe(303);
  const thread = res.headers.get("location") ?? "";
  expect(thread).toMatch(/^\/plans\/[0-9a-f-]+$/);
  expect(await (await b.request(thread)).text()).toContain(
    "<strong>Emailing vote links</strong> — in about a minute",
  );
  expect(b.sent.filter((m) => m.subject.startsWith("When can you make"))).toEqual([]);
  await b.pass();
  expect(
    b.sent
      .filter((m) => m.subject.startsWith("When can you make"))
      .map((m) => m.to)
      .sort(),
  ).toEqual(["cat@example.org", "lea@example.org"]);
  const access = await findThreadForMember(b.storage, thread.split("/").at(-1) ?? "", f.mara);
  if (access === null) throw new Error("thread");
  expect(
    (await listPlans(b.storage, access)).map((p) => [p.letter, p.events[0]?.location]),
  ).toEqual([
    ["A", "Ann's"],
    ["B", "Ann's"],
  ]);
  expect(await findAskDraft(b.storage, { id: f.id, authorId: f.mara })).toBeNull();
  expect((await home(b)).text).not.toContain("Not asked yet");
});

it("a question that can't be asked says why and keeps every word", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const res = await f.send({ ...PIZZA, o0e0day: "", act: "ask" });
  expect(res.status).toBe(400);
  const page = await res.text();
  expect(page).toContain('class="error"');
  expect(page).toContain('value="Pizza"');
  expect(page).toContain("lea@example.org\ncat@example.org");
  expect(await findAskDraft(b.storage, { id: f.id, authorId: f.mara })).not.toBeNull();
});

it("home lists what isn't asked yet; only its author opens it; CSRF on every button; thrown away, it's gone", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...PIZZA, act: "save" });
  const h = await home(b);
  expect(h.text).toContain("<h2>Not asked yet</h2>");
  expect(h.text).toContain(`<a href="${f.path}">Pizza</a>`);
  expect((await b.request(f.path, post({ csrf: "nope", act: "save" }))).status).toBe(403);
  await addAccount(b, "lea@example.org");
  expect((await b.request(f.path)).status).toBe(404);
  expect((await b.request(f.path, post({ csrf: (await home(b)).csrf, act: "save" }))).status).toBe(
    404,
  );
  await addAccount(b, "mara@example.org");
  const gone = await f.send({ act: "discard" });
  expect(gone.headers.get("location")).toBe("/");
  expect((await b.request(f.path)).status).toBe(404);
});

it("the read-back counts a group's people who see what it plans, not you, and names three options", async () => {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "mara@example.org");
  const csrf = async () => (await home(b)).csrf;
  const g = (await b.request("/groups", post({ csrf: await csrf(), name: "Table" }))).headers.get(
    "location",
  );
  for (const [email, visibility] of [
    ["full@example.org", "FULL"],
    ["details@example.org", "DETAILS"],
    ["busy@example.org", "BUSY"],
  ] as const)
    await b.request(
      `${g}/invites`,
      post({ csrf: await csrf(), email, editTier: "view", visibility }),
    );
  // Invited isn't joined: accept them as the group's members.
  const { acceptInvite } = await import("../../src/people/invite.js");
  const tokens = b.sent.flatMap((m) => [...m.text.matchAll(/\/invite\?t=([A-Za-z0-9_-]+)/g)]);
  for (const t of tokens) await acceptInvite(b.storage, t[1] ?? "", NOW);
  const groupId = g?.split("/").at(-1) ?? "";
  const res = await b.request(ASK_PATH, post({ csrf: await csrf(), group: groupId }));
  const path = res.headers.get("location") ?? "";
  const send = async (fields: Record<string, string>) =>
    b.request(path, post({ csrf: await csrf(), ...fields }));
  await send({ ...PIZZA, emails: "", act: "option" });
  await send({ ...PIZZA, emails: "", act: "option" });
  const page = await (await b.request(path)).text();
  // FULL and DETAILS see what the group plans; BUSY doesn't; Mara isn't asked herself.
  expect(page).toContain("Asking emails 2 people one question: does <strong>A, B or C</strong>");
  expect(page).toContain(">Ask 2 people by email</button>");
  // Someone else's group can't start a question.
  await addAccount(b, "lea@example.org");
  expect((await b.request(ASK_PATH, post({ csrf: await csrf(), group: groupId }))).status).toBe(
    404,
  );
});

it("one person; no times; a time with no end kept as typed; ten options and no more", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...PIZZA, emails: "lea@example.org", o0e0to: "", act: "save" });
  const one = await (await b.request(f.path)).text();
  expect(one).toContain("Asking emails 1 person one question");
  expect(one).toContain(">Ask 1 person by email</button>");
  expect(one).toContain('name="o0e0to" value=""');
  const draft = await findAskDraft(b.storage, { id: f.id, authorId: f.mara });
  expect(draft?.body.options).toEqual([
    [{ allDay: false, startLocal: "2101-12-17T19:00", endLocal: "" }],
  ]);
  await f.send({ ...PIZZA, act: "drop:0:0" });
  const none = await (await b.request(f.path)).text();
  expect(none).toContain('<p class="muted">No times yet. Tap a day to add one.</p>');
  expect(none).toContain("does nothing yet suit for “Pizza”? </p>");
  for (let i = 0; i < 11; i++) await f.send({ ...PIZZA, act: "option" });
  const ten = await (await b.request(f.path)).text();
  expect(ten).toMatch(/<legend><span class="letter" style="background:var\(--o1\)">J<\/span>/);
  expect(ten).not.toContain('value="option"');
  expect(
    (await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options,
  ).toHaveLength(10);
});

// --- the Days view (rc46): tap a free day to add; tap an option for its card ------------

it("tapping a free day adds an option of the defaults, says so with Undo, and keeps the month", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const page = await (await b.request(f.path)).text();
  // December 2101: Monday-first whole weeks, so 28–30 November open it, dashed.
  expect(page).toContain("<strong>December 2101</strong>");
  expect(page).toContain('value="add:2101-11-28" aria-label="Add 2101-11-28">28</button>');
  expect(page).toMatch(/<button class="day out" type="submit" name="act" value="add:2101-11-28"/);
  expect(page).toContain('class="day today"');
  const res = await f.send({
    ...PIZZA,
    o0e0day: "",
    new_from: "18:30",
    new_hours: "3",
    act: "add:2101-12-24",
  });
  expect(res.headers.get("location")).toBe(`${f.path}?saved=1&m=2101-12&added=1`);
  const after = await (await b.request(res.headers.get("location") ?? "")).text();
  expect(after).toContain(
    'Added Sat 24 Dec, 18:30 as B <button class="link" type="submit" name="act" value="remove:1">Undo</button>',
  );
  expect(after).toMatch(/<a class="letter" href="#o1"[^>]*>B<\/a>/);
  expect(after).not.toContain('value="add:2101-12-24"'); // a day with an option isn't free
  expect((await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options[1]).toEqual([
    { allDay: false, startLocal: "2101-12-24T18:30", endLocal: "2101-12-24T21:30" },
  ]);
  // Undo takes it away again.
  await f.send({ ...PIZZA, o0e0day: "", act: "remove:1" });
  expect(
    (await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options,
  ).toHaveLength(1);
});

it("no time makes a tapped day all day; late evenings run past midnight; stretches mark every day", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...PIZZA, new_from: "", act: "add:2101-12-10" });
  await f.send({
    ...PIZZA,
    new_from: "23:00",
    new_hours: "2",
    o1e0day: "2101-12-10",
    act: "add:2101-12-11",
  });
  const opts = (await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options;
  expect(opts?.[1]).toEqual([{ allDay: true, startLocal: "2101-12-10", endLocal: "2101-12-11" }]);
  expect(opts?.[2]).toEqual([
    { allDay: false, startLocal: "2101-12-11T23:00", endLocal: "2101-12-12T01:00" },
  ]);
  // A two-day stretch is drawn on both of its days.
  await f.send({
    ...PIZZA,
    o0e0day: "2101-12-20",
    o0e0from: "",
    o0e0last: "2101-12-21",
    o1e0day: "2101-12-10",
    o2e0day: "2101-12-11",
    o2e0from: "23:00",
    o2e0to: "01:00",
    act: "save",
  });
  const page = await (await b.request(f.path)).text();
  expect(page.match(/<a class="letter" href="#o0"/g)).toHaveLength(2);
});

it("the month buttons save first and move; a month asked for is kept by Save; ten options leave no free day", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const res = await f.send({ ...PIZZA, title: "Moved on", act: "month:2102-01" });
  expect(res.headers.get("location")).toBe(`${f.path}?saved=1&m=2102-01`);
  const jan = await (await b.request(res.headers.get("location") ?? "")).text();
  expect(jan).toContain("<strong>January 2102</strong>");
  expect(jan).toContain('value="Moved on"');
  expect(jan).toContain('name="m" value="2102-01"');
  expect((await f.send({ ...PIZZA, m: "2102-01", act: "save" })).headers.get("location")).toBe(
    `${f.path}?saved=1&m=2102-01`,
  );
  for (let i = 0; i < 9; i++) await f.send({ ...PIZZA, act: "option" });
  const full = await (await b.request(`${f.path}?m=2101-12`)).text();
  expect(full).not.toContain('value="add:');
  // An Undo for an option that isn't there shows nothing.
  expect(await (await b.request(`${f.path}?added=40`)).text()).not.toContain("Added ");
});
