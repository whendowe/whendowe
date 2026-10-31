// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import {
  addAccount,
  type Browser,
  browser,
  home,
  nameActive,
  post,
} from "../property/one-browser.js";

// The plan pages (DESIGN §10 rc19), driven through the whole app as two people on one
// browser would: start a thread, draw a plan with no JavaScript at all, send it, answer
// it with changes, and accept it by both saying yes.

async function act(b: Browser, path: string, fields: Record<string, string | string[]> = {}) {
  const body = new URLSearchParams();
  body.set("csrf", (await home(b)).csrf);
  for (const [k, v] of Object.entries(fields))
    for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return b.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

const page = async (b: Browser, path: string) => (await b.request(path)).text();
const location = (res: Response) => res.headers.get("location") ?? "";

async function switchTo(b: Browser, email: string) {
  const h = await home(b);
  const to = h.others.find((o) => o.email === email);
  if (to === undefined) throw new Error(`no account ${email}`);
  await b.request("/auth/switch", post({ csrf: h.csrf, session: to.sessionId, back: "/" }));
}

/** The member ids, from the editor's Who checkboxes: name → id. */
async function memberIds(b: Browser, draft: string): Promise<Map<string, string>> {
  const text = await page(b, `${draft}?add=2101-11-07&kind=days`);
  return new Map(
    [...text.matchAll(/name="who" value="([^"]+)" \/> ([^<]+)<\/label>/g)].map((m) => [
      m[2] ?? "",
      m[1] ?? "",
    ]),
  );
}

async function thread(b: Browser, name = "Kiddo's weeks") {
  const res = await act(b, PLANS_PATH, {
    name,
    tzid: "Europe/Prague",
    email: ["mara@example.org"],
  });
  expect(res.status).toBe(303);
  return location(res);
}

it("two co-parents agree two weeks, with no JavaScript", async () => {
  const b = await browser({ now: () => "2101-11-01T09:00:00.000Z" });
  await addAccount(b, "mara@example.org");
  await nameActive(b, "mara@example.org");
  await addAccount(b, "adam@example.org");
  await nameActive(b, "adam@example.org");
  const t = await thread(b);
  expect(await page(b, t)).toContain("Propose a plan");

  expect(location(await act(b, `${t}/drafts`))).toBe(`${t}/draft`);
  const ids = await memberIds(b, `${t}/draft`);
  const adam = ids.get("adam") ?? "";
  const mara = ids.get("mara") ?? "";
  for (const [title, from, to, who] of [
    ["With Adam", "2101-11-07", "2101-11-13", adam],
    ["With Mara", "2101-11-14", "2101-11-20", mara],
  ] as const) {
    const res = await act(b, `${t}/draft/events`, { title, kind: "days", from, to, who });
    expect(res.status).toBe(303);
    expect(location(res)).toMatch(/\/draft\?e=/);
  }
  const draft = await page(b, `${t}/draft`);
  expect(draft).toContain("With Adam");
  // A stretch across a week boundary is one event drawn as two pieces: ‹ marks the second.
  expect(
    (
      await act(b, `${t}/draft/events`, {
        title: "Scout trip",
        kind: "days",
        from: "2101-11-12",
        to: "2101-11-15",
      })
    ).status,
  ).toBe(303);
  expect(await page(b, `${t}/draft`)).toMatch(/‹ Scout trip/);

  const sent = await act(b, `${t}/draft/details`, {
    name: "",
    message: "As usual.",
    after: "send",
  });
  expect(location(sent)).toMatch(/\/p\/[0-9a-f-]+\?sent=1$/);
  const planA = location(sent).replace("?sent=1", "");
  const sentPage = await page(b, location(sent));
  expect(sentPage).toContain("Kiddo&#39;s weeks: I've proposed “Plan A” (Mon 7 Nov – Sun 20 Nov)");
  expect(sentPage).toContain(`https://whendowe.example${planA}`);

  // Mara: waiting for her vote, from home.
  await switchTo(b, "mara@example.org");
  expect((await home(b)).text).toContain("1 waiting for your vote");
  const asMara = await page(b, planA);
  expect(asMara).toContain("Suggest changes…");
  expect(asMara).toContain("Accepted when both say yes");

  // She suggests changes: the second week is Adam's too, and the scout trip goes.
  expect(location(await act(b, `${t}/drafts`, { from: planA.split("/p/")[1] ?? "" }))).toBe(
    `${t}/draft`,
  );
  const mine = await page(b, `${t}/draft`);
  expect(mine).toContain("changes to A");
  const sids = [
    ...mine.matchAll(
      /href="[^"]*\/draft\?e=([0-9a-f-]+)#w-[^"]*" data-sid="[^"]+" data-kind="plan"[^>]*aria-label="([^"]+)"/g,
    ),
  ];
  const second = sids.find((m) => (m[2] ?? "").includes("With Mara"))?.[1] ?? "";
  const scout = sids.find((m) => (m[2] ?? "").includes("Scout trip"))?.[1] ?? "";
  expect(second).not.toBe("");
  await act(b, `${t}/draft/events/${second}`, {
    title: "With Adam",
    kind: "days",
    from: "2101-11-14",
    to: "2101-11-20",
    who: adam,
  });
  await act(b, `${t}/draft/events/${scout}/remove`);
  const changed = await page(b, `${t}/draft`);
  expect(changed).toContain("now for <strong>adam</strong> (was mara)");
  expect(changed).toContain("Left out: <strong>Scout trip</strong>");
  const sentB = await act(b, `${t}/draft/details`, { name: "", message: "", after: "send" });
  const planB = location(sentB).replace("?sent=1", "");
  expect(await page(b, planB)).toContain("mara: mara&#39;s changes to A");

  // Adam's yes is the second: accepted, A replaced, the weeks are his events now.
  await switchTo(b, "adam@example.org");
  expect(location(await act(b, `${planB}/vote`, { answer: "yes" }))).toBe(planB);
  expect(await page(b, planB)).toContain("Both said yes to it");
  expect(await page(b, planA)).toContain("Replaced by “mara&#39;s changes to A”");
  const h = (await home(b)).text;
  expect(h.match(/With Adam/g)?.length).toBe(2);
  expect(await page(b, t)).toContain(
    "Both said yes to “mara&#39;s changes to A”: 2 events now agreed.",
  );

  // In this thread Mara goes by "M" (DESIGN §10 rc21): her name here, nowhere else.
  await switchTo(b, "mara@example.org");
  expect(location(await act(b, `${t}/me`, { handle: "M" }))).toBe(t);
  expect(await page(b, t)).toContain("You appear here as <strong>M</strong>");
  await switchTo(b, "adam@example.org");
  // Both joined at the same moment, so either order is right. (Her address is still in
  // Adam's account menu: both are signed in on this browser.)
  expect(await page(b, t)).toMatch(/class="l2">(adam, M|M, adam) ·/);
});

