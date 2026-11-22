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

type Stored = { readonly sid?: string; readonly title?: string | null };

/**
 * The times of one stored option. rc49: every event also has an identity from when it was made
 * — checked here — and a name of its own, which these tests leave empty.
 */
function timesOf<E extends Stored>(events: readonly E[] | undefined) {
  return events?.map(({ sid, title, ...time }) => {
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(title ?? null).toBeNull();
    return time;
  });
}

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
  email: "lea@example.org, cat@example.org",
  // What the page's own form always sends with every button.
  new_from: "19:00",
  new_hours: "2",
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
  // rc48: each address is a chip, kept in the form as typed.
  expect(page).toContain('name="pc_0" value="e:lea@example.org"');
  expect(page).toContain('name="pc_1" value="e:cat@example.org"');
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
  expect(draft?.body.options.map(timesOf)).toEqual([
    [
      { allDay: false, startLocal: "2101-12-17T19:00", endLocal: "2101-12-17T21:00" },
      { allDay: true, startLocal: "2101-12-18", endLocal: "2101-12-20" }, // two days, end exclusive
    ],
  ]);
  expect(await (await b.request(f.path)).text()).toContain('name="o0e1last" value="2101-12-19"');
  await f.send({ ...PIZZA, o0e1day: "2101-12-18", act: "drop:0:0" });
  expect(
    (await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options.map(timesOf),
  ).toEqual([[{ allDay: true, startLocal: "2101-12-18", endLocal: "2101-12-19" }]]);
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
  // rc48: each address is a chip, kept in the form as typed.
  expect(page).toContain('name="pc_0" value="e:lea@example.org"');
  expect(page).toContain('name="pc_1" value="e:cat@example.org"');
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
  await send({ ...PIZZA, email: "", act: "option" });
  await send({ ...PIZZA, email: "", act: "option" });
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
  await f.send({ ...PIZZA, email: "lea@example.org", o0e0to: "", act: "save" });
  const one = await (await b.request(f.path)).text();
  expect(one).toContain("Asking emails 1 person one question");
  expect(one).toContain(">Ask 1 person by email</button>");
  expect(one).toContain('name="o0e0to" value=""');
  const draft = await findAskDraft(b.storage, { id: f.id, authorId: f.mara });
  expect(draft?.body.options.map(timesOf)).toEqual([
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
  expect(page).toContain(
    'value="add:2101-11-28" aria-label="Add 2101-11-28" data-day="2101-11-28">28</button>',
  );
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
  expect(
    timesOf((await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options[1]),
  ).toEqual([{ allDay: false, startLocal: "2101-12-24T18:30", endLocal: "2101-12-24T21:30" }]);
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
  expect(timesOf(opts?.[1])).toEqual([
    { allDay: true, startLocal: "2101-12-10", endLocal: "2101-12-11" },
  ]);
  expect(timesOf(opts?.[2])).toEqual([
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

it("a To earlier than From is the next day: an end past midnight survives a save (rc58)", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const stored = async () =>
    timesOf((await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options[0]);
  await f.send({ ...PIZZA, o0e0from: "23:00", o0e0to: "02:00", act: "save" });
  expect(await stored()).toEqual([
    { allDay: false, startLocal: "2101-12-17T23:00", endLocal: "2101-12-18T02:00" },
  ]);
  // The sheet says so, and sends it back as it was: saving again keeps it.
  const page = await (await b.request(f.path)).text();
  expect(page).toContain(
    '<label>To <span class="muted small">(next day)</span><br /><input type="time" name="o0e0to" value="02:00" /></label>',
  );
  await f.send({ ...PIZZA, o0e0from: "23:00", o0e0to: "02:00", act: "save" });
  expect((await stored())?.[0]?.endLocal).toBe("2101-12-18T02:00");
  // A To equal to From is a moment; a later one the same day, as before; neither says next day.
  await f.send({ ...PIZZA, o0e0from: "19:00", o0e0to: "19:00", act: "save" });
  expect((await stored())?.[0]?.endLocal).toBe("2101-12-17T19:00");
  expect(await (await b.request(f.path)).text()).not.toContain("(next day)");
  await f.send({ ...PIZZA, act: "save" });
  expect((await stored())?.[0]?.endLocal).toBe("2101-12-17T21:00");
  expect(await (await b.request(f.path)).text()).toContain(
    '<label>To<br /><input type="time" name="o0e0to" value="21:00" /></label>',
  );
  // No To yet: nothing to call the next day.
  await f.send({ ...PIZZA, o0e0from: "23:00", o0e0to: "", act: "save" });
  expect(await (await b.request(f.path)).text()).toContain(
    '<label>To<br /><input type="time" name="o0e0to" value="" /></label>',
  );
  // No day yet: nothing to be the next day of, so no times either.
  await f.send({ ...PIZZA, o0e0day: "", o0e0from: "23:00", o0e0to: "02:00", act: "save" });
  expect(await stored()).toEqual([{ allDay: false, startLocal: "", endLocal: "" }]);
  // An end grip dragged into the next day survives the next save too.
  await f.send({
    ...PIZZA,
    o0e0from: "23:00",
    o0e0to: "23:30",
    act: "move:0:0:end:2101-12-18T01:00",
  });
  expect((await stored())?.[0]?.endLocal).toBe("2101-12-18T02:00");
  await f.send({ ...PIZZA, o0e0from: "23:00", o0e0to: "02:00", act: "save" });
  expect((await stored())?.[0]?.endLocal).toBe("2101-12-18T02:00");
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

// --- the Hours view (rc46): the same options, four days as an hour grid ------------------

it("Hours shows four days by the hour; a free hour adds an option of the length chosen", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const sw = await f.send({ ...PIZZA, m: "2101-12", new_hours: "1", act: "view:hours" });
  expect(sw.headers.get("location")).toBe(`${f.path}?saved=1&v=hours&m=2101-12`);
  const page = await (await b.request(sw.headers.get("location") ?? "")).text();
  expect(page).toContain('value="view:hours" aria-pressed="true">Hours');
  // From the first option's day, four days: 17–20 Dec. A covers 19:00 and 20:00 there.
  expect(page).toContain("<strong>Sat 17 Dec – Tue 20 Dec</strong>");
  expect(
    page.match(
      /<span class="hour has" data-at="[^"]+">(<span class="grip"[^>]*><\/span>)?<a class="letter" href="#o0"/g,
    ),
  ).toHaveLength(2);
  expect(page).toContain('value="addh:2101-12-18T12:00" aria-label="Add 2101-12-18 12:00"');
  expect(page).toContain('name="v" value="hours"');
  const res = await f.send({
    ...PIZZA,
    new_hours: "1",
    v: "hours",
    d: "2101-12-17",
    act: "addh:2101-12-18T12:00",
  });
  expect(res.headers.get("location")).toBe(
    `${f.path}?saved=1&v=hours&m=2101-12&added=1&d=2101-12-17`,
  );
  const after = await (await b.request(res.headers.get("location") ?? "")).text();
  expect(after).toContain("Added Sun 18 Dec, 12:00 as B");
  expect(
    timesOf((await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options[1]),
  ).toEqual([{ allDay: false, startLocal: "2101-12-18T12:00", endLocal: "2101-12-18T13:00" }]);
  // The defaults keep their time though Hours never uses it: switching back finds it.
  expect(after).toContain('name="new_from" value="19:00"');
});

it("Hours moves four days at a time, keeps its place across saves, and shows all-day options above", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const next = await f.send({
    ...PIZZA,
    m: "2101-12",
    v: "hours",
    d: "2101-12-17",
    act: "from:2101-12-21",
  });
  expect(next.headers.get("location")).toBe(`${f.path}?saved=1&v=hours&m=2101-12&d=2101-12-21`);
  const later = await (await b.request(next.headers.get("location") ?? "")).text();
  expect(later).toContain("<strong>Wed 21 Dec – Sat 24 Dec</strong>");
  expect(later).toContain('value="from:2101-12-17" aria-label="Earlier days"');
  await f.send({
    ...PIZZA,
    o0e0day: "2101-12-22",
    o0e0from: "",
    act: "save",
    v: "hours",
    d: "2101-12-21",
  });
  const allDay = await (await b.request(`${f.path}?v=hours&d=2101-12-21`)).text();
  expect(allDay).toMatch(
    /<div class="hrow allday">.*?<span class="hour has"><a class="letter" href="#o0"/s,
  );
  expect(allDay).not.toMatch(/<div class="hrow"><span class="hr">19<\/span>.*?href="#o0"/);
  // Back to Days: the switch saves, and the month comes back.
  const back = await f.send({
    ...PIZZA,
    o0e0day: "2101-12-22",
    o0e0from: "",
    m: "2101-12",
    v: "hours",
    act: "view:days",
  });
  expect(back.headers.get("location")).toBe(`${f.path}?saved=1&m=2101-12`);
});

// --- dragging (rc47): a finished drag is the same POST a button makes --------------------

it("a drag along a week's empty days adds one all-day option over them, with Undo naming them", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const page = await (await b.request(f.path)).text();
  expect(page).toContain('<div class="pl ask" data-ask-drag>');
  expect(page).toContain('<button type="submit" name="act" value="save" hidden data-drag-act>');
  expect(page).toContain("globalThis.WhenDoWeAskDrag");
  // Dragged right to left, it is the same span.
  const res = await f.send({ ...PIZZA, m: "2101-12", act: "span:2101-12-16:2101-12-14" });
  expect(res.headers.get("location")).toBe(`${f.path}?saved=1&m=2101-12&added=1`);
  const after = await (await b.request(res.headers.get("location") ?? "")).text();
  expect(after).toContain("Added Wed 14 Dec – Fri 16 Dec as B");
  expect(
    timesOf((await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options[1]),
  ).toEqual([{ allDay: true, startLocal: "2101-12-14", endLocal: "2101-12-17" }]);
  // Its first and last days carry a grip on B's letter; the day between doesn't.
  expect(after).toContain(
    'aria-label="Option B" data-grip="1:0" data-ends="start" draggable="false"',
  );
  expect(after).toContain(
    'aria-label="Option B" data-grip="1:0" data-ends="end" draggable="false"',
  );
  expect(after.match(/data-grip="1:0"/g)).toHaveLength(2);
  // A day that isn't one adds nothing.
  await f.send({
    ...PIZZA,
    o1e0day: "2101-12-14",
    o1e0last: "2101-12-16",
    act: "span:2101-02-28:2101-02-30",
  });
  expect(
    (await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options,
  ).toHaveLength(2);
});

it("dragging an all-day event's first or last day moves that end, never past the other", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const allDay = { ...PIZZA, o0e0from: "", o0e0day: "2101-12-10", o0e0last: "2101-12-12" };
  const opts = async () =>
    timesOf((await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options[0]);
  await f.send({ ...allDay, act: "save" });
  const one = await (await b.request(f.path)).text();
  expect(one).toContain('data-grip="0:0" data-ends="start"');
  await f.send({ ...allDay, act: "move:0:0:end:2101-12-14" });
  expect(await opts()).toEqual([
    { allDay: true, startLocal: "2101-12-10", endLocal: "2101-12-15" },
  ]);
  const moved = { ...allDay, o0e0last: "2101-12-14" };
  await f.send({ ...moved, act: "move:0:0:start:2101-12-08" });
  expect(await opts()).toEqual([
    { allDay: true, startLocal: "2101-12-08", endLocal: "2101-12-15" },
  ]);
  const both = { ...moved, o0e0day: "2101-12-08" };
  // Past the other end: nothing changes. The last day may meet the first.
  await f.send({ ...both, act: "move:0:0:start:2101-12-15" });
  await f.send({ ...both, act: "move:0:0:end:2101-12-07" });
  expect(await opts()).toEqual([
    { allDay: true, startLocal: "2101-12-08", endLocal: "2101-12-15" },
  ]);
  await f.send({ ...both, act: "move:0:0:end:2101-12-08" });
  expect(await opts()).toEqual([
    { allDay: true, startLocal: "2101-12-08", endLocal: "2101-12-09" },
  ]);
  // A one-day event has one grip that holds both ends.
  expect(await (await b.request(f.path)).text()).toContain('data-grip="0:0" data-ends="both"');
  // An hour is not a day's move: an all-day event ignores it.
  await f.send({ ...both, o0e0last: "", act: "move:0:0:end:2101-12-10T19:00" });
  expect(await opts()).toEqual([
    { allDay: true, startLocal: "2101-12-08", endLocal: "2101-12-09" },
  ]);
});

it("in Hours a timed event has a grip at each end; dragging one moves it by whole hours", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  const opts = async () =>
    timesOf((await findAskDraft(b.storage, { id: f.id, authorId: f.mara }))?.body.options[0]);
  const hours = { ...PIZZA, v: "hours", d: "2101-12-17" };
  await f.send({ ...hours, act: "save" });
  const page = await (await b.request(`${f.path}?v=hours&d=2101-12-17`)).text();
  // 19:00–21:00: the start grip in the 19 cell, the end grip in the 20 cell.
  expect(page).toContain(
    '<span class="hour has" data-at="2101-12-17T19:00"><span class="grip" data-grip="0:0" data-ends="start" aria-hidden="true"></span>',
  );
  expect(page).toMatch(
    /data-at="2101-12-17T20:00"><a [^>]*>A<\/a><span class="grip" data-grip="0:0" data-ends="end"/,
  );
  expect(page).toContain('aria-label="Add 2101-12-17 12:00" data-at="2101-12-17T12:00"');
  const res = await f.send({ ...hours, act: "move:0:0:start:2101-12-17T17:00" });
  expect(res.headers.get("location")).toBe(`${f.path}?saved=1&v=hours&d=2101-12-17`);
  expect(await opts()).toEqual([
    { allDay: false, startLocal: "2101-12-17T17:00", endLocal: "2101-12-17T21:00" },
  ]);
  // The end lands at the end of the hour it was dropped on.
  await f.send({ ...hours, o0e0from: "17:00", act: "move:0:0:end:2101-12-17T22:00" });
  expect(await opts()).toEqual([
    { allDay: false, startLocal: "2101-12-17T17:00", endLocal: "2101-12-17T23:00" },
  ]);
  const now = { ...hours, o0e0from: "17:00", o0e0to: "23:00" };
  // An hour in the middle of an event holds only its letter: grips are at its ends.
  const middle = await (await b.request(`${f.path}?v=hours&d=2101-12-17`)).text();
  expect(middle).toMatch(
    /<span class="hour has" data-at="2101-12-17T18:00"><a class="letter" href="#o0"[^>]*>A<\/a><\/span>/,
  );
  // Never inside out; an hour that isn't one, or an event not there, changes nothing.
  for (const act of [
    "move:0:0:start:2101-12-17T23:00",
    "move:0:0:end:2101-12-17T16:00",
    "move:0:0:end:2101-12-17T24:00",
    "move:0:3:end:2101-12-17T20:00",
    "move:0:0:start:2101-12-17",
  ])
    await f.send({ ...now, act });
  expect(await opts()).toEqual([
    { allDay: false, startLocal: "2101-12-17T17:00", endLocal: "2101-12-17T23:00" },
  ]);
  // An hour-long event has one grip, both ends; a 23:00 end grip moves to midnight.
  await f.send({
    ...now,
    o0e0from: "20:00",
    o0e0to: "21:00",
    act: "move:0:0:end:2101-12-17T23:00",
  });
  expect(await opts()).toEqual([
    { allDay: false, startLocal: "2101-12-17T20:00", endLocal: "2101-12-18T00:00" },
  ]);
  await f.send({ ...now, o0e0from: "20:00", o0e0to: "21:00", act: "save" });
  expect(await (await b.request(`${f.path}?v=hours&d=2101-12-17`)).text()).toContain(
    'data-grip="0:0" data-ends="both"',
  );
  // An end that isn't a real time yet, or is at the start, as typed: no grips. (rc58: one
  // before the start is the next day.)
  for (const to of ["25:00", "20:00"]) {
    await f.send({ ...now, o0e0from: "20:00", o0e0to: to, act: "save" });
    expect(await (await b.request(`${f.path}?v=hours&d=2101-12-17`)).text()).not.toContain(
      'class="grip"',
    );
  }
  // Ten options: no free hour adds one, and every hour still names itself for a grip's drop.
  for (let i = 0; i < 9; i++) await f.send({ ...now, act: "option" });
  const full = await (await b.request(`${f.path}?v=hours&d=2101-12-17`)).text();
  expect(full).not.toContain('value="addh:');
  expect(full).toContain('<span class="hour" data-at="2101-12-17T12:00"></span>');
});
