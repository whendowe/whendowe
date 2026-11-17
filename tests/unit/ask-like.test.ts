// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { findOrCreatePerson } from "../../src/people/person.js";
import { findAskDraft } from "../../src/plans/ask.js";
import { listPlans, madeLike, questionThreadStatements } from "../../src/plans/plan.js";
import { findThreadForMember } from "../../src/plans/thread.js";
import { ASK_PATH } from "../../src/web/routes/ask.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// Options of several events (DESIGN §10 *Asking when*, rc49, A5a): each event has a name of its
// own and an identity from when it is made; "+ Like A" copies A with the same identities, so
// what it changes from A is worked out by identity and drawn as week rows, "See A" for the
// other; asked, it is "like A" in the thread.

const NOW = "2101-12-01T09:00:00.000Z";

async function start(b: Browser) {
  await addAccount(b, "mara@example.org");
  const res = await b.request(ASK_PATH, post({ csrf: (await home(b)).csrf }));
  const path = res.headers.get("location") ?? "";
  const mara = (await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW })).id;
  const send = async (fields: Record<string, string>) =>
    b.request(path, post({ csrf: (await home(b)).csrf, ...fields }));
  const body = async () =>
    (await findAskDraft(b.storage, { id: path.split("/").at(-1) ?? "", authorId: mara }))?.body;
  return { path, mara, send, body };
}

/** Dinner Friday and a hike Saturday, as option A. */
const WEEKEND = {
  title: "Weekend",
  location: "",
  tzid: "Europe/Prague",
  o0e0name: "Dinner",
  o0e0day: "2101-12-16",
  o0e0from: "19:00",
  o0e0to: "21:00",
  o0e1name: "",
  o0e1day: "2101-12-17",
  o0e1from: "",
  email: "lea@example.org",
  new_from: "19:00",
  new_hours: "2",
};

/** The option fields of B, as the page writes them for a copy of A. */
const B_AS_A = {
  o1e0name: "Dinner",
  o1e0day: "2101-12-16",
  o1e0from: "19:00",
  o1e0to: "21:00",
  o1e1name: "",
  o1e1day: "2101-12-17",
  o1e1from: "",
};

it("each event has its own name, the question's title when empty, and keeps its identity through edits", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...WEEKEND, act: "and:0" });
  await f.send({ ...WEEKEND, act: "save" });
  const before = await f.body();
  expect(before?.options[0]?.map((e) => e.title)).toEqual(["Dinner", null]);
  const sids = before?.options[0]?.map((e) => e.sid) ?? [];
  expect(new Set(sids).size).toBe(2);
  const page = await (await b.request(f.path)).text();
  expect(page).toContain('name="o0e0name" maxlength="200" value="Dinner" placeholder="Weekend"');
  expect(page).toContain('name="o0e1name" maxlength="200" value="" placeholder="Weekend"');
  // Moved and renamed, it is still the same event.
  await f.send({ ...WEEKEND, o0e0name: "  Late dinner ", o0e0from: "20:00", act: "save" });
  const after = await f.body();
  expect(after?.options[0]?.map((e) => [e.sid, e.title, e.startLocal])).toEqual([
    [sids[0], "Late dinner", "2101-12-16T20:00"],
    [sids[1], null, "2101-12-17"],
  ]);
});

