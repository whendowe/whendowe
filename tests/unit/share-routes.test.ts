// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { MailCapReachedError } from "../../src/mail/capped.js";
import { LOGIN_REQUESTS_PER_WINDOW } from "../../src/people/login.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { acceptPlan, castVote, createPollThread, listPlans } from "../../src/plans/plan.js";
import { claimName, GUESTS_PER_DAY, resolveShareLink } from "../../src/plans/share.js";
import { findThreadForMember, MAX_MEMBERS } from "../../src/plans/thread.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import {
  CLAIM_COOKIE,
  type Claim,
  parseClaims,
  SHARE_PATH,
  withClaim,
  withoutClaim,
} from "../../src/web/routes/share.js";
import {
  addAccount,
  type Browser,
  browser,
  home,
  nameActive,
  post,
} from "../property/one-browser.js";

// The shared link's page (DESIGN §10 rc25, rc29): the organizer makes it on the thread page;
// a guest claims a name and votes in one form; this browser remembers the claim for that
// question only; signed in, one tap joins and votes. GET writes nothing.

const NOW = "2101-11-01T09:00:00.000Z";

/** Mara signs in on `b` and starts a poll with David; the thread and its plans. */
async function maraPoll(b: Browser) {
  await addAccount(b, "mara@example.org");
  await nameActive(b, "mara@example.org");
  const mara = await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW });
  const david = await findOrCreatePerson(b.storage, "david@example.org", { now: NOW });
  const { threadId, planIds } = await createPollThread(b.storage, {
    creatorId: mara.id,
    group: null,
    fields: { title: "Picnic", description: null, location: null, allDay: true, tzid: null },
    candidates: [
      { startLocal: "2101-11-21", endLocal: "2101-11-22" },
      { startLocal: "2101-11-14", endLocal: "2101-11-15" },
    ],
    people: [david.id],
    now: NOW,
  });
  return { mara, david, threadId, planIds };
}

/** Mara shares the poll from its page; the link it shows once. */
async function share(b: Browser, threadId: string) {
  const { csrf } = await home(b);
  const res = await b.request(`${PLANS_PATH}/${threadId}/share`, post({ csrf }));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  const text = await res.text();
  expect(text).toContain("Paste this into your group chat");
  // The page that made the link already knows the thread is shared: Mara decides (rc29).
  expect(text).toContain("You decide, after the votes are in");
  const url = /value="(https:\/\/whendowe\.example\/s\?t=[^"]+)"/.exec(text)?.[1] ?? "";
  expect(url).not.toBe("");
  const u = new URL(url.replaceAll("&amp;", "&"));
  return { path: `${u.pathname}${u.search}`, token: u.searchParams.get("t") ?? "" };
}

async function votesOf(b: Browser, threadId: string, personId: string) {
  const access = await findThreadForMember(b.storage, threadId, personId);
  if (access === null) return null;
  return (await listPlans(b.storage, access)).map(
    (p) => p.votes.find((v) => v.personId === personId)?.answer ?? null,
  );
}

const guestIdIn = async (b: Browser, threadId: string, name: string) =>
  String(
    (
      await b.storage.query({
        sql: "SELECT person_id FROM plan_thread_member WHERE thread_id = ? AND handle = ?",
        params: [threadId, name],
      })
    )[0]?.person_id ?? "",
  );

