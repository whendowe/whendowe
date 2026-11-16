// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { SIGNED_IN } from "../../src/events/response.js";
import { MailCapReachedError } from "../../src/mail/capped.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import {
  acceptPlan,
  castVote,
  createPollThread,
  listPlans,
  withdrawPlan,
} from "../../src/plans/plan.js";
import { findThreadForMember } from "../../src/plans/thread.js";
import { suppress } from "../../src/privacy/suppression.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import { sendResultMail } from "../../src/web/routes/respond.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// Choosing an option (DESIGN §10 *Asking when*, rc46): the organizer's one main button under
// where it stands; held a minute with Undo; then accepted, and everyone told the result at
// their own tier, opt-outs dropped, the signed-in given a link.

const NOW = "2101-12-01T09:00:00.000Z";
const result = (b: Browser) => b.sent.filter((m) => m.subject.startsWith("Agreed:"));

async function poll(b: Browser, names: readonly string[] = ["lea", "cat"]) {
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
      location: "Ann's <flat>",
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
  const thread = `${PLANS_PATH}/${threadId}`;
  const as = async (id: string) => {
    const a = await findThreadForMember(b.storage, threadId, id);
    if (a === null) throw new Error("member");
    return a;
  };
  const [lea = ""] = people;
  const [thu = ""] = planIds;
  // Lea's yes to A makes A lead (B has only Mara's).
  await castVote(b.storage, await as(lea), {
    planId: thu,
    answer: "yes",
    now: NOW,
    arrival: SIGNED_IN,
  });
  const page = async () => (await b.request(thread)).text();
  return { mara: mara.id, people, threadId, planIds, thread, as, page };
}

it("the organizer's main button chooses the leader; it waits with Undo, then everyone is told", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  const [thu = ""] = f.planIds;
  const before = await f.page();
  expect(before).toContain(`action="${f.thread}/p/${thu}/accept"`);
  expect(before).toContain(">Choose A · Sat 17 Dec, 19:00–21:00</button>");
  expect(before).toContain("Choosing emails everyone in it the result.");

  const res = await b.request(`${f.thread}/p/${thu}/accept`, post({ csrf: (await home(b)).csrf }));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(f.thread);
  const waiting = await f.page();
  expect(waiting).toContain(
    "<strong>Choosing A · Sat 17 Dec, 19:00–21:00</strong> — in about a minute",
  );
  expect(waiting).not.toContain(">Choose A ·"); // not offered twice
  expect((await listPlans(b.storage, await f.as(f.mara))).map((p) => p.status)).toEqual([
    "on_table",
    "on_table",
  ]); // nothing has changed for anyone yet
  expect(result(b)).toEqual([]);

  expect(await b.pass()).toBe(1);
  expect((await listPlans(b.storage, await f.as(f.mara))).map((p) => p.status)).toEqual([
    "accepted",
    "replaced",
  ]);
  expect(await f.page()).toContain(
    "<strong>Choosing A · Sat 17 Dec, 19:00–21:00:</strong> Chosen. Emailed 3 people the result.",
  );
  expect(
    result(b)
      .map((m) => m.to)
      .sort(),
  ).toEqual(["cat@example.org", "lea@example.org", "mara@example.org"]);
  const lea = result(b).find((m) => m.to === "lea@example.org");
  expect(lea?.subject).toBe('Agreed: "Pizza"');
  expect(lea?.text).toMatch(
    /^Guest \d+ chose Sat 17 Dec, 19:00–21:00 for "Pizza"\.\n\n- Pizza, Sat 17 Dec, 19:00–21:00, Ann's <flat>\n/,
  );
  expect(lea?.cause).toMatchObject({ kind: "from", senderId: f.mara, groupId: null });
  expect(lea?.text).not.toContain("See it:"); // Lea has never signed in
  expect(lea?.text).not.toContain("mara@example.org");
  const mara = result(b).find((m) => m.to === "mara@example.org");
  expect(mara?.text).toMatch(/^You chose Sat 17 Dec, 19:00–21:00 for "Pizza"\./);
  expect(mara?.text).toMatch(/\nSee it: https:\/\/whendowe\.example\/events\/[0-9a-f-]+\n/);
});

it("Undo within the minute: nothing is chosen and nobody is emailed", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  const [thu = ""] = f.planIds;
  await b.request(`${f.thread}/p/${thu}/accept`, post({ csrf: (await home(b)).csrf }));
  const undo = /action="([^"]+\/held\/[^"]+\/undo)"/.exec(await f.page())?.[1] ?? "";
  await b.request(undo, post({ csrf: (await home(b)).csrf }));
  expect(await b.pass()).toBe(0);
  expect(result(b)).toEqual([]);
  expect(
    (await listPlans(b.storage, await f.as(f.mara))).every((p) => p.status === "on_table"),
  ).toBe(true);
});