it("pages write nothing, and the no-JS editor moves a stretch by a week", async () => {
  const b = await browser({ now: () => "2101-11-01T09:00:00.000Z" });
  await addAccount(b, "adam@example.org");
  const t = await thread(b);
  await act(b, `${t}/drafts`);
  const res = await act(b, `${t}/draft/events`, {
    title: "With Adam",
    kind: "days",
    from: "2101-11-07",
    to: "2101-11-13",
  });
  const sid = new URL(location(res), "https://x").searchParams.get("e") ?? "";
  await act(b, `${t}/draft/events/${sid}`, {
    title: "With Adam",
    kind: "days",
    from: "2101-11-07",
    to: "2101-11-13",
    shift: "7",
  });
  const editor = await page(b, `${t}/draft?e=${sid}`);
  expect(editor).toContain('name="from" value="2101-11-14"');
  expect(editor).toContain('name="to" value="2101-11-20"');

  const before = b.writes;
  for (const path of [
    t,
    `${t}/draft`,
    `${t}/draft?day=2101-11-15`,
    `${t}/draft?range=1`,
    `${PLANS_PATH}`,
  ])
    expect((await b.request(path)).status).toBe(200);
  expect(b.writes).toBe(before);

  // A timed event: a day, a start and a length.
  await act(b, `${t}/draft/events`, {
    title: "Parents' evening",
    kind: "time",
    day: "2101-11-11",
    start: "17:00",
    length: "90",
  });
  expect(await page(b, `${t}/draft?day=2101-11-11`)).toContain("Fri 11 Nov, 17:00–18:30");
  // Nonsense is refused with the event schema's own words, not a crash.
  const bad = await act(b, `${t}/draft/events`, {
    title: "",
    kind: "days",
    from: "2101-11-07",
    to: "2101-11-07",
  });
  expect(bad.status).toBe(400);
  expect(await bad.text()).toContain("Give the event a title.");
});

it("only members see a thread; a form without its token does nothing; text is escaped", async () => {
  const b = await browser();
  await addAccount(b, "adam@example.org");
  const t = await thread(b, "<script>x</script>");
  const text = await page(b, t);
  expect(text).not.toContain("<script>x</script>");
  expect(text).toContain("&lt;script&gt;x&lt;/script&gt;");

  const forged = await b.request(`${t}/drafts`, post({ csrf: "nope" }));
  expect(forged.status).toBe(403);
  expect((await page(b, t)).includes("Back to your draft")).toBe(false);

  await addAccount(b, "stranger@example.org");
  // The stranger is active; Adam is also signed in here, so the page offers the switch.
  const res = await b.request(t);
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("This is visible to adam@example.org");
});