it("+ Like A copies A with its identities; B's changes from A are drawn and listed, See A shows A instead", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...WEEKEND, act: "and:0" });
  const one = await (await b.request(f.path)).text();
  expect(one).toContain('<button type="submit" name="act" value="like">+ Like A</button>');
  await f.send({ ...WEEKEND, act: "like" });
  const copied = await f.body();
  expect(copied?.options).toHaveLength(2);
  expect(copied?.options[1]).toEqual(copied?.options[0]);
  const same = await (await b.request(f.path)).text();
  expect(same).toContain(">B</span> like A</legend>");
  expect(same).toContain("Same as A — change something to make it a choice.");
  expect(same).toContain('<button type="submit" name="act" value="see:1">See A</button>');
  // The copy is a choice once something changes: the hike moves to Sunday.
  await f.send({ ...WEEKEND, ...B_AS_A, o1e1day: "2101-12-18", act: "save" });
  const moved = await (await b.request(f.path)).text();
  expect(moved).toContain("<summary>1 change from A</summary>");
  expect(moved).toMatch(
    /<li class="chg"><strong>Weekend<\/strong> moved [^<]*Sat 17 Dec[^<]*<\/li>/,
  );
  expect(moved).toContain('<section class="week" id="w-2101-12-12">');
  // B's week rows draw B, in B's colour, with where the hike was as a ghost.
  expect(moved).toMatch(/class="rib ghost[^"]*" style="[^"]*--x:var\(--o1\)/);
  // A renamed and a new event are changes too.
  await f.send({ ...WEEKEND, ...B_AS_A, o1e0name: "Pizza", act: "and:1" });
  await f.send({
    ...WEEKEND,
    ...B_AS_A,
    o1e0name: "Pizza",
    o1e2day: "2101-12-19",
    o1e2from: "",
    act: "save",
  });
  const three = await (await b.request(f.path)).text();
  expect(three).toContain("<summary>2 changes from A</summary>");
  expect(three).toContain("<strong>Dinner</strong> renamed <strong>Pizza</strong>");
  expect(three).toContain("New: <strong>Weekend</strong>, Mon 19 Dec, all day");

  // See A saves first and shows A in B's place; Back returns to B.
  const all = { ...WEEKEND, ...B_AS_A, o1e0name: "Pizza", o1e2day: "2101-12-19", o1e2from: "" };
  const see = await f.send({ ...all, act: "see:1" });
  expect(see.headers.get("location")).toBe(`${f.path}?saved=1&s=1`);
  const seeing = await (await b.request(see.headers.get("location") ?? "")).text();
  expect(seeing).toContain("Showing <strong>A</strong>, which B is like.");
  expect(seeing).toContain('<input type="hidden" name="s" value="1" />');
  expect(seeing).not.toContain("changes from A");
  // Another button keeps it; Back clears it.
  expect((await f.send({ ...all, s: "1", act: "save" })).headers.get("location")).toBe(
    `${f.path}?saved=1&s=1`,
  );
  expect((await f.send({ ...all, s: "1", act: "see:" })).headers.get("location")).toBe(
    `${f.path}?saved=1`,
  );
  // Only an option made like A can show A: anything else is ignored.
  for (const s of ["0", "2", "x", "-1"])
    expect(await (await b.request(`${f.path}?s=${s}`)).text()).not.toContain(
      "Showing <strong>A</strong>",
    );
});

it("an option made any other way shares nothing with A: no changes drawn", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...WEEKEND, act: "option" });
  await f.send({ ...WEEKEND, o1e0day: "2101-12-23", act: "save" });
  const page = await (await b.request(f.path)).text();
  expect(page).not.toContain("like A</legend>");
  expect(page).not.toContain("from A");
  expect(page).not.toContain('value="see:1"');
  expect(madeLike([{ sid: "a" }], [{ sid: "b" }, {}])).toBe(false);
  expect(madeLike([{ sid: "a" }, {}], [{}, { sid: "a" }])).toBe(true);
  expect(madeLike([{}], [{}])).toBe(false);
});

