// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { findOrCreatePerson } from "../../src/people/person.js";
import {
  acceptPlan,
  addDraftEvent,
  createPollThread,
  sendDraft,
  startDraft,
} from "../../src/plans/plan.js";
import { findThreadForMember, leaveThread } from "../../src/plans/thread.js";
import { issueVoteLinks } from "../../src/plans/vote-link.js";
import { VOTE_PATH } from "../../src/web/routes/respond.js";
import { type Browser, browser, post } from "../property/one-browser.js";

// The vote link's page (DESIGN §10 rc26): no account, no session, the GET writes
// nothing, and every POST re-checks the link and the thread.

const NOW = "2101-11-01T09:00:00.000Z";

async function pollWith(
  b: Browser,
  names: readonly string[],
  title = "Picnic",
  place: { location: string | null; description: string | null } = {
    location: "<b>The park</b>",
    description: "Bring a cake",
  },
) {
  const people = [];
  for (const n of ["mara", ...names])
    people.push(await findOrCreatePerson(b.storage, `${n}@example.org`, { now: NOW }));
  const [mara, ...rest] = people;
  if (mara === undefined) throw new Error("mara");
  const { threadId, planIds } = await createPollThread(b.storage, {
    creatorId: mara.id,
    group: null,
    fields: { title, ...place, allDay: true, tzid: null },
    candidates: [
      { startLocal: "2101-11-21", endLocal: "2101-11-22" },
      { startLocal: "2101-11-14", endLocal: "2101-11-15" },
    ],
    people: rest.map((p) => p.id),
    now: NOW,
  });
  const as = async (id: string) => {
    const a = await findThreadForMember(b.storage, threadId, id);
    if (a === null) throw new Error("member");
    return a;
  };
  const issued = await issueVoteLinks(b.storage, await as(mara.id), { now: NOW });
  if (issued.kind !== "issued") throw new Error(issued.kind);
  const link = (i: number) => {
    const l = issued.links.find((x) => x.personId === rest[i]?.id);
    return `${VOTE_PATH}?t=${encodeURIComponent(l?.token ?? "")}`;
  };
  const token = (i: number) => new URL(link(i), "http://x").searchParams.get("t") ?? "";
  return { mara, rest, threadId, planIds, as, link, token };
}

const vote = (b: Browser, t: string, answers: Record<string, string>) =>
  b.request(VOTE_PATH, post({ t, ...answers }));

it("the page shows what's on the table, escaped, as nobody signed in, and writes nothing", async () => {
  const b = await browser({ now: () => NOW });
  const f = await pollWith(b, ["david", "ana"], "<script>x</script>");
  const before = b.writes;
  const res = await b.request(f.link(0));
  expect(res.status).toBe(200);
  expect(b.writes).toBe(before);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("set-cookie")).toBeNull();
  const text = await res.text();
  expect(text).toContain("&lt;script&gt;x&lt;/script&gt;");
  expect(text).not.toContain("<script>x</script>");
  expect(text).toContain("📍 &lt;b&gt;The park&lt;/b&gt;");
  expect(text.indexOf("Mon 14 Nov")).toBeLessThan(text.indexOf("Mon 21 Nov"));
  expect(text).toContain(`name="plan_${f.planIds[0]}" value="yes"`);
  expect(text).toContain("1 yes · 0 if need be · 0 no"); // Mara's own yes
  expect(text).toContain("Bring a cake");
  expect(text).toMatch(/from Guest \d{4} · /); // no handle yet: a pseudonym, never the address
  expect(text).toContain("<title>Your vote");
  expect(text).not.toContain("Signed in as");

  const dead = await b.request(`${VOTE_PATH}?t=nope`);
  expect(dead.status).toBe(404);
  expect(await dead.text()).toContain("This link no longer works");
});

it("a vote is saved and comes back checked; a form with no answer is refused", async () => {
  const b = await browser({ now: () => NOW });
  const f = await pollWith(b, ["david", "ana"], "Picnic", { location: null, description: null });
  const [early, late] = f.planIds;
  // Only plan_<id> fields count.
  const stray = await vote(b, f.token(0), { [`xplan_${early}`]: "yes", answer: "yes" });
  expect(stray.status).toBe(400);
  expect(stray.headers.get("cache-control")).toBe("no-store");
  expect(stray.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await stray.text()).toContain("Pick an answer first.");
  const res = await vote(b, f.token(0), { [`plan_${early}`]: "ifneedbe", [`plan_${late}`]: "no" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${f.link(0)}&saved=1`);
  const text = await (await b.request(res.headers.get("location") ?? "")).text();
  expect(text).toContain("Thanks — your vote is saved.");
  expect(text).toMatch(new RegExp(`name="plan_${early}" value="ifneedbe" checked`));
  expect(text).toMatch(new RegExp(`name="plan_${late}" value="no" checked`));
  expect(text).not.toMatch(new RegExp(`name="plan_${early}" value="yes" checked`));
  expect(text).not.toContain("📍");
  expect((await vote(b, f.token(0), {})).status).toBe(400);
  expect((await vote(b, "nope", { [`plan_${early}`]: "yes" })).status).toBe(404);
});

it("between two, the voter's yes agrees the time; a second yes in the same form is no error", async () => {
  const b = await browser({ now: () => NOW });
  const f = await pollWith(b, ["david"]);
  const [early, late] = f.planIds;
  const res = await vote(b, f.token(0), { [`plan_${early}`]: "yes", [`plan_${late}`]: "yes" });
  expect(res.status).toBe(303);
  const text = await (await b.request(f.link(0))).text();
  expect(text).toContain("There's nothing to vote on any more.");
});

it("a plan of several events is shown by its name and span", async () => {
  const b = await browser({ now: () => NOW });
  const f = await pollWith(b, ["david", "ana"]);
  const mara = await f.as(f.mara.id);
  await startDraft(b.storage, mara, { fromId: null, rest: false, replace: false, now: NOW });
  for (const [startLocal, endLocal] of [
    ["2101-12-01", "2101-12-02"],
    ["2101-12-08", "2101-12-09"],
  ] as const)
    await addDraftEvent(b.storage, mara, {
      title: "Two",
      allDay: true,
      startLocal,
      endLocal,
      who: [],
      now: NOW,
    });
  await sendDraft(b.storage, mara, { now: NOW });
  const text = await (await b.request(f.link(0))).text();
  expect(text).toMatch(/<strong>Plan C<\/strong> · 2 events, /);
});

it("decided meanwhile, or left: the link says so", async () => {
  const b = await browser({ now: () => NOW });
  const f = await pollWith(b, ["david", "ana"]);
  const [early, late] = f.planIds;
  await acceptPlan(b.storage, await f.as(f.mara.id), { planId: late ?? "", now: NOW });
  const res = await vote(b, f.token(0), { [`plan_${early}`]: "yes" });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("decided meanwhile");

  await leaveThread(b.storage, await f.as(f.rest[1]?.id ?? ""), NOW);
  expect((await b.request(f.link(1))).status).toBe(404);
  expect((await vote(b, f.token(1), { [`plan_${early}`]: "yes" })).status).toBe(404);
});
