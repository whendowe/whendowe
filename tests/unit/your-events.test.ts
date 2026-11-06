// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { findOrCreatePerson } from "../../src/people/person.js";
import { castVote, createPollThread } from "../../src/plans/plan.js";
import { findThreadForMember } from "../../src/plans/thread.js";
import { SWITCH_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// Home is Your events (DESIGN §10 rc15): every event you take part in, whether you came
// to it through a group or were added to it directly, each at your own tier.

const NOW = "2101-11-01T10:00:00.000Z";

const at = (title: string, start: string, end: string) => ({
  title,
  location: "",
  description: "",
  start,
  end,
  tzid: "Europe/Prague",
});

async function make(b: Browser, path: string, fields: Record<string, string>): Promise<string> {
  const res = await b.request(path, post({ csrf: (await home(b)).csrf, ...fields }));
  expect(res.status, await res.clone().text()).toBe(303);
  return res.headers.get("location") ?? "";
}

async function switchTo(b: Browser, email: string) {
  const h = await home(b);
  const to = h.others.find((o) => o.email === email);
  await b.request(SWITCH_PATH, post({ csrf: h.csrf, session: to?.sessionId ?? "", back: "/" }));
}

it("someone with nothing yet is told where events come from", async () => {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "ann@example.org");
  const text = (await home(b)).text;
  expect(text).toContain("<h1>Your events</h1>");
  expect(text).toContain("Nothing planned yet");
  expect(text).not.toContain("Finding a time");
});

it("lists what is being decided first, then what's coming soonest first, then the past folded away", async () => {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "ann@example.org");
  const group = await make(b, GROUPS_PATH, { name: "Table" });
  await make(b, `${group}/events`, at("Later", "2101-12-01T19:00", "2101-12-01T22:00"));
  await make(b, `${group}/events`, at("Sooner", "2101-11-05T19:00", "2101-11-05T22:00"));
  await make(b, `${group}/events`, at("Long ago", "2101-10-01T19:00", "2101-10-01T22:00"));
  // A question being decided is listed first.
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  await createPollThread(b.storage, {
    creatorId: ann.id,
    group: null,
    fields: {
      title: "When next?",
      description: null,
      location: null,
      allDay: false,
      tzid: "Europe/Prague",
    },
    candidates: [
      { startLocal: "2101-11-10T19:00", endLocal: "2101-11-10T22:00" },
      { startLocal: "2101-11-11T19:00", endLocal: "2101-11-11T22:00" },
    ],
    people: [],
    now: NOW,
  });

  const before = b.writes;
  const text = (await home(b)).text;
  expect(b.writes).toBe(before);
  const order = ["Finding a time", "When next?", "Coming up", "Sooner", "Later", "Past (1)"];
  const positions = order.map((s) => text.indexOf(s));
  expect(
    positions.every((p) => p >= 0),
    JSON.stringify(positions),
  ).toBe(true);
  expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  expect(text.indexOf("Long ago")).toBeGreaterThan(text.indexOf("Past (1)"));
});

it("an event you were added to directly is yours, at your tier, until you are removed", async () => {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "ann@example.org");
  const group = await make(b, GROUPS_PATH, { name: "Table" });
  const busy = await make(
    b,
    `${group}/events`,
    at("Private", "2101-11-05T19:00", "2101-11-05T22:00"),
  );
  const full = await make(b, `${group}/events`, at("Open", "2101-11-06T19:00", "2101-11-06T22:00"));
  await make(b, `${busy}/people`, {
    email: "bob@example.org",
    editTier: "view",
    visibility: "BUSY",
  });
  await make(b, `${full}/people`, {
    email: "bob@example.org",
    editTier: "view",
    visibility: "FULL",
  });

  await addAccount(b, "bob@example.org"); // Bob is in no group at all
  let text = (await home(b)).text;
  expect(text).toContain(">Open</a>");
  expect(text).not.toContain("Private"); // his tier sees only that the time is taken…
  expect(text).toContain(">Busy</a>"); // …so that's what his list says
  expect(text).not.toContain("Nothing planned yet");

  // Removed, it's gone from his list.
  await switchTo(b, "ann@example.org");
  const person = /name="person" value="([^"]+)"/.exec(await (await b.request(full)).text())?.[1];
  await b.request(
    `${full}/people/remove`,
    post({ csrf: (await home(b)).csrf, person: person ?? "" }),
  );
  await switchTo(b, "bob@example.org");
  text = (await home(b)).text;
  expect(text).not.toContain(">Open</a>");
});

it("one list of what is being decided: threads waiting for you, then the rest (rc28)", async () => {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "ann@example.org");
  const [ann, bob] = await Promise.all(
    ["ann@example.org", "bob@example.org"].map((e) =>
      findOrCreatePerson(b.storage, e, { now: NOW }),
    ),
  );
  const times = [
    { startLocal: "2101-11-21", endLocal: "2101-11-22" },
    { startLocal: "2101-11-14", endLocal: "2101-11-15" },
  ];
  const fields = { description: null, location: null, allDay: true, tzid: null };
  const thread = (title: string, creatorId: string, people: string[]) =>
    createPollThread(b.storage, {
      creatorId,
      group: null,
      fields: { ...fields, title },
      candidates: times,
      people,
      now: NOW,
    });
  // Ann's own poll waits for Bob; Bob's waits for Ann; one more is already decided.
  await thread("Hers", ann?.id ?? "", [bob?.id ?? ""]);
  await thread("His", bob?.id ?? "", [ann?.id ?? ""]);
  const done = await thread("Settled", bob?.id ?? "", [ann?.id ?? ""]);
  const asAnn = await findThreadForMember(b.storage, done.threadId, ann?.id ?? "");
  if (asAnn === null) throw new Error("member");
  await castVote(b.storage, asAnn, { planId: done.planIds[0] ?? "", answer: "yes", now: NOW });
  const text = (await home(b)).text;
  const finding = text.slice(
    text.indexOf("<h2>Finding a time</h2>"),
    text.indexOf("</ul>", text.indexOf("<h2>Finding a time</h2>")),
  );
  const order = ["His", "2 waiting for your vote", "Hers", "2 on the table"];
  const positions = order.map((s) => finding.indexOf(s));
  expect(
    positions.every((p) => p >= 0),
    JSON.stringify(positions),
  ).toBe(true);
  expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  expect(finding).not.toContain("Settled"); // decided: on the plans page, not here
  expect(finding.split("His").length).toBe(2); // once
  expect(text).not.toContain("Nothing planned yet");
  expect(text).not.toContain("<h2>Plans</h2>");
  expect(text).toContain('<a href="/plans">Your plans</a>');
  expect(text).toContain('<a href="/plans/new">+ Start planning</a>');
});
