// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { SIGNED_IN } from "../../src/events/response.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import {
  castVote,
  createPollThread,
  type PlanStatus,
  questionStep,
  withdrawPlan,
} from "../../src/plans/plan.js";
import { findThreadForMember } from "../../src/plans/thread.js";
import { issueVoteLinks } from "../../src/plans/vote-link.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import { VOTE_PATH } from "../../src/web/routes/respond.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// The four-step status line on every page of a question (DESIGN §10 *Asking when*, rc50):
// Draft, Asking, Decided — only for whoever pressed choose, while it waits its minute — and
// In calendars once it has run; Withdrawn when every option was taken back.

const NOW = "2101-12-01T09:00:00.000Z";

const ASKING = '<p class="askstatus"><strong>Asking</strong> · step 2 of 4</p>';
const DECIDED =
  '<p class="askstatus"><strong>Decided</strong> · step 3 of 4 · nobody has been told yet</p>';
const IN_CALENDARS = '<p class="askstatus"><strong>In calendars</strong> · step 4 of 4</p>';
const WITHDRAWN =
  '<p class="askstatus"><strong>Withdrawn</strong> · every option was withdrawn</p>';

describe("questionStep", () => {
  const of = (statuses: readonly PlanStatus[], choosing = false) =>
    questionStep(
      statuses.map((status) => ({ status })),
      choosing,
    );

  it("is Draft with nothing sent, whatever is held", () => {
    expect(of([])).toBe("draft");
    expect(of(["draft"])).toBe("draft");
    expect(of(["draft"], true)).toBe("draft");
  });

  it("is Asking while an option is on the table, and Decided while the viewer's choice waits", () => {
    expect(of(["on_table"])).toBe("asking");
    expect(of(["draft", "withdrawn", "on_table"])).toBe("asking");
    expect(of(["on_table"], true)).toBe("decided");
    // A new option after an earlier choice is asked again.
    expect(of(["accepted", "on_table"])).toBe("asking");
  });

  it("is In calendars once one is accepted, and Withdrawn when every option was taken back", () => {
    expect(of(["accepted", "replaced"])).toBe("in_calendars");
    expect(of(["withdrawn", "accepted"], true)).toBe("in_calendars");
    expect(of(["withdrawn", "withdrawn"])).toBe("withdrawn");
    expect(of(["draft", "withdrawn"])).toBe("withdrawn");
    expect(of(["replaced"])).toBe("withdrawn");
  });
});

/** Mara's two-time poll with Lea and Cat; Lea's yes makes A lead. */
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
  await castVote(b.storage, await as(lea.id), {
    planId: a,
    answer: "yes",
    now: NOW,
    arrival: SIGNED_IN,
  });
  const issued = await issueVoteLinks(b.storage, await as(mara.id), { now: NOW });
  if (issued.kind !== "issued") throw new Error(issued.kind);
  const catLink = issued.links.find((l) => l.personId === cat.id)?.token ?? "";
  const thread = `${PLANS_PATH}/${threadId}`;
  const text = async (path: string) => (await b.request(path)).text();
  return {
    mara: mara.id,
    as,
    a,
    second,
    thread,
    plan: `${thread}/p/${a}`,
    vote: `${VOTE_PATH}?t=${encodeURIComponent(catLink)}`,
    text,
  };
}

/** Mara makes the shared link on the thread page; its path. */
async function shareLink(b: Browser, thread: string): Promise<string> {
  const res = await b.request(`${thread}/share`, post({ csrf: (await home(b)).csrf }));
  return /https:\/\/whendowe\.example(\/s\?t=[^\s<"]+)/.exec(await res.text())?.[1] ?? "";
}

it("every page of a question says Asking while options are on the table", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  const shared = await shareLink(b, f.thread);
  expect(shared).not.toBe("");
  for (const path of [f.thread, f.plan, f.vote, shared]) {
    const page = await f.text(path);
    expect(page, path).toContain(ASKING);
    expect(page, path).not.toContain("step 1 of 4");
  }
});

it("Decided is seen only by whoever pressed choose, while it waits; then In calendars for all", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  const shared = await shareLink(b, f.thread);
  await b.request(`${f.plan}/accept`, post({ csrf: (await home(b)).csrf }));
  expect(await f.text(f.thread)).toContain(DECIDED);
  expect(await f.text(f.plan)).toContain(DECIDED);
  // The vote link and the shared link show no one's held choice.
  expect(await f.text(f.vote)).toContain(ASKING);
  expect(await f.text(shared)).toContain(ASKING);
  // Lea, signed in on this browser too, sees nothing has changed.
  await addAccount(b, "lea@example.org");
  expect(await f.text(f.thread)).toContain(ASKING);
  expect(await f.text(f.plan)).toContain(ASKING);

  expect(await b.pass()).toBe(1);
  for (const path of [f.thread, f.plan, f.vote])
    expect(await f.text(path), path).toContain(IN_CALENDARS);
  // A decided question's shared link is gone (rc25); nothing to show it on.
});

it("a question whose options were all withdrawn says so in place of a step", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  const access = await f.as(f.mara);
  await withdrawPlan(b.storage, access, { planId: f.a, now: NOW });
  await withdrawPlan(b.storage, access, { planId: f.second, now: NOW });
  for (const path of [f.thread, f.plan, f.vote]) {
    const page = await f.text(path);
    expect(page, path).toContain(WITHDRAWN);
    expect(page, path).not.toContain("of 4");
  }
});
