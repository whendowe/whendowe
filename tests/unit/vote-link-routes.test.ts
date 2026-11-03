// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { MailCapReachedError } from "../../src/mail/capped.js";
import { findOrCreatePerson, guestName } from "../../src/people/person.js";
import {
  acceptPlan,
  addDraftEvent,
  createPollThread,
  sendDraft,
  startDraft,
  suggestTime,
} from "../../src/plans/plan.js";
import { findThreadForMember, leaveThread } from "../../src/plans/thread.js";
import { issueVoteLinks } from "../../src/plans/vote-link.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import { VOTE_PATH } from "../../src/web/routes/respond.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

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

/** The page's Open Graph tags (§10 rc25), as a chat app reads them. */
const og = (text: string) =>
  Object.fromEntries(
    [...text.matchAll(/<meta property="og:(\w+)" content="([^"]*)" \/>/g)].map((m) => [m[1], m[2]]),
  );

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
  expect(text).not.toContain("<h2>Notes</h2>");

  const dead = await b.request(`${VOTE_PATH}?t=nope`);
  expect(dead.status).toBe(404);
  expect(await dead.text()).toContain("This link no longer works");
});

it("a pasted vote link's card shows the title and times, never the place, notes or people", async () => {
  const b = await browser({ now: () => NOW });
  const f = await pollWith(b, ["david", "ana"], "<i>Picnic</i>");
  expect(og(await (await b.request(f.link(0))).text())).toEqual({
    type: "website",
    site_name: "WhenDoWe",
    title: "&lt;i&gt;Picnic&lt;/i&gt;",
    description: "Which of these work for you? Mon 14 Nov, all day · Mon 21 Nov, all day",
  });
  await acceptPlan(b.storage, await f.as(f.mara.id), { planId: f.planIds[0] ?? "", now: NOW });
  expect(og(await (await b.request(f.link(0))).text()).description).toBe(
    "Nothing to vote on any more.",
  );
  expect(og(await (await b.request(`${VOTE_PATH}?t=nope`)).text())).toEqual({});
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
  // In the card, its count and span: a plan's name may name someone. Three times, all shown.
  const card = og(text).description ?? "";
  expect(card).toMatch(/^Which of these work for you\? (.+, all day · ){2}2 events, \S/);
  expect(card).not.toContain("Plan C");
  expect(card).not.toContain("more");
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

// --- the organizer emails them (P6c part 2) ------------------------------------------

async function signedInPoll(b: Browser, names: readonly string[]) {
  await addAccount(b, "mara@example.org");
  const f = await pollWith(b, names);
  // pollWith issued links for the tests above; here the organizer sends the first ones.
  await b.storage.batch([
    { sql: "DELETE FROM plan_vote_token WHERE thread_id = ?", params: [f.threadId] },
  ]);
  return { ...f, thread: `${PLANS_PATH}/${f.threadId}` };
}

async function sendLinks(b: Browser, thread: string) {
  return b.request(`${thread}/links`, post({ csrf: (await home(b)).csrf }));
}

it("the organizer emails each member their own link, in the thread's name for them", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(b, ["david", "ana"]);
  expect(await (await b.request(f.thread)).text()).toContain("Email vote links");
  const res = await sendLinks(b, f.thread);
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("Sent to 2 people.");
  expect(body).not.toMatch(/Couldn(&#39;|')t send/);
  const mails = b.sent.filter((m) => m.subject === 'When can you make "Picnic"?');
  expect(mails.map((m) => m.to).sort()).toEqual(["ana@example.org", "david@example.org"]);
  const david = mails.find((m) => m.to === "david@example.org");
  expect(david?.cause).toMatchObject({ kind: "from", senderId: f.mara.id, groupId: null });
  // Named as the thread shows her, never by her address.
  const mara = guestName(f.threadId, f.mara.id);
  expect(david?.text).toContain(`${mara} is finding a time for "Picnic"`);
  expect(david?.cause).toMatchObject({ why: `${mara} added this address to a plan on WhenDoWe` });
  expect(david?.text).toContain("Vote here — no account, nothing to install:\nhttps://");
  expect(JSON.stringify(david)).not.toContain("mara@example.org");
  expect(david?.text).toContain("works for 14 days");
  const url = /https:\/\/whendowe\.example(\/vote\?t=\S+)/.exec(david?.text ?? "")?.[1] ?? "";
  const page = await b.request(url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Which of these work for you?");

  const again = await sendLinks(b, f.thread);
  expect(await again.text()).toContain("Sent to 0 people. 2 already got a link in the last hour.");
});

it("only the organizer, with CSRF, while something is on the table", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(b, ["david", "ana"]);
  expect((await b.request(`${f.thread}/links`, post({ csrf: "nope" }))).status).toBe(403);
  await acceptPlan(b.storage, await f.as(f.mara.id), { planId: f.planIds[0] ?? "", now: NOW });
  expect(await (await b.request(f.thread)).text()).not.toContain("Email vote links");
  const closed = await sendLinks(b, f.thread);
  expect(closed.status).toBe(409);
  expect(await closed.text()).toContain("Nothing is on the table to vote on.");

  const c = await browser({ now: () => NOW });
  const g = await pollWith(c, ["david", "ana"]);
  await addAccount(c, "david@example.org");
  const thread = `${PLANS_PATH}/${g.threadId}`;
  expect(await (await c.request(thread)).text()).not.toContain("Email vote links");
  const res = await sendLinks(c, thread);
  expect(res.status).toBe(403);
  expect(await res.text()).toContain("Only the organizer sends vote links.");
  expect(c.sent.some((m) => m.subject.startsWith("When can you make"))).toBe(false);
});

it("an undelivered link is withdrawn, and the cap stops the rest from being tried", async () => {
  let failing = true;
  const b = await browser({
    now: () => NOW,
    mailFails: (m) => {
      if (!m.subject.startsWith("When can you make")) return null;
      return failing && m.to === "ana@example.org" ? new Error("bounced") : null;
    },
  });
  const f = await signedInPoll(b, ["ana", "bob", "cid"]);
  const res = await sendLinks(b, f.thread);
  expect(res.status).toBe(503);
  expect(await res.text()).toMatch(
    /Sent to 2 people\. Couldn(&#39;|')t send to 1 — please try again later\./,
  );
  // Ana never got hers, so a retry isn't throttled for her; the others' links stand.
  failing = false;
  expect(await (await sendLinks(b, f.thread)).text()).toContain(
    "Sent to 1 person. 2 already got a link in the last hour.",
  );

  let tried = 0;
  const c = await browser({
    now: () => NOW,
    mailFails: (m) => {
      if (!m.subject.startsWith("When can you make")) return null;
      tried += 1;
      return tried === 1 ? new MailCapReachedError({ daily: 1, monthly: 1 }) : null;
    },
  });
  const g = await signedInPoll(c, ["ana", "bob"]);
  const capped = await sendLinks(c, g.thread);
  expect(capped.status).toBe(503);
  expect(await capped.text()).toMatch(/Sent to 0 people\. Couldn(&#39;|')t send to 2/);
  const left = await c.storage.query({
    sql: "SELECT count(*) AS n FROM plan_vote_token WHERE thread_id = ?",
    params: [g.threadId],
  });
  expect(left[0]?.n).toBe(0);
  expect(tried).toBe(1); // after the cap, nobody else is tried
});

// --- a note with a vote (rc28) -------------------------------------------------------

it("the vote link takes a note, with the votes or alone, and shows everyone's, escaped", async () => {
  const b = await browser({ now: () => NOW });
  const f = await pollWith(b, ["david", "ana"]);
  const [early] = f.planIds;
  const res = await vote(b, f.token(0), {
    [`plan_${early}`]: "no",
    note: "Thursday's <b>bad</b> next week",
  });
  expect(res.status).toBe(303);
  const asAna = await (await b.request(f.link(1))).text();
  expect(asAna).toContain("<h2>Notes</h2>");
  expect(asAna).toMatch(
    /<strong>Guest \d{4}<\/strong> <span class="muted">on Mon 14 Nov – Mon 21 Nov:<\/span> <span[^>]*>Thursday&#39;s &lt;b&gt;bad&lt;\/b&gt; next week<\/span>/,
  );
  // A note alone is an answer too; a note too long is refused, keeping the page.
  expect((await vote(b, f.token(1), { note: "Either works" })).status).toBe(303);
  const long = await vote(b, f.token(1), { note: "x".repeat(501) });
  expect(long.status).toBe(400);
  expect(await long.text()).toContain("Keep it under 500 characters.");
  const notes = await b.storage.query({
    sql: "SELECT body FROM plan_note WHERE thread_id = ? ORDER BY created_at, id",
    params: [f.threadId],
  });
  expect(notes.map((n) => n.body)).toEqual(["Thursday's <b>bad</b> next week", "Either works"]);
  // A blank note is no note: alone it answers nothing; with votes it is dropped.
  const blank = await vote(b, f.token(1), { note: "   " });
  expect(blank.status).toBe(400);
  expect(await blank.text()).toContain("Pick an answer first.");
  expect((await vote(b, f.token(1), { [`plan_${early}`]: "yes", note: "  " })).status).toBe(303);
  // A note on one day says the day once.
  await b.storage.batch([
    {
      sql: `INSERT INTO plan_note (id, thread_id, author_id, first_day, last_day, body, private, created_at)
            VALUES ('one-day', ?, ?, '2101-11-14', '2101-11-14', 'just then', 0, ?)`,
      params: [f.threadId, f.mara.id, NOW],
    },
  ]);
  expect(await (await b.request(f.link(1))).text()).toMatch(
    /<span class="muted">on Mon 14 Nov:<\/span> <span[^>]*>just then/,
  );
  // Decided: a note alone has no days to lie on.
  await acceptPlan(b.storage, await f.as(f.mara.id), { planId: early ?? "", now: NOW });
  const late = await vote(b, f.token(0), { note: "too late" });
  expect(late.status).toBe(409);
});

it("a note from the plan page lands on the thread and on the plans whose days it touches", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(b, ["david", "ana"]);
  const plan = `${f.thread}/p/${f.planIds[0]}`;
  expect(await (await b.request(plan)).text()).toContain("Add a note");
  expect(await (await b.request(f.thread)).text()).not.toContain("Notes</h3>");
  const res = await b.request(
    `${f.thread}/notes`,
    post({ csrf: (await home(b)).csrf, back: f.planIds[0] ?? "", note: "I'll bring the cake" }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(plan);
  expect(await (await b.request(plan)).text()).toMatch(
    /Notes on these days<\/h3><ul class="notes"><li><strong>Guest \d{4}<\/strong>/,
  );
  expect(await (await b.request(f.thread)).text()).toContain("I&#39;ll bring the cake");
  // The latest time starts on the note's last day: it is on it too.
  expect(await (await b.request(`${f.thread}/p/${f.planIds[1]}`)).text()).toContain(
    "Notes on these days",
  );
  // A time suggested after the note, past its days, is not.
  const after = await suggestTime(b.storage, await f.as(f.mara.id), {
    planId: f.planIds[0] ?? "",
    startLocal: "2101-11-28",
    endLocal: "2101-11-29",
    now: NOW,
  });
  if (after.kind !== "suggested") throw new Error(after.kind);
  expect(await (await b.request(`${f.thread}/p/${after.planId}`)).text()).not.toContain(
    "Notes on these days",
  );
  // Without a plan to go back to, back to the thread.
  const toThread = await b.request(
    `${f.thread}/notes`,
    post({ csrf: (await home(b)).csrf, note: "and plates" }),
  );
  expect(toThread.headers.get("location")).toBe(f.thread);
  const empty = await b.request(
    `${f.thread}/notes`,
    post({ csrf: (await home(b)).csrf, back: f.planIds[0] ?? "", note: " " }),
  );
  expect(empty.status).toBe(400);
  expect(await empty.text()).toContain("Write something first.");
  expect(
    (await b.request(`${f.thread}/notes`, post({ csrf: "nope", note: "forged" }))).status,
  ).toBe(403);
  await acceptPlan(b.storage, await f.as(f.mara.id), { planId: f.planIds[0] ?? "", now: NOW });
  const closed = await b.request(
    `${f.thread}/notes`,
    post({ csrf: (await home(b)).csrf, note: "late" }),
  );
  expect(closed.status).toBe(409);
  expect(await closed.text()).toContain("Nothing is on the table to note against.");
});
