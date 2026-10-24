// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
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
});

it("lists polls first, then what's coming soonest first, then the past folded away", async () => {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "ann@example.org");
  const group = await make(b, GROUPS_PATH, { name: "Table" });
  await make(b, `${group}/events`, at("Later", "2101-12-01T19:00", "2101-12-01T22:00"));
  await make(b, `${group}/events`, at("Sooner", "2101-11-05T19:00", "2101-11-05T22:00"));
  await make(b, `${group}/events`, at("Long ago", "2101-10-01T19:00", "2101-10-01T22:00"));
  await make(b, `${group}/polls`, {
    title: "When next?",
    location: "",
    description: "",
    tzid: "Europe/Prague",
    start_0: "2101-11-10T19:00",
    end_0: "2101-11-10T22:00",
    start_1: "2101-11-11T19:00",
    end_1: "2101-11-11T22:00",
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
