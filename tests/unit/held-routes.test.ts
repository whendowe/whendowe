// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { HOLD_MS } from "../../src/held.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { acceptPlan, createPollThread } from "../../src/plans/plan.js";
import { findThreadForMember, leaveThread } from "../../src/plans/thread.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// "Email vote links" waits a minute (DESIGN §10 *Asking when*, rc46): the page offers Undo
// exactly while undoing is possible, then says it is sending, then what happened. The pass
// makes the button's checks again, so a minute's changes are respected.

const NOW = "2101-12-01T09:00:00.000Z";
const LATER = new Date(Date.parse(NOW) + HOLD_MS).toISOString();
const linkMail = (b: Browser) => b.sent.filter((m) => m.subject.startsWith("When can you make"));

async function poll(b: Browser) {
  await addAccount(b, "mara@example.org");
  const mara = await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW });
  const people = [];
  for (const n of ["david", "ana"])
    people.push((await findOrCreatePerson(b.storage, `${n}@example.org`, { now: NOW })).id);
  const { threadId, planIds } = await createPollThread(b.storage, {
    creatorId: mara.id,
    group: null,
    fields: { title: "Picnic", location: null, description: null, allDay: true, tzid: null },
    candidates: [
      { startLocal: "2101-12-21", endLocal: "2101-12-22" },
      { startLocal: "2101-12-14", endLocal: "2101-12-15" },
    ],
    people,
    now: NOW,
  });
  const thread = `${PLANS_PATH}/${threadId}`;
  const press = async () => b.request(`${thread}/links`, post({ csrf: (await home(b)).csrf }));
  const page = async () => (await b.request(thread)).text();
  const undoPath = async () => /action="([^"]+\/held\/[^"]+\/undo)"/.exec(await page())?.[1] ?? "";
  const as = async (id: string) => {
    const a = await findThreadForMember(b.storage, threadId, id);
    if (a === null) throw new Error("member");
    return a;
  };
  return { mara: mara.id, threadId, planIds, thread, press, page, undoPath, as };
}

it("pressed, it waits with Undo and no button to press again; a minute on, Undo is gone and it says what happened", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  const pressed = await f.press();
  expect(pressed.status).toBe(303);
  expect(pressed.headers.get("location")).toBe(f.thread);
  expect(linkMail(b)).toEqual([]); // nothing sent yet
  const waiting = await f.page();
  expect(waiting).toContain("<strong>Emailing vote links</strong> — in about a minute");
  expect(waiting).toMatch(/\/held\/[^"]+\/undo"><input type="hidden" name="csrf"/);
  expect(waiting).not.toContain('/links"><input'); // pressing again is not offered

  expect(await b.pass()).toBe(1);
  expect(
    linkMail(b)
      .map((m) => m.to)
      .sort(),
  ).toEqual(["ana@example.org", "david@example.org"]);
  const done = await f.page();
  expect(done).toContain("<strong>Emailing vote links:</strong> Sent to 2 people.");
  expect(done).not.toContain("/undo");
  expect(done).toContain('/links"><input'); // the button is back
  expect(await b.pass()).toBe(0); // and it never runs twice
});

it("Undo before the pass: nothing is emailed, ever; after it: too late, with what happened", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  await f.press();
  const undo = await b.request(await f.undoPath(), post({ csrf: (await home(b)).csrf }));
  expect(undo.status).toBe(200);
  const undone = await undo.text();
  expect(undone).toContain("Undone. Nobody was emailed.");
  expect(undone).not.toContain("Emailing vote links");
  expect(await b.pass()).toBe(0);
  expect(linkMail(b)).toEqual([]);

  await f.press();
  const path = await f.undoPath();
  await b.pass();
  const late = await b.request(path, post({ csrf: (await home(b)).csrf }));
  expect(late.status).toBe(409);
  const text = await late.text();
  expect(text).toContain("Too late — it was already sent.");
  expect(text).toContain("<strong>Emailing vote links:</strong> Sent to 2 people.");
});

it("Undo needs the form's CSRF token and is only its presser's", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  await f.press();
  const path = await f.undoPath();
  expect((await b.request(path, post({ csrf: "nope" }))).status).toBe(403);
  await addAccount(b, "david@example.org"); // now acting as David, a member
  const theirs = await b.request(path, post({ csrf: (await home(b)).csrf }));
  expect(await theirs.text()).not.toContain("Undone.");
  expect(await b.pass(LATER)).toBe(1); // Mara's still ran
  expect(linkMail(b)).toHaveLength(2);
});

it("the minute's changes count: decided meanwhile, or the organizer gone, and nobody is emailed", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  await f.press();
  await acceptPlan(b.storage, await f.as(f.mara), { planId: f.planIds[0] ?? "", now: NOW });
  await b.pass();
  expect(linkMail(b)).toEqual([]);
  expect(await f.page()).toContain(
    "<strong>Emailing vote links:</strong> Nothing is on the table any more, so nobody was emailed.",
  );

  const c = await browser({ now: () => NOW });
  const g = await poll(c);
  await g.press();
  await leaveThread(c.storage, await g.as(g.mara), NOW);
  // Her held action went with her (rc46), so the pass finds nothing to run.
  expect(await c.pass()).toBe(0);
  expect(linkMail(c)).toEqual([]);
});

it("while a pass is running it, the page says sending, with no Undo", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  await f.press();
  // Taken by a pass that hasn't finished: what a reload in that moment shows.
  await b.storage.batch([
    { sql: "UPDATE held_action SET taken_at = ? WHERE thread_id = ?", params: [NOW, f.threadId] },
  ]);
  const page = await f.page();
  expect(page).toContain("<strong>Emailing vote links</strong> — sending…");
  expect(page).not.toContain("/undo");
});

it("someone who opted out is counted apart, not as sent, and their link is withdrawn", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  const { suppress } = await import("../../src/privacy/suppression.js");
  await suppress(b.storage, "ana@example.org", { kind: "all" }, NOW);
  await f.press();
  await b.pass();
  expect(linkMail(b).map((m) => m.to)).toEqual(["david@example.org"]);
  expect(await f.page()).toMatch(
    /<strong>Emailing vote links:<\/strong> Sent to 1 person\. 1 opted out of email from here, so wasn(&#39;|')t sent one\./,
  );
  const tokens = await b.storage.query({
    sql: "SELECT p.email FROM plan_vote_token t JOIN person p ON p.id = t.person_id WHERE t.thread_id = ?",
    params: [f.threadId],
  });
  expect(tokens.map((r) => r.email)).toEqual(["david@example.org"]);
});