describe("the shared link's page (rc25, rc29)", () => {
  it("the organizer shares from the thread page; the link is shown once, then only its expiry", async () => {
    const b = await browser({ now: () => NOW });
    const f = await maraPoll(b);
    const before = await (await b.request(`${PLANS_PATH}/${f.threadId}`)).text();
    expect(before).toContain("Share a link");
    expect(before).toContain(`action="${PLANS_PATH}/${f.threadId}/share"`);
    // Without the form's CSRF token, nothing is made.
    const forged = await b.request(`${PLANS_PATH}/${f.threadId}/share`, post({}));
    expect(forged.status).not.toBe(200);
    expect(
      await b.storage.query({ sql: "SELECT 1 AS ok FROM share_link", params: [] }),
    ).toHaveLength(0);
    await share(b, f.threadId);
    const after = await (await b.request(`${PLANS_PATH}/${f.threadId}`)).text();
    expect(after).not.toContain(`${SHARE_PATH}?t=`);
    expect(after).not.toContain("Paste this");
    expect(after).toMatch(/can vote until \w{3} 1 Dec/);
    expect(after).toContain("Anyone with the link can vote until");
    // Once shared, Mara decides, though there are only two of them (rc29).
    expect(after).toContain("You decide, after the votes are in");
  });

  it("a guest names themselves and votes in one form; GET wrote nothing", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    // The guest's phone: another browser on the same instance.
    const guest = org.another();
    const writes = org.writes;
    const page = await guest.request(path);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const text = await page.text();
    expect(org.writes).toBe(writes);
    expect(text).toContain('name="name"');
    expect(text).not.toContain("@example.org");
    expect(text).not.toContain("Signed in as");
    expect(text).not.toContain("Not you?");
    expect(text).not.toContain("<h2>Notes</h2>");
    expect(text).toContain("no account needed");
    expect(text).toContain('name="name" value=""');
    expect(text).not.toContain("your answer is saved");
    expect(text).not.toContain('name="c"');
    expect(text).not.toContain("Confirm with email");
    const plans = await listPlans(org.storage, await member(org, f.threadId, f.mara.id));
    const [first, second] = plans;
    const res = await guest.request(
      SHARE_PATH,
      post({
        t: tokenOf(path),
        name: "Kestrel",
        [`plan_${first?.id}`]: "yes",
        [`plan_${second?.id}`]: "no",
        note: "Bringing the frisbee",
      }),
    );
    // Just claimed, the page itself answers (rc30): the one time it shows the claim link.
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const saved = await res.text();
    expect(saved).toContain("your answer is saved");
    expect(saved).toContain("keep this link");
    expect(saved).toContain("You're <strong>Kestrel</strong>");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toContain(`${CLAIM_COOKIE}=`);
    expect(set).toContain("Path=/s");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    const kestrel = await guestIdIn(org, f.threadId, "Kestrel");
    expect(await votesOf(org, f.threadId, kestrel)).toEqual(["yes", "no"]);
    // Back on the same phone: the name is remembered, the answers can change.
    const again = await (await guest.request(path)).text();
    expect(again).toContain("You're <strong>Kestrel</strong>");
    expect(again).not.toContain('name="name"');
    expect(again).toContain("Bringing the frisbee");
    // The note is attributed by the name Kestrel claimed.
    expect(again).toMatch(/<strong>Kestrel<\/strong> <span class="muted">on /);
    await guest.request(SHARE_PATH, post({ t: tokenOf(path), [`plan_${second?.id}`]: "yes" }));
    expect(await votesOf(org, f.threadId, kestrel)).toEqual(["yes", "yes"]);
    const members = await member(org, f.threadId, f.mara.id);
    expect(members.members).toHaveLength(3);
  });

  it("“Not you?” forgets the claim on this browser; the name stays taken", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const guest = org.another();
    const t = tokenOf(path);
    const plan = (await listPlans(org.storage, await member(org, f.threadId, f.mara.id)))[0];
    await guest.request(SHARE_PATH, post({ t, name: "Kestrel", [`plan_${plan?.id}`]: "yes" }));
    expect(guest.jar.has(CLAIM_COOKIE)).toBe(true);
    const writes = org.writes;
    const forgot = await guest.request(`${SHARE_PATH}/forget`, post({ t }));
    expect(forgot.status).toBe(303);
    expect(forgot.headers.get("location")).toBe(`${SHARE_PATH}?t=${encodeURIComponent(t)}`);
    expect(org.writes).toBe(writes);
    expect(guest.jar.has(CLAIM_COOKIE)).toBe(false);
    expect(await (await guest.request(path)).text()).toContain('name="name"');
    const taken = await guest.request(
      SHARE_PATH,
      post({ t, name: " kestrel ", [`plan_${plan?.id}`]: "no" }),
    );
    expect(taken.status).toBe(409);
    const text = await taken.text();
    expect(text).toContain("already goes by that name");
    // What was typed and chosen comes back with the problem.
    expect(text).toContain('value=" kestrel "');
    expect(text).toMatch(new RegExp(`name="plan_${plan?.id}" value="no"\\s+checked`));
  });

  it("nothing chosen, or a blank name, is sent back without joining anyone", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const guest = org.another();
    const t = tokenOf(path);
    const plan = (await listPlans(org.storage, await member(org, f.threadId, f.mara.id)))[0];
    expect((await guest.request(SHARE_PATH, post({ t, name: "Kestrel" }))).status).toBe(400);
    expect(
      (await guest.request(SHARE_PATH, post({ t, name: "  ", [`plan_${plan?.id}`]: "yes" })))
        .status,
    ).toBe(400);
    expect((await member(org, f.threadId, f.mara.id)).members).toHaveLength(2);
    expect(guest.jar.has(CLAIM_COOKIE)).toBe(false);
  });

  it("signed in, one tap joins and votes as the account — with its CSRF token", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const ana = org.another();
    await addAccount(ana, "ana@example.org");
    const page = await (await ana.request(path)).text();
    expect(page).toContain("You're signed in, so you'll answer as yourself");
    expect(page).toContain("Signed in as");
    expect(page).not.toContain('name="name"');
    expect(page).not.toContain("no account needed");
    // The form's own token, as a real browser sends it: not the header's.
    const csrf =
      /action="\/s">\s*<input type="hidden" name="t" value="[^"]+" \/>\s*<input type="hidden" name="csrf" value="([^"]+)"/.exec(
        page,
      )?.[1] ?? "";
    expect(csrf).not.toBe("");
    const plan = (await listPlans(org.storage, await member(org, f.threadId, f.mara.id)))[0];
    const t = tokenOf(path);
    const forged = await ana.request(SHARE_PATH, post({ t, [`plan_${plan?.id}`]: "yes" }));
    expect(forged.status).not.toBe(303);
    const anaP = await findOrCreatePerson(org.storage, "ana@example.org", { now: NOW });
    expect(await findThreadForMember(org.storage, f.threadId, anaP.id)).toBeNull();
    const res = await ana.request(SHARE_PATH, post({ t, csrf, [`plan_${plan?.id}`]: "yes" }));
    expect(res.status).toBe(303);
    expect(await votesOf(org, f.threadId, anaP.id)).toEqual(["yes", null]);
    expect(await (await ana.request(path)).text()).toContain("Answering as <strong>");
    // A refused answer comes back on the account's page, not a guest's.
    const refused = await ana.request(
      SHARE_PATH,
      post({ t, csrf, [`plan_${plan?.id}`]: "no", note: "x".repeat(501) }),
    );
    expect(refused.status).toBe(400);
    const back = await refused.text();
    expect(back).toContain("Answering as <strong>");
    expect(back).toContain("Signed in as");
    expect(ana.jar.has(CLAIM_COOKIE)).toBe(false);
  });

  it("a link turned off, replaced or decided stops working", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const first = await share(org, f.threadId);
    const second = await share(org, f.threadId);
    const guest = org.another();
    expect((await guest.request(first.path)).status).toBe(404);
    expect((await guest.request(second.path)).status).toBe(200);
    const { csrf } = await home(org);
    const off = await org.request(`${PLANS_PATH}/${f.threadId}/share/off`, post({ csrf }));
    expect(await off.text()).toContain("The link is off");
    expect((await guest.request(second.path)).status).toBe(404);
    expect((await guest.request(`${SHARE_PATH}?t=`)).status).toBe(404);
  });

  it("a dead link answers 404 to the page, the answer and “Not you?” alike", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const guest = org.another();
    const t = tokenOf(path);
    const plan = (await listPlans(org.storage, await member(org, f.threadId, f.mara.id)))[0];
    const { csrf } = await home(org);
    await org.request(`${PLANS_PATH}/${f.threadId}/share/off`, post({ csrf }));
    const vote = await guest.request(
      SHARE_PATH,
      post({ t, name: "Kestrel", [`plan_${plan?.id}`]: "yes" }),
    );
    expect(vote.status).toBe(404);
    expect((await guest.request(`${SHARE_PATH}/forget`, post({ t }))).status).toBe(404);
    expect((await member(org, f.threadId, f.mara.id)).members).toHaveLength(2);
  });

  it("decided: the page says so, and an answer from a page opened before is refused", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const guest = org.another();
    expect(await (await guest.request(path)).text()).toContain('name="name"');
    const plan = (await listPlans(org.storage, await member(org, f.threadId, f.mara.id)))[0];
    await acceptPlan(org.storage, await member(org, f.threadId, f.mara.id), {
      planId: plan?.id ?? "",
      now: NOW,
    });
    const page = await (await guest.request(path)).text();
    expect(page).toContain("This is decided.");
    expect(page).not.toContain('name="name"');
    const late = await guest.request(
      SHARE_PATH,
      post({ t: tokenOf(path), name: "Kestrel", [`plan_${plan?.id}`]: "yes" }),
    );
    expect(late.status).toBe(409);
    expect(await late.text()).toContain("decided meanwhile");
    expect((await member(org, f.threadId, f.mara.id)).members).toHaveLength(2);
  });

  it("a full plan takes no one more, signed in or not; a busy day takes no more guests", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const t = tokenOf(path);
    const plan = (await listPlans(org.storage, await member(org, f.threadId, f.mara.id)))[0];
    const vote = { t, [`plan_${plan?.id}`]: "yes" };
    // A busy day first: GUESTS_PER_DAY claims in the last day.
    await org.storage.batch(
      Array.from({ length: GUESTS_PER_DAY }, (_, i) => ({
        sql: "INSERT INTO guest_claim (token_hash, person_id, thread_id, created_at) VALUES (?, ?, ?, ?)",
        params: [`hash-${i}`, f.david.id, f.threadId, NOW],
      })),
    );
    const busy = await org.another().request(SHARE_PATH, post({ ...vote, name: "Kestrel" }));
    expect(busy.status).toBe(429);
    expect(await busy.text()).toContain("A lot of people joined today");
    await org.storage.batch([
      { sql: "DELETE FROM guest_claim WHERE thread_id = ?", params: [f.threadId] },
    ]);
    const q = await resolveShareLink(org.storage, t, NOW);
    if (q === null) throw new Error("link");
    for (let i = 2; i < MAX_MEMBERS; i++)
      await claimName(org.storage, q, { name: `G${i}`, now: NOW });
    const full = await org.another().request(SHARE_PATH, post({ ...vote, name: "Kestrel" }));
    expect(full.status).toBe(409);
    expect(await full.text()).toContain("This plan is full");
    const ana = org.another();
    await addAccount(ana, "ana@example.org");
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await ana.request(path)).text())?.[1];
    const joined = await ana.request(SHARE_PATH, post({ ...vote, csrf: csrf ?? "" }));
    expect(joined.status).toBe(409);
    expect(await joined.text()).toContain("This plan is full");
  });

  it("a claim that went in stays, even when its answer is refused", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const guest = org.another();
    const plan = (await listPlans(org.storage, await member(org, f.threadId, f.mara.id)))[0];
    const res = await guest.request(
      SHARE_PATH,
      post({
        t: tokenOf(path),
        name: "Kestrel",
        [`plan_${plan?.id}`]: "yes",
        note: "x".repeat(501),
      }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Keep it under 500 characters.");
    // The page now answers as Kestrel, and this phone remembers it.
    expect(text).toContain("You're <strong>Kestrel</strong>");
    expect(guest.jar.has(CLAIM_COOKIE)).toBe(true);
  });

  it("one phone, two questions: each remembers its own name, and forgets only its own", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const one = await share(org, f.threadId);
    const g = await maraPoll2(org);
    const two = await share(org, g.threadId);
    const phone = org.another();
    const first = async (threadId: string) =>
      `plan_${(await listPlans(org.storage, await member(org, threadId, f.mara.id)))[0]?.id}`;
    await phone.request(
      SHARE_PATH,
      post({ t: tokenOf(one.path), name: "Kestrel", [await first(f.threadId)]: "yes" }),
    );
    await phone.request(
      SHARE_PATH,
      post({ t: tokenOf(two.path), name: "Wren", [await first(g.threadId)]: "yes" }),
    );
    expect(parseClaims(phone.jar.get(CLAIM_COOKIE))).toHaveLength(2);
    const p1 = await (await phone.request(one.path)).text();
    expect(p1).toContain("You're <strong>Kestrel</strong>");
    expect(p1).not.toContain("Wren");
    const forgot = await phone.request(`${SHARE_PATH}/forget`, post({ t: tokenOf(two.path) }));
    expect(forgot.headers.get("cache-control")).toBe("no-store");
    expect(await (await phone.request(one.path)).text()).toContain(
      "You're <strong>Kestrel</strong>",
    );
    expect(await (await phone.request(two.path)).text()).toContain('name="name"');
    const last = await phone.request(`${SHARE_PATH}/forget`, post({ t: tokenOf(one.path) }));
    expect(last.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(phone.jar.has(CLAIM_COOKIE)).toBe(false);
  });

  it("only the organizer shares", async () => {
    const b = await browser({ now: () => NOW });
    const f = await maraPoll(b);
    const david = b.another();
    await addAccount(david, "david@example.org");
    const page = await (await david.request(`${PLANS_PATH}/${f.threadId}`)).text();
    expect(page).not.toContain("Share a link");
    const { csrf } = await home(david);
    const res = await david.request(`${PLANS_PATH}/${f.threadId}/share`, post({ csrf }));
    expect(res.status).toBe(403);
    const off = await david.request(`${PLANS_PATH}/${f.threadId}/share/off`, post({ csrf }));
    expect(off.status).toBe(403);
  });

  it("nothing on the table, nothing to share", async () => {
    const b = await browser({ now: () => NOW });
    const f = await maraPoll(b);
    // Not shared, so two decide by consensus: David's yes agrees a time.
    const agreed = await castVote(b.storage, await member(b, f.threadId, f.david.id), {
      planId: f.planIds[0] ?? "",
      answer: "yes",
      now: NOW,
    });
    expect(agreed.kind).toBe("accepted");
    const page = await (await b.request(`${PLANS_PATH}/${f.threadId}`)).text();
    expect(page).not.toContain("Share a link");
    const { csrf } = await home(b);
    const res = await b.request(`${PLANS_PATH}/${f.threadId}/share`, post({ csrf }));
    expect(res.status).toBe(409);
  });
});