it("asked, an option made like A keeps A's identities and is like A; names go onto the events", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...WEEKEND, act: "and:0" });
  await f.send({ ...WEEKEND, act: "like" });
  // Unchanged, the copy is the same option as A, and asking says so.
  const twin = await f.send({ ...WEEKEND, ...B_AS_A, act: "ask" });
  expect(twin.status).toBe(400);
  expect(await twin.text()).toContain("Two of the options are the same.");
  // Two options the same times but different names are two options.
  const res = await f.send({ ...WEEKEND, ...B_AS_A, o1e0name: "Pizza", act: "ask" });
  expect(res.status).toBe(303);
  const thread = res.headers.get("location") ?? "";
  const access = await findThreadForMember(b.storage, thread.split("/").at(-1) ?? "", f.mara);
  if (access === null) throw new Error("thread");
  expect(access.thread.name).toBe("Weekend");
  const plans = await listPlans(b.storage, access);
  const [a, bb] = plans;
  if (a === undefined || bb === undefined) throw new Error("plans");
  expect(plans.map((p) => [p.letter, p.name])).toEqual([
    ["A", "Weekend"],
    ["B", "Weekend"],
  ]);
  expect(a.answersId).toBeNull();
  expect(bb.answersId).toBe(a.id);
  expect(bb.events.map((e) => e.sid).sort()).toEqual(a.events.map((e) => e.sid).sort());
  expect(a.events.map((e) => e.title)).toEqual(["Dinner", "Weekend"]);
  expect(bb.events.map((e) => e.title)).toEqual(["Pizza", "Weekend"]);
  // The thread and B's page say "like A", never "answers A".
  const threadPage = await (await b.request(thread)).text();
  expect(threadPage).toContain(" · like A · ");
  expect(threadPage).not.toContain("answers A");
  const bPage = await (await b.request(`${thread}/p/${bb.id}`)).text();
  expect(bPage).toContain("like A · ");
  expect(bPage).toContain("1 change from A");
  const seeA = await (await b.request(`${thread}/p/${bb.id}?see=base`)).text();
  expect(seeA).toContain("Showing the option this is like.");
});

it("an option made fresh is asked with identities of its own and no plan to be like", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...WEEKEND, o0e0name: "", act: "option" });
  const res = await f.send({
    ...WEEKEND,
    o0e0name: "",
    o1e0day: "2101-12-23",
    o1e0from: "19:00",
    o1e0to: "21:00",
    act: "ask",
  });
  const thread = res.headers.get("location") ?? "";
  const access = await findThreadForMember(b.storage, thread.split("/").at(-1) ?? "", f.mara);
  if (access === null) throw new Error("thread");
  const plans = await listPlans(b.storage, access);
  expect(plans.map((p) => p.answersId)).toEqual([null, null]);
  expect(plans.map((p) => p.events.map((e) => e.title))).toEqual([["Weekend"], ["Weekend"]]);
  const sids = plans.flatMap((p) => p.events.map((e) => e.sid));
  expect(new Set(sids).size).toBe(2);
  expect(await (await b.request(thread)).text()).not.toContain(" · like A");
});

it("an identity given twice in one option is kept once; the other event gets one of its own", async () => {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "mara@example.org");
  const mara = (await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW })).id;
  const ev = (day: string) => ({
    allDay: true,
    startLocal: day,
    endLocal: day.replace(/16$/, "17"),
  });
  const { threadId, statements } = await questionThreadStatements(b.storage, {
    creatorId: mara,
    group: null,
    fields: { title: "Weekend", location: null, description: null, tzid: "Europe/Prague" },
    options: [
      [
        { ...ev("2101-12-16"), sid: "s1", title: null },
        {
          allDay: false,
          startLocal: "2101-12-16T09:00",
          endLocal: "2101-12-16T10:00",
          sid: "s1",
          title: "  Run ",
        },
      ],
    ],
    now: NOW,
  });
  await b.storage.batch(statements);
  const access = await findThreadForMember(b.storage, threadId, mara);
  if (access === null) throw new Error("thread");
  const [only] = await listPlans(b.storage, access);
  const events = only?.events ?? [];
  expect(events.map((e) => e.title).sort()).toEqual(["Run", "Weekend"]);
  expect(events.filter((e) => e.sid === "s1")).toHaveLength(1);
  expect(new Set(events.map((e) => e.sid)).size).toBe(2);
});
