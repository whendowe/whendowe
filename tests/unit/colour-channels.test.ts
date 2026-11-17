// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { SIGNED_IN } from "../../src/events/response.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { castVote, createPollThread, withdrawPlan } from "../../src/plans/plan.js";
import { findThreadForMember } from "../../src/plans/thread.js";
import { issueVoteLinks } from "../../src/plans/vote-link.js";
import { pickerAssets } from "../../src/web/picker.js";
import { PLAN_STYLE } from "../../src/web/plan-editor.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import { VOTE_PATH } from "../../src/web/routes/respond.js";
import { addAccount, type Browser, browser } from "../property/one-browser.js";

// The colour channels (DESIGN §10 *Asking when*, rc50): the brand colour on actions only, one
// attention colour for what waits for you, busy time as hatching.

const NOW = "2101-12-01T09:00:00.000Z";

it("the brand colour is on the main button and a pressed choice of view, and nothing else", () => {
  const plan = PLAN_STYLE.value;
  expect([...plan.matchAll(/^.*var\(--accent\).*$/gm)].map((m) => m[0].trim())).toEqual([
    ".pl .primary { background: var(--accent); color: var(--on); border-color: transparent; font-weight: 700; }",
    ".pl .seg.viewswitch button[aria-pressed=true] { background: var(--accent); color: var(--on); }",
  ]);
  // The picker writes the brand colour out: its choice of kind, and option A's own hue.
  const picker = pickerAssets().value;
  expect([...picker.matchAll(/^.*#0e6b66.*$/gm)].map((m) => m[0].trim().split(" {")[0])).toEqual([
    ".wd-o0",
    ".wd-kind button[aria-pressed=true]",
  ]);
  // Busy is hatching on both, not a dot.
  expect(plan).toContain(".pl .dh.busy { background-image: repeating-linear-gradient(");
  expect(picker).toContain(".wd-busy { background-image: repeating-linear-gradient(");
  expect(plan).not.toContain(".dh.busy::after");
  expect(picker).not.toContain(".wd-busy::after");
});

/** Mara's two-time poll with Lea and Cat; Mara answers both, Lea only A. */
async function poll(b: Browser) {
  await addAccount(b, "mara@example.org");
  const mara = await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW });
  const lea = await findOrCreatePerson(b.storage, "lea@example.org", { now: NOW });
  const cat = await findOrCreatePerson(b.storage, "cat@example.org", { now: NOW });
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
    people: [lea.id, cat.id],
    now: NOW,
  });
  const as = async (id: string) => {
    const a = await findThreadForMember(b.storage, threadId, id);
    if (a === null) throw new Error("member");
    return a;
  };
  const [a = "", second = ""] = planIds;
  for (const [who, planId] of [
    [mara.id, a],
    [mara.id, second],
    [lea.id, a],
  ] as const)
    await castVote(b.storage, await as(who), {
      planId,
      answer: "yes",
      now: NOW,
      arrival: SIGNED_IN,
    });
  const issued = await issueVoteLinks(b.storage, await as(mara.id), { now: NOW });
  if (issued.kind !== "issued") throw new Error(issued.kind);
  const leaLink = issued.links.find((l) => l.personId === lea.id)?.token ?? "";
  const thread = `${PLANS_PATH}/${threadId}`;
  return {
    maraAccess: await as(mara.id),
    a,
    second,
    thread,
    vote: `${VOTE_PATH}?t=${encodeURIComponent(leaLink)}`,
    text: async (path: string) => (await b.request(path)).text(),
  };
}

const headOf = (page: string) => /<div class="head[^"]*">/.exec(page)?.[0] ?? "";

it("what waits for you carries the attention mark, and what doesn't, doesn't", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);

  // Mara has answered both: nothing waits for her.
  const maraHome = await f.text("/");
  expect(maraHome).toContain("Pizza");
  expect(maraHome).not.toContain('class="attn"');
  const maraThread = await f.text(f.thread);
  expect(maraThread).not.toContain('class="attn"');
  expect(maraThread).not.toContain('class="btn waits"');
  expect(headOf(await f.text(`${f.thread}/p/${f.second}`))).toBe('<div class="head">');

  await addAccount(b, "lea@example.org");
  // Home and the plans list: the question waits for Lea's vote.
  expect(await f.text("/")).toContain('<strong class="attn">1 waiting for your vote</strong>');
  const thread = await f.text(f.thread);
  // The thread: B waits, on its card and in the answers grid; A, answered, doesn't.
  expect(thread).toContain(`<a class="btn waits" href="${f.thread}/p/${f.second}">`);
  expect(thread).not.toContain(`<a class="btn waits" href="${f.thread}/p/${f.a}">`);
  expect(thread).toMatch(
    new RegExp(
      `href="${f.thread}/p/${f.second}"><span class="letter">B</span> <span class="attn">`,
    ),
  );
  expect(thread).toMatch(
    new RegExp(`href="${f.thread}/p/${f.a}"><span class="letter">A</span> <span>`),
  );
  // The plan pages: B's header and its Not answered; A's header is plain.
  const b2 = await f.text(`${f.thread}/p/${f.second}`);
  expect(headOf(b2)).toBe('<div class="head waits">');
  expect(b2).toContain('<strong class="attn">Not answered</strong>');
  expect(headOf(await f.text(`${f.thread}/p/${f.a}`))).toBe('<div class="head">');

  // Lea's vote link: B's card waits, A's doesn't.
  const vote = await f.text(f.vote);
  expect(vote.match(/<li class="waits">/g)?.length).toBe(1);
  const waiting = vote.slice(vote.indexOf('<li class="waits">'));
  expect(waiting.slice(0, waiting.indexOf("</li>"))).toContain(`plan_${f.second}`);
  const list = vote.slice(vote.indexOf("Which of these work for you?"), vote.indexOf("</ul>"));
  expect(list.match(/<li[^>]*>/g)).toEqual(["<li>", '<li class="waits">']);

  // Withdrawn, B no longer waits for anyone: its page's header is plain.
  await withdrawPlan(b.storage, f.maraAccess, { planId: f.second, now: NOW });
  expect(headOf(await f.text(`${f.thread}/p/${f.second}`))).toBe('<div class="head">');
});