/** Kestrel claims a name on a fresh phone and votes yes, no; the phone and its claim link. */
async function kestrel(org: Browser, f: Awaited<ReturnType<typeof maraPoll>>, path: string) {
  const phone = org.another();
  const [first, second] = await listPlans(org.storage, await member(org, f.threadId, f.mara.id));
  const res = await phone.request(
    SHARE_PATH,
    post({
      t: tokenOf(path),
      name: "Kestrel",
      [`plan_${first?.id}`]: "yes",
      [`plan_${second?.id}`]: "no",
    }),
  );
  const text = await res.text();
  const url = /value="(https:\/\/whendowe\.example\/s\?t=[^"]+&amp;c=[^"]+)"/.exec(text)?.[1] ?? "";
  expect(url).not.toBe("");
  const u = new URL(url.replaceAll("&amp;", "&"));
  return {
    phone,
    keep: `${u.pathname}${u.search}`,
    claim: u.searchParams.get("c") ?? "",
    guestId: await guestIdIn(org, f.threadId, "Kestrel"),
    plans: [first?.id ?? "", second?.id ?? ""],
  };
}

describe("keeping a guest's answer (rc30)", () => {
  it("the claim link opens the question as that name on another device, which then remembers it", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const k = await kestrel(org, f, path);
    // Shown once: answering again redirects, and the page doesn't show it.
    const again = await (await k.phone.request(path)).text();
    expect(again).toContain("You're <strong>Kestrel</strong>");
    expect(again).not.toContain("&amp;c=");
    expect(again).not.toContain('name="c"');
    const fromCookie = await k.phone.request(
      SHARE_PATH,
      post({ t: tokenOf(path), [`plan_${k.plans[0]}`]: "yes" }),
    );
    expect(fromCookie.status).toBe(303);
    expect(fromCookie.headers.get("set-cookie")).toBeNull();

    const laptop = org.another();
    const writes = org.writes;
    const opened = await laptop.request(k.keep);
    expect(opened.headers.get("set-cookie")).toBeNull();
    expect(org.writes).toBe(writes);
    const text = await opened.text();
    expect(text).toContain("You're <strong>Kestrel</strong>");
    expect(text).toContain(`name="c" value="${k.claim}"`);
    expect(text).not.toContain('name="name"');
    const res = await laptop.request(
      SHARE_PATH,
      post({ t: tokenOf(path), c: k.claim, [`plan_${k.plans[1]}`]: "yes" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie") ?? "").toContain(`${CLAIM_COOKIE}=`);
    expect(await votesOf(org, f.threadId, k.guestId)).toEqual(["yes", "yes"]);
    expect(await (await laptop.request(path)).text()).toContain("You're <strong>Kestrel</strong>");
    // A claim that opens nothing is no claim: the page asks for a name.
    const stranger = await org.another().request(`${path}&c=not-a-claim`);
    expect(await stranger.text()).toContain('name="name"');
  });

  it("confirming by email: the link it sends, used anywhere, makes the answers that account's", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const k = await kestrel(org, f, path);
    const page = await (await k.phone.request(path)).text();
    expect(page).toContain("Confirm with email");
    const sent = org.sent.length;
    const res = await k.phone.request(
      `${SHARE_PATH}/confirm`,
      post({ t: tokenOf(path), email: "Kestrel@Example.org" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const check = await res.text();
    expect(check).toContain("makes Kestrel's answers yours");
    expect(check).toContain("expires in 15 minutes");
    expect(org.sent).toHaveLength(sent + 1);
    const mail = org.sent.at(-1);
    expect(mail?.to).toBe("kestrel@example.org");
    const link = new URL(/https?:\/\/\S+/.exec(mail?.text ?? "")?.[0] ?? "");
    expect(link.origin).toBe("https://whendowe.example");

    // Opened on the laptop: the guest is moved as the link signs in.
    const laptop = org.another();
    const used = await laptop.request(link.pathname, post({ t: link.searchParams.get("t") ?? "" }));
    expect(used.status).toBe(303);
    expect(used.headers.get("location")).toBe(`${PLANS_PATH}/${f.threadId}`);
    const account = await findOrCreatePerson(org.storage, "kestrel@example.org", { now: NOW });
    expect(await votesOf(org, f.threadId, account.id)).toEqual(["yes", "no"]);
    expect(await votesOf(org, f.threadId, k.guestId)).toBeNull();
    const thread = await (await laptop.request(`${PLANS_PATH}/${f.threadId}`)).text();
    expect(thread).toContain("Kestrel");
    // The phone's claim is gone with the guest: it asks for a name again.
    expect(await (await k.phone.request(path)).text()).toContain('name="name"');
  });

  it("confirming needs a claim and an address; a plain sign-in link moves nothing", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const sent = org.sent.length;
    const nobody = await org
      .another()
      .request(`${SHARE_PATH}/confirm`, post({ t: tokenOf(path), email: "x@example.org" }));
    expect(nobody.status).toBe(303);
    expect(nobody.headers.get("location")).toBe(path);
    const k = await kestrel(org, f, path);
    const bad = await k.phone.request(
      `${SHARE_PATH}/confirm`,
      post({ t: tokenOf(path), email: "not an address" }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("doesn't look like an email address");
    const dead = await k.phone.request(
      `${SHARE_PATH}/confirm`,
      post({ t: "dead-link", email: "x@example.org" }),
    );
    expect(dead.status).toBe(404);
    expect(org.sent).toHaveLength(sent);
    // Signing in the usual way leaves the guest where it is.
    const laptop = org.another();
    const signedIn = await addAccount(laptop, "kestrel@example.org");
    expect(signedIn.headers.get("location")).toBe("/");
    expect(await votesOf(org, f.threadId, k.guestId)).toEqual(["yes", "no"]);
  });

  it("a link that can't be sent says why, as signing in does", async () => {
    let fail: Error | null = null;
    const org = await browser({ now: () => NOW, mailFails: () => fail });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const k = await kestrel(org, f, path);
    const confirm = () =>
      k.phone.request(`${SHARE_PATH}/confirm`, post({ t: tokenOf(path), email: "k@example.org" }));
    fail = new MailCapReachedError({ daily: 1, monthly: 1 });
    expect((await confirm()).status).toBe(503);
    fail = new Error("provider down");
    expect((await confirm()).status).toBe(502);
    fail = null;
    // A link that went unsent still counts towards the address's hourly limit.
    for (let i = 2; i < LOGIN_REQUESTS_PER_WINDOW; i++) expect((await confirm()).status).toBe(200);
    expect((await confirm()).status).toBe(429);
  });

  it("a confirm link whose guest is gone only signs in", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const k = await kestrel(org, f, path);
    await k.phone.request(
      `${SHARE_PATH}/confirm`,
      post({ t: tokenOf(path), email: "k@example.org" }),
    );
    const link = new URL(/https?:\/\/\S+/.exec(org.sent.at(-1)?.text ?? "")?.[0] ?? "");
    await org.storage.query({ sql: "DELETE FROM person WHERE id = ?", params: [k.guestId] });
    const used = await org
      .another()
      .request(link.pathname, post({ t: link.searchParams.get("t") ?? "" }));
    expect(used.status).toBe(303);
    expect(used.headers.get("location")).toBe("/");
  });
});

/** The CSRF token in the page's move form (rc30). */
const moveCsrf = (page: string) =>
  /action="\/s\/move">[\s\S]*?name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";

describe("signed in over a claim (rc30)", () => {
  it("one tap moves the name's answers to the account, and the browser forgets the claim", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const k = await kestrel(org, f, path);
    // Signed in on the same phone, the account answers once itself, then sees the offer.
    await addAccount(k.phone, "kestrel@example.org");
    const account = await findOrCreatePerson(org.storage, "kestrel@example.org", { now: NOW });
    const t = tokenOf(path);
    const first = await (await k.phone.request(path)).text();
    const csrf = moveCsrf(first);
    expect(csrf).not.toBe("");
    await k.phone.request(SHARE_PATH, post({ t, csrf, [`plan_${k.plans[0]}`]: "no" }));
    const page = await (await k.phone.request(path)).text();
    expect(page).toContain("Move Kestrel's answers to your account");
    expect(page).toContain("Signed in as");
    expect(page).not.toContain("Confirm with email");

    const writes = org.writes;
    const forged = await k.phone.request(`${SHARE_PATH}/move`, post({ t }));
    expect(forged.status).not.toBe(303);
    expect(org.writes).toBe(writes);
    const res = await k.phone.request(`${SHARE_PATH}/move`, post({ t, csrf }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PLANS_PATH}/${f.threadId}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(k.phone.jar.has(CLAIM_COOKIE)).toBe(false);
    // The guest's answers win where both answered.
    expect(await votesOf(org, f.threadId, account.id)).toEqual(["yes", "no"]);
    expect(await votesOf(org, f.threadId, k.guestId)).toBeNull();
    const after = await (await k.phone.request(path)).text();
    expect(after).toContain("Answering as <strong>");
    expect(after).not.toContain("/s/move");
  });

  it("from the claim link on a signed-in laptop, the form carries the claim", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const k = await kestrel(org, f, path);
    const laptop = org.another();
    await addAccount(laptop, "kestrel@example.org");
    const page = await (await laptop.request(k.keep)).text();
    expect(page).toContain("Move Kestrel's answers to your account");
    expect(page).toContain(`name="c" value="${k.claim}"`);
    const t = tokenOf(path);
    const res = await laptop.request(
      `${SHARE_PATH}/move`,
      post({ t, c: k.claim, csrf: moveCsrf(page) }),
    );
    expect(res.headers.get("location")).toBe(`${PLANS_PATH}/${f.threadId}`);
    const account = await findOrCreatePerson(org.storage, "kestrel@example.org", { now: NOW });
    expect(await votesOf(org, f.threadId, account.id)).toEqual(["yes", "no"]);
  });

  it("the move needs an account, a claim that still stands and a live link", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const t = tokenOf(path);
    const k = await kestrel(org, f, path);
    const back = `${SHARE_PATH}?t=${encodeURIComponent(t)}`;
    // Not signed in: a guest has nowhere to move to.
    const guest = await k.phone.request(`${SHARE_PATH}/move`, post({ t }));
    expect(guest.status).toBe(303);
    expect(guest.headers.get("location")).toBe(back);
    // Signed in, holding no claim: nothing is offered and nothing moves.
    const ana = org.another();
    await addAccount(ana, "ana@example.org");
    const anaPage = await (await ana.request(path)).text();
    expect(anaPage).not.toContain("/s/move");
    const { csrf } = await home(ana);
    const none = await ana.request(`${SHARE_PATH}/move`, post({ t, csrf }));
    expect(none.headers.get("location")).toBe(back);
    expect(await votesOf(org, f.threadId, k.guestId)).toEqual(["yes", "no"]);
    // A guest removed meanwhile is no claim any more: nothing is offered or moved.
    await addAccount(k.phone, "kestrel@example.org");
    const offered = moveCsrf(await (await k.phone.request(path)).text());
    await org.storage.query({ sql: "DELETE FROM person WHERE id = ?", params: [k.guestId] });
    const gone = await k.phone.request(`${SHARE_PATH}/move`, post({ t, csrf: offered }));
    expect(gone.headers.get("location")).toBe(back);
    const dead = await k.phone.request(
      `${SHARE_PATH}/move`,
      post({ t: "dead-link", csrf: offered }),
    );
    expect(dead.status).toBe(404);
  });
});

describe("the organizer and guests (rc30)", () => {
  it("the organizer sees who isn't confirmed and removes one; the name is free again", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const before = await (await org.request(`${PLANS_PATH}/${f.threadId}`)).text();
    expect(before).not.toContain('id="guests"');
    const k = await kestrel(org, f, path);
    const thread = await (await org.request(`${PLANS_PATH}/${f.threadId}`)).text();
    expect(thread).toContain(`action="${PLANS_PATH}/${f.threadId}/guests/remove"`);
    expect(thread).toContain("<strong>Kestrel</strong> · not confirmed");
    expect(thread).toContain("Remove Kestrel");
    expect(thread).not.toContain(`value="${f.david.id}"`);
    const remove = `${PLANS_PATH}/${f.threadId}/guests/remove`;
    const writes = org.writes;
    const forged = await org.request(remove, post({ guest: k.guestId }));
    expect(forged.status).toBe(403);
    expect(await forged.text()).toContain("Request rejected");
    expect(org.writes).toBe(writes);

    const { csrf } = await home(org);
    const res = await org.request(remove, post({ csrf, guest: k.guestId }));
    expect(res.status).toBe(200);
    const after = await res.text();
    expect(after).toContain("Kestrel is removed, with their answers. The name is free again.");
    expect(after).not.toContain('id="guests"');
    expect(await votesOf(org, f.threadId, k.guestId)).toBeNull();
    // The phone's claim went with the guest; the name can be claimed again.
    expect(await (await k.phone.request(path)).text()).toContain('name="name"');
    await kestrel(org, f, path);
    const again = await org.request(remove, post({ csrf, guest: k.guestId }));
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("They aren&#39;t a guest here any more.");
  });

  it("only the organizer sees guests marked, and only the organizer removes one", async () => {
    const org = await browser({ now: () => NOW });
    const f = await maraPoll(org);
    const { path } = await share(org, f.threadId);
    const k = await kestrel(org, f, path);
    const david = org.another();
    await addAccount(david, "david@example.org");
    const page = await (await david.request(`${PLANS_PATH}/${f.threadId}`)).text();
    expect(page).toContain("Kestrel");
    expect(page).not.toContain("not confirmed");
    const { csrf } = await home(david);
    const res = await david.request(
      `${PLANS_PATH}/${f.threadId}/guests/remove`,
      post({ csrf, guest: k.guestId }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Only the organizer removes someone.");
    expect(await votesOf(org, f.threadId, k.guestId)).toEqual(["yes", "no"]);
  });
});

describe("the claim cookie (rc29), pure", () => {
  const c = (n: number): Claim => ({ threadId: `0000000${n}-aaaa`, token: `tok${n}` });
  it("keeps one claim per question, newest first, at most eight", () => {
    let claims: Claim[] = [];
    for (let i = 0; i < 10; i++) claims = withClaim(claims, c(i));
    expect(claims.map((x) => x.token)).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map((n) => `tok${n}`));
    claims = withClaim(claims, { threadId: c(5).threadId, token: "again" });
    expect(claims[0]).toEqual({ threadId: c(5).threadId, token: "again" });
    expect(claims.filter((x) => x.threadId === c(5).threadId)).toHaveLength(1);
    const without = withoutClaim(claims, c(5).threadId);
    expect(without).toHaveLength(7);
    expect(without.some((x) => x.threadId === c(5).threadId)).toBe(false);
  });
  it("reads back what it writes, and drops anything malformed", () => {
    const raw = [c(1), c(2)].map((x) => `${x.threadId}.${x.token}`).join("~");
    expect(parseClaims(raw)).toEqual([c(1), c(2)]);
    expect(
      parseClaims(`${raw}~junk~x.y.z~ABC.tok~zz${c(3).threadId}.t~${c(4).threadId}.t!`),
    ).toEqual([c(1), c(2)]);
    expect(parseClaims(undefined)).toEqual([]);
    expect(parseClaims("")).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `0000${i}-a.t${i}`).join("~");
    expect(parseClaims(many)).toHaveLength(8);
  });
});

// --- helpers --------------------------------------------------------------------------------

const tokenOf = (path: string) => new URL(path, "http://x").searchParams.get("t") ?? "";

async function member(b: Browser, threadId: string, personId: string) {
  const a = await findThreadForMember(b.storage, threadId, personId);
  if (a === null) throw new Error("member");
  return a;
}

/** A second poll of Mara's, already signed in on `b`. */
async function maraPoll2(b: Browser) {
  const mara = await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW });
  const ana = await findOrCreatePerson(b.storage, "ana2@example.org", { now: NOW });
  const { threadId } = await createPollThread(b.storage, {
    creatorId: mara.id,
    group: null,
    fields: { title: "Climbing", description: null, location: null, allDay: true, tzid: null },
    candidates: [
      { startLocal: "2101-11-28", endLocal: "2101-11-29" },
      { startLocal: "2101-11-29", endLocal: "2101-11-30" },
    ],
    people: [ana.id],
    now: NOW,
  });
  return { threadId };
}