it("withdrawn in the minute, nothing is chosen; only the organizer may press; a tie has no button", async () => {
  const b = await browser({ now: () => NOW });
  const f = await poll(b);
  const [thu = "", fri = ""] = f.planIds;
  await b.request(`${f.thread}/p/${thu}/accept`, post({ csrf: (await home(b)).csrf }));
  await withdrawPlan(b.storage, await f.as(f.mara), { planId: thu, now: NOW });
  await b.pass();
  expect(await f.page()).toContain("That option is no longer on the table, so nothing was chosen.");
  expect(result(b)).toEqual([]);

  // Lea is not the organizer: no button, and the route refuses.
  await addAccount(b, "lea@example.org");
  expect(await f.page()).not.toContain(">Choose ");
  const refused = await b.request(
    `${f.thread}/p/${fri}/accept`,
    post({ csrf: (await home(b)).csrf }),
  );
  expect(refused.status).toBe(403);
  expect(await b.pass()).toBe(0);

  const c = await browser({ now: () => NOW });
  const g = await poll(c, ["lea", "cat"]);
  await castVote(c.storage, await g.as(g.people[1] ?? ""), {
    planId: g.planIds[1] ?? "",
    answer: "yes",
    now: NOW,
    arrival: SIGNED_IN,
  });
  expect(await g.page()).not.toContain(">Choose "); // 2–2: a tie leads nothing
});

it("the result drops opt-outs through the app's seam, is at each reader's tier, and stops at the cap", async () => {
  // Opted out: Cat is never mailed; the rest are.
  const c = await browser({ now: () => NOW });
  const g = await poll(c, ["lea", "cat"]);
  await suppress(c.storage, "cat@example.org", { kind: "all" }, NOW);
  await c.request(`${g.thread}/p/${g.planIds[0]}/accept`, post({ csrf: (await home(c)).csrf }));
  await c.pass();
  expect(
    result(c)
      .map((m) => m.to)
      .sort(),
  ).toEqual(["lea@example.org", "mara@example.org"]);

  // A BUSY reader reads only the time: no title, no place.
  const d = await browser({ now: () => NOW });
  const h = await poll(d, ["lea"]);
  const hm = await h.as(h.mara);
  await acceptPlan(d.storage, hm, { planId: h.planIds[0] ?? "", now: NOW });
  await d.storage.batch([
    {
      sql: "UPDATE event_participation SET visibility = 'BUSY' WHERE person_id = ?",
      params: [h.people[0] ?? ""],
    },
  ]);
  const sent: { to: string; text: string }[] = [];
  const mailed = await sendResultMail(
    {
      storage: d.storage,
      mail: {
        send: async (m) => {
          sent.push({ to: m.to, text: m.text });
        },
      },
      publicBaseUrl: "https://x.example",
    },
    hm,
    { planId: h.planIds[0] ?? "", how: "chose" },
  );
  expect(mailed).toEqual({ sent: 2, failed: 0, capped: null });
  const busy = sent.find((m) => m.to === "lea@example.org")?.text ?? "";
  expect(busy).toContain("- Busy, Sat 17 Dec, 19:00–21:00\n");
  expect(busy).not.toContain("Pizza,");
  expect(busy).not.toContain("Ann's");
  // Not accepted (yet, or any more): nobody is told.
  expect(
    await sendResultMail(
      { storage: d.storage, mail: { send: async () => {} }, publicBaseUrl: "https://x.example" },
      hm,
      { planId: h.planIds[1] ?? "", how: "chose" },
    ),
  ).toEqual({ sent: 0, failed: 0, capped: null });

  // The cap: the first refusal stops the rest, and the chooser reads how many weren't told.
  let tried = 0;
  const e = await browser({
    now: () => NOW,
    mailFails: (m) => {
      if (!m.subject.startsWith("Agreed:")) return null;
      tried += 1;
      return new MailCapReachedError({ daily: 1, monthly: 1 });
    },
  });
  const k = await poll(e, ["lea", "cat"]);
  await e.request(`${k.thread}/p/${k.planIds[0]}/accept`, post({ csrf: (await home(e)).csrf }));
  await e.pass();
  expect(await k.page()).toMatch(
    /Chosen\. Emailed 0 people the result\. Couldn(&#39;|')t email 3\./,
  );
  expect(tried).toBe(1);
});
