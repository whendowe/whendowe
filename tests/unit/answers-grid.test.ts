// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { SIGNED_IN } from "../../src/events/response.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { castVote, createPollThread } from "../../src/plans/plan.js";
import { findThreadForMember } from "../../src/plans/thread.js";
import { GRID_MAX_PEOPLE, PLANS_PATH } from "../../src/web/routes/plans.js";
import { addAccount, type Browser, browser } from "../property/one-browser.js";

// Where it stands (DESIGN §10 *Asking when*, rc46): on the thread page, people down and the
// options on the table across, each cell its answer; how many can come under each; the
// option that leads outlined, and none on a tie; folded to bars for a crowd.

const NOW = "2101-12-01T09:00:00.000Z";

async function poll(b: Browser, names: readonly string[]) {
  await addAccount(b, "mara@example.org");
  const mara = await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW });
  const people = [];
  for (const n of names)
    people.push((await findOrCreatePerson(b.storage, `${n}@example.org`, { now: NOW })).id);
  const { threadId, planIds } = await createPollThread(b.storage, {
    creatorId: mara.id,
    group: null,
    fields: {
      title: "Pizza",
      location: null,
      description: null,
      allDay: false,
      tzid: "Europe/Prague",
    },
    candidates: [
      { startLocal: "2101-12-17T19:00", endLocal: "2101-12-17T21:00" },
      { startLocal: "2101-12-18T19:00", endLocal: "2101-12-18T21:00" },
    ],
    people,
    now: NOW,
  });
  const as = async (id: string) => {
    const a = await findThreadForMember(b.storage, threadId, id);
    if (a === null) throw new Error("member");
    return a;
  };
  const answer = async (personId: string, planId: string, a: "yes" | "ifneedbe" | "no") =>
    castVote(b.storage, await as(personId), { planId, answer: a, now: NOW, arrival: SIGNED_IN });
  const page = async () => (await b.request(`${PLANS_PATH}/${threadId}`)).text();
  return { mara: mara.id, people, threadId, planIds, answer, page };
}

const grid = (page: string) => /<section class="stands">[\s\S]*?<\/section>/.exec(page)?.[0] ?? "";

it("people down, options across, each cell its answer; you first; who hasn't answered", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b, ["lea", "cat", "tom"]);
  const [thu = "", fri = ""] = f.planIds;
  const [lea = "", cat = ""] = f.people;
  await f.answer(lea, thu, "yes");
  await f.answer(lea, fri, "no");
  await f.answer(cat, fri, "ifneedbe");
  const g = grid(await f.page());
  expect(g).toContain("<h3>Where it stands</h3>");
  // Columns: the options, by letter and time, linked to their pages.
  expect(g).toContain(`href="${PLANS_PATH}/${f.threadId}/p/${thu}"`);
  expect(g).toMatch(/>A<\/span> <span>Sat 17 Dec, 19:00–21:00<\/span>/);
  expect(g).toMatch(/>B<\/span> <span>Sun 18 Dec, 19:00–21:00<\/span>/);
  // Rows: Mara (who is viewing) first, then the rest in the thread's order.
  const rows = [...g.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map((m) => [
    m[1],
    [...(m[2] ?? "").matchAll(/<td class="a-(\w+)"/g)].map((c) => c[1]),
  ]);
  expect(rows[0]?.[0]).toMatch(/ <span class="muted">you<\/span>$/);
  expect(rows.at(-1)?.[0]).toBe("Can come"); // the foot row, after the people
  expect(rows.slice(0, -1).map((r) => r[1])).toEqual([
    ["yes", "yes"], // the poll carries Mara's yes to every time
    ["yes", "no"],
    ["none", "ifneedbe"],
    ["none", "none"],
  ]);
  expect(g).toContain(
    '<td class="a-none"><span aria-hidden="true">–</span><span class="vh">no answer yet</span></td>',
  );
  // Can come: a yes or an if need be. A: Mara, Lea = 2. B: Mara, Cat = 2 — but A has more yeses.
  expect(g).toMatch(/<th scope="row">Can come<\/th><td class="lead">2<\/td><td>2<\/td>/);
  expect(g).toContain(
    `<th scope="col" class="lead"><a href="${PLANS_PATH}/${f.threadId}/p/${thu}"`,
  );
  expect(g.match(/Not answered yet: ([^<]*)</)?.[1]?.split(", ")).toHaveLength(1); // Tom
});

it("a tie leads nothing, and nothing leads before anyone can come", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b, ["lea"]);
  const [thu = "", fri = ""] = f.planIds;
  // Both carry Mara's yes: a tie.
  expect(grid(await f.page())).not.toContain('class="lead"');
  await f.answer(f.people[0] ?? "", fri, "ifneedbe");
  // B: 2 can come (one yes), A: 1 — B leads.
  expect(grid(await f.page())).toMatch(
    new RegExp(`<th scope="col" class="lead"><a href="[^"]+/p/${fri}"`),
  );

  const c = await browser({ now: () => NOW });
  const g = await poll(c, ["lea", "cat"]);
  for (const p of g.planIds) await g.answer(g.mara, p, "no");
  expect(grid(await g.page())).not.toContain('class="lead"');
  expect(thu).not.toBe("");
});

it("names are escaped; with nothing on the table there is no grid", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b, ["lea"]);
  await b.storage.batch([
    {
      sql: "UPDATE plan_thread_member SET handle = ? WHERE thread_id = ? AND person_id = ?",
      params: ["<b>Lea</b>", f.threadId, f.people[0] ?? ""],
    },
  ]);
  const g = grid(await f.page());
  expect(g).toContain("&lt;b&gt;Lea&lt;/b&gt;");
  expect(g).not.toContain("<b>Lea</b>");
  await b.storage.batch([
    { sql: "UPDATE plan SET status = 'withdrawn' WHERE thread_id = ?", params: [f.threadId] },
  ]);
  expect(await f.page()).not.toContain("Where it stands");
});

it(`more than ${GRID_MAX_PEOPLE} people fold to a bar per option, the counts still there`, async () => {
  const b = await browser({ now: () => NOW });
  const names = Array.from({ length: GRID_MAX_PEOPLE }, (_, i) => `p${i}`);
  const f = await poll(b, names); // Mara + 15 = 16
  const [thu = "", fri = ""] = f.planIds;
  for (const id of f.people.slice(0, 6)) await f.answer(id, thu, "yes");
  for (const id of f.people.slice(6, 8)) await f.answer(id, thu, "ifneedbe");
  const g = grid(await f.page());
  expect(g).not.toContain("<table");
  expect(g).toContain('<ul class="bars">');
  // A: 7 yes (Mara + 6), 2 if need be, of 16 → 9 can come; B: Mara's yes only.
  expect(g).toMatch(
    /<li class="lead">.*?<span class="bar" role="img" aria-label="7 yes, 2 if need be, of 16"><span class="y" style="width:44%"><\/span><span class="m" style="width:13%"><\/span><\/span><span class="n">9<\/span><\/li>/,
  );
  expect(g).toContain('aria-label="1 yes, 0 if need be, of 16"');
  expect(g).toContain("16 people. Each option's page has the names.");
  expect(fri).not.toBe("");
});

it("exactly the limit is still a grid", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(
    b,
    Array.from({ length: GRID_MAX_PEOPLE - 1 }, (_, i) => `q${i}`),
  ); // Mara + 14 = 15
  expect(grid(await f.page())).toContain("<table");
});
