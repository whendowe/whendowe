// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { MailCapReachedError, SenderShareReachedError } from "../../src/mail/capped.js";
import { findOrCreatePerson, guestName } from "../../src/people/person.js";
import {
  acceptPlan,
  addDraftEvent,
  createPollThread,
  listPlans,
  sendDraft,
  startDraft,
  suggestTime,
  withdrawPlan,
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
  candidates: readonly { readonly startLocal: string; readonly endLocal: string }[] = [
    { startLocal: "2101-11-21", endLocal: "2101-11-22" },
    { startLocal: "2101-11-14", endLocal: "2101-11-15" },
  ],
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
    candidates,
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

const NO_PLACE = { location: null, description: null };
const SATURDAY = [{ startLocal: "2101-11-21", endLocal: "2101-11-22" }];
/** The hidden, disabled first submit button: Enter in a field submits nothing (rc33). */
const ENTER_GUARD = '<button type="submit" disabled hidden></button>';

it("one time is one tap: each answer its own button, the note going with it (rc33)", async () => {
  const b = await browser({ now: () => NOW });
  const f = await pollWith(b, ["david", "ana"], "Pizza", NO_PLACE, SATURDAY);
  const [only] = f.planIds;
  const page = await (await b.request(f.link(0))).text();
  expect(page).toContain("Does this work for you?");
  expect(page).not.toContain('type="radio"');
  expect(page).not.toContain("Send my answer");
  for (const a of ["yes", "ifneedbe", "no"])
    expect(page).toContain(`name="plan_${only}" value="${a}" aria-pressed="false"`);
  const guard = page.indexOf(ENTER_GUARD);
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(page.indexOf(`name="plan_${only}"`));
  // The note sits above the buttons, so the tap sends it.
  expect(page.indexOf('name="note"')).toBeLessThan(guard);
  expect(page).not.toContain("You said");

  const res = await vote(b, f.token(0), { [`plan_${only}`]: "ifneedbe", note: "Late by ten" });
  expect(res.status).toBe(303);
  const after = await (await b.request(res.headers.get("location") ?? "")).text();
  expect(after).toContain(`value="ifneedbe" aria-pressed="true">If need be</button>`);
  expect(after).toContain(`value="yes" aria-pressed="false">Yes</button>`);
  expect(after).toContain("You said If need be. Tap another to change it.");
  expect(after).toContain("Late by ten");
});

it("one plan of several events alone on the table keeps a mark and a send (rc33)", async () => {
  const b = await browser({ now: () => NOW });
  const f = await pollWith(b, ["david", "ana"], "Picnic", NO_PLACE, SATURDAY);
  const mara = await f.as(f.mara.id);
  await withdrawPlan(b.storage, mara, { planId: f.planIds[0] ?? "", now: NOW });
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
  expect(text).toMatch(/ · 2 events, /);
  expect(text).toContain("Which of these work for you?");
  expect(text).toContain('type="radio"');
  expect(text).toContain("Send my answer");
  expect(text).not.toContain(ENTER_GUARD);
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

async function signedInPoll(
  b: Browser,
  names: readonly string[],
  candidates?: Parameters<typeof pollWith>[4],
) {
  await addAccount(b, "mara@example.org");
  const f = await pollWith(b, names, undefined, undefined, candidates);
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

it("one time is asked as one question: on the card and in the email (rc33)", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(
    b,
    ["david", "ana"],
    [{ startLocal: "2101-11-21", endLocal: "2101-11-22" }],
  );
  await sendLinks(b, f.thread);
  const mails = b.sent.filter((m) => m.subject === 'Can you make "Picnic"?');
  expect(mails.map((m) => m.to).sort()).toEqual(["ana@example.org", "david@example.org"]);
  const mara = guestName(f.threadId, f.mara.id);
  const david = mails.find((m) => m.to === "david@example.org");
  expect(david?.text).toContain(
    `${mara} would like to know whether you can make "Picnic" on Mon 21 Nov, all day.\n\nVote here`,
  );
  expect(david?.text).not.toContain("which times");
  const url = /https:\/\/whendowe\.example(\/vote\?t=\S+)/.exec(david?.text ?? "")?.[1] ?? "";
  const page = await (await b.request(url)).text();
  expect(page).toContain("Does this work for you?");
  expect(og(page).description).toBe("Does this work for you? Mon 21 Nov, all day");
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

it("a sender whose share is used hears whose, and that the links can still be copied (rc37)", async () => {
  const c = await browser({
    now: () => NOW,
    mailFails: (m) =>
      m.subject.startsWith("When can you make")
        ? new SenderShareReachedError({ daily: 1, monthly: 1 }, "month", null)
        : null,
  });
  const g = await signedInPoll(c, ["ana", "bob"]);
  const capped = await sendLinks(c, g.thread);
  expect(capped.status).toBe(503);
  expect(await capped.text()).toMatch(
    /Couldn(&#39;|')t send to 2\. You(&#39;|')ve sent as much email this month as one person can\. You can send more from \d{4}-\d{2}-01, or copy their links to send yourself\./,
  );
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

// --- Copying a member's vote link (rc36) ------------------------------------------------

it("the organizer copies a member's own link instead of emailing it: fresh, shown once, the old one dead", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(b, ["david", "ana"]);
  const page = await (await b.request(f.thread)).text();
  expect(page).toContain("Their own links");
  expect(page).toContain(`action="${f.thread}/links/copy"`);
  const david = f.rest[0]?.id ?? "";
  const copy = async () =>
    b.request(`${f.thread}/links/copy`, post({ csrf: (await home(b)).csrf, person: david }));
  const before = b.sent.length;
  const res = await copy();
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.text();
  // In the name the thread shows him by: he chose none, so a guest name (rc21). His row,
  // by his id: rows go in name order, and guest names are random, so his isn't always first.
  const name = new RegExp(
    `<strong>([^<]+)</strong></span><form method="post" action="[^"]+/links/copy"><input type="hidden" name="csrf" value="[^"]+" /><input type="hidden" name="person" value="${david}" />`,
  ).exec(page)?.[1];
  expect(name).toMatch(/^Guest \d+$/);
  expect(body).toContain(`This link answers as ${name}. Send it only to ${name}.`);
  expect(body).toContain("data-share-sheet"); // to send it in a chat
  expect(b.sent.length).toBe(before);
  const linkOf = (html: string) => {
    const url = new URL(
      /https:\/\/[^\s"<]+\/vote\?t=[A-Za-z0-9_-]+/.exec(html)?.[0] ?? "https://x/",
    );
    return `${url.pathname}${url.search}`;
  };
  const first = linkOf(body);
  expect((await b.request(first)).status).toBe(200);
  const second = linkOf(await (await copy()).text()); // at once: no resend throttle
  expect(second).not.toBe(first);
  expect((await b.request(first)).status).toBe(404);
  expect((await b.request(second)).status).toBe(200);
});

it("votes say how they arrived (rc42): the emailed link, or the link the organizer copied", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(b, ["david", "ana"]);
  const [david = "", ana = ""] = f.rest.map((p) => p.id);
  const [plan = ""] = f.planIds;
  const linkIn = (text: string) => {
    const url = new URL(
      /https:\/\/[^\s"<]+\/vote\?t=[A-Za-z0-9_-]+/.exec(text)?.[0] ?? "https://x/",
    );
    return { path: `${url.pathname}${url.search}`, t: url.searchParams.get("t") ?? "" };
  };
  // Made signed in, the poll carries Mara's own yes, which says nothing extra.
  const fresh = await (await b.request(`${f.thread}/p/${plan}`)).text();
  expect(fresh).toMatch(/<span class="vote yes">[^<]+ yes<\/span>/);
  expect(fresh).not.toMatch(/emailed link<|copied for|shared link<\/span>/);
  // Nobody else has voted: each is a dot, and nothing more.
  expect(fresh.match(/<span class="vote none">[^<]+ ·<\/span>/g)).toHaveLength(2);

  // A vote from the plan's page, signed in, is recorded as that.
  const late = f.planIds[1] ?? "";
  await b.request(
    `${f.thread}/p/${late}/vote`,
    post({ csrf: (await home(b)).csrf, answer: "ifneedbe" }),
  );
  expect(
    (await listPlans(b.storage, await f.as(f.mara.id))).find((p) => p.id === late)?.votes,
  ).toMatchObject([{ answer: "ifneedbe", arrival: { via: "session", by: null } }]);

  // Ana votes with the link she was mailed. Its page names nobody.
  await sendLinks(b, f.thread);
  const mailed = linkIn(b.sent.find((m) => m.to === "ana@example.org")?.text ?? "");
  // The line under the form starts with the link's own words: no one is named before them.
  expect(await (await b.request(mailed.path)).text()).toContain(
    '<p class="muted">This link is just for you',
  );
  expect((await vote(b, mailed.t, { [`plan_${plan}`]: "no" })).status).toBe(303);

  // David votes with a link Mara copied. Its page says who gave it to him.
  const copied = linkIn(
    await (
      await b.request(`${f.thread}/links/copy`, post({ csrf: (await home(b)).csrf, person: david }))
    ).text(),
  );
  expect(await (await b.request(copied.path)).text()).toMatch(
    /Guest \d+ gave you this link, and your answer will say so\. This link is just for you/,
  );
  expect((await vote(b, copied.t, { [`plan_${plan}`]: "ifneedbe" })).status).toBe(303);

  // Mara, who copied it, reads "you" on the plan's page.
  const shown = await (await b.request(`${f.thread}/p/${plan}`)).text();
  expect(shown).toMatch(
    /if need be <span class="muted">· by the link you copied for them<\/span><\/span>/,
  );
  expect(shown).toMatch(/ no <span class="muted">· by their emailed link<\/span><\/span>/);
  expect(shown.match(/<span class="muted">· by /g)).toHaveLength(2); // not Mara's own

  // Once whoever copied it is gone, the link's page says "Someone".
  await b.storage.batch([
    { sql: "UPDATE plan_vote_token SET issued_by = NULL WHERE person_id = ?", params: [david] },
  ]);
  expect(await (await b.request(copied.path)).text()).toContain("Someone gave you this link");
  // Links and votes from before rc42 recorded nothing: the page opens, and no label shows.
  await b.storage.batch([
    {
      sql: "UPDATE plan_vote_token SET origin = NULL WHERE person_id IN (?, ?)",
      params: [david, ana],
    },
    { sql: "UPDATE plan_vote SET answered_via = NULL, answered_via_by = NULL", params: [] },
  ]);
  const older = await b.request(copied.path);
  expect(older.status).toBe(200);
  expect(await older.text()).not.toContain("gave you this link");
  const unlabelled = await (await b.request(`${f.thread}/p/${plan}`)).text();
  expect(unlabelled).toMatch(/<span class="vote ifneedbe">[^<]+ if need be<\/span>/);
  expect(unlabelled).not.toMatch(/emailed link<|copied for/);
});

it("only my own email in a thread (rc42): from the thread page or a mailed vote link; never a copied one", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(b, ["david", "ana"]);
  const [david = "", ana = ""] = f.rest.map((p) => p.id);
  const linkIn = (text: string) => {
    const url = new URL(
      /https:\/\/[^\s"<]+\/vote\?t=[A-Za-z0-9_-]+/.exec(text)?.[0] ?? "https://x/",
    );
    return { path: `${url.pathname}${url.search}`, t: url.searchParams.get("t") ?? "" };
  };
  const here =
    /<input type="checkbox" name="on" value="1"( checked)? \/> Only my own email answers for me here/;
  const copyOf = async (person: string) =>
    b.request(`${f.thread}/links/copy`, post({ csrf: (await home(b)).csrf, person }));

  // Mara's own page has the switch, off.
  expect(here.exec(await (await b.request(f.thread)).text())?.[1]).toBeUndefined();

  // David's link is copied: its page has no switch, and posting one is refused.
  const copied = linkIn(await (await copyOf(david)).text());
  expect(await (await b.request(copied.path)).text()).not.toContain("Only my own email");
  const fromCopy = await b.request(`${VOTE_PATH}/own-answers`, post({ t: copied.t, on: "1" }));
  expect(fromCopy.status).toBe(403);
  expect(await fromCopy.text()).toContain("Only a link sent to your own address can change that.");

  // Ana turns hers on from her mailed link; Mara sees why there's no copy for her.
  await sendLinks(b, f.thread);
  const mailed = linkIn(b.sent.find((m) => m.to === "ana@example.org")?.text ?? "");
  expect(here.exec(await (await b.request(mailed.path)).text())?.[1]).toBeUndefined();
  const on = await b.request(`${VOTE_PATH}/own-answers`, post({ t: mailed.t, on: "1" }));
  expect(on.status).toBe(303);
  expect(on.headers.get("location")).toBe(mailed.path);
  expect(here.exec(await (await b.request(mailed.path)).text())?.[1]).toBe(" checked");
  const page = await (await b.request(f.thread)).text();
  expect(page).toContain("· takes answers only from their own email");
  expect(page.match(/Copy [^<]+'s link</g)).toHaveLength(1); // David's only
  const refused = await copyOf(ana);
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain(
    "takes answers only from their own email. You can still email them their link.",
  );

  // Off again from the mailed link: her copy button is back.
  await b.request(`${VOTE_PATH}/own-answers`, post({ t: mailed.t }));
  expect((await (await b.request(f.thread)).text()).match(/Copy [^<]+'s link</g)).toHaveLength(2);
  expect((await b.request(`${VOTE_PATH}/own-answers`, post({ t: "nope", on: "1" }))).status).toBe(
    404,
  );

  // Mara, signed in, turns her own on and off; a form without the token does nothing.
  await b.request(`${f.thread}/own-answers`, post({ csrf: (await home(b)).csrf, on: "1" }));
  expect(here.exec(await (await b.request(f.thread)).text())?.[1]).toBe(" checked");
  await b.request(`${f.thread}/own-answers`, post({ csrf: (await home(b)).csrf }));
  expect(here.exec(await (await b.request(f.thread)).text())?.[1]).toBeUndefined();
  expect((await b.request(`${f.thread}/own-answers`, post({ csrf: "x", on: "1" }))).status).toBe(
    403,
  );
});

it("only the organizer copies links, and only a member's", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(b, ["david"]);
  const notMember = await b.request(
    `${f.thread}/links/copy`,
    post({ csrf: (await home(b)).csrf, person: "nobody" }),
  );
  expect(notMember.status).toBe(409);
  expect(await notMember.text()).toContain("They have no link of their own here.");
  await addAccount(b, "david@example.org");
  expect(await (await b.request(f.thread)).text()).not.toContain("Their own links");
  const asDavid = await b.request(
    `${f.thread}/links/copy`,
    post({ csrf: (await home(b)).csrf, person: f.mara.id }),
  );
  expect(asDavid.status).toBe(403);
  expect(await asDavid.text()).toContain("Only the organizer copies vote links.");
});

it("copying refuses a guest, a form without its token, and a thread with nothing on the table", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(b, ["david", "ana"]);
  const copy = async (person: string, csrf?: string) =>
    b.request(`${f.thread}/links/copy`, post({ csrf: csrf ?? (await home(b)).csrf, person }));
  const ok = await (await copy(f.rest[1]?.id ?? "")).text();
  expect(ok).toContain("It works for 14 days.");
  expect(ok).toMatch(/aria-label="Guest \d+&#39;s link"/);
  expect(ok).toMatch(/<title>[^<]*Their link/);
  // A guest answered from the shared link: they have that, and their claim link.
  await b.storage.batch([
    { sql: "UPDATE person SET guest_at = ? WHERE id = ?", params: [NOW, f.rest[0]?.id ?? ""] },
  ]);
  const page = await (await b.request(f.thread)).text();
  expect(page.match(/\/links\/copy"/g)).toHaveLength(1); // only Ana's
  const guest = await copy(f.rest[0]?.id ?? "");
  expect(guest.status).toBe(409);
  expect(await guest.text()).toContain("They have no link of their own here.");
  expect((await copy(f.rest[1]?.id ?? "", "forged")).status).toBe(403);
  // Nothing on the table: nothing to vote on, so no links to copy.
  const mara = await f.as(f.mara.id);
  for (const planId of f.planIds) await withdrawPlan(b.storage, mara, { planId, now: NOW });
  expect(await (await b.request(f.thread)).text()).not.toContain("Their own links");
  const closed = await copy(f.rest[1]?.id ?? "");
  expect(closed.status).toBe(409);
  expect(await closed.text()).toContain("Nothing is on the table to vote on.");
});

it("the section is there while anything is on the table, and only with someone to send to", async () => {
  const b = await browser({ now: () => NOW });
  const f = await signedInPoll(b, ["david"]);
  const mara = await f.as(f.mara.id);
  await withdrawPlan(b.storage, mara, { planId: f.planIds[0] ?? "", now: NOW });
  expect(await (await b.request(f.thread)).text()).toContain("Their own links"); // one still is
  const alone = await createPollThread(b.storage, {
    creatorId: f.mara.id,
    group: null,
    fields: { title: "Solo", allDay: true, tzid: null, ...NO_PLACE },
    candidates: SATURDAY,
    people: [],
    now: NOW,
  });
  expect(await (await b.request(`${PLANS_PATH}/${alone.threadId}`)).text()).not.toContain(
    "Their own links",
  );
});
