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
  expect(page).toContain('<span class="letter">A</span>');
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
  expect(two).toContain('<span class="letter">B</span>');
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
