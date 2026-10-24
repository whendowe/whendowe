// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { SIGN_OUT_PATH, SWITCH_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH, INVITE_PATH } from "../../src/web/routes/groups.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// A page you can't see (DESIGN §13 rc18): an event, poll or group page the active
// account may not see, while another account on this browser can, offers the switch.
// Otherwise it is the ordinary not-found — the same whether or not the thing exists.

const NIGHT = {
  title: "Session 12",
  location: "Ann's place",
  description: "",
  start: "2101-10-20T19:00",
  end: "2101-10-20T23:00",
  tzid: "Europe/Prague",
};

async function switchTo(b: Browser, email: string) {
  const h = await home(b);
  const to = h.others.find((o) => o.email === email);
  if (to === undefined) throw new Error(`${email} is not on this browser`);
  await b.request(SWITCH_PATH, post({ csrf: h.csrf, session: to.sessionId, back: "/" }));
}

/** Ann's group and event, on a browser where Bob is also signed in and active. */
async function annsThingsThenBob() {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  const created = await b.request(GROUPS_PATH, post({ csrf: (await home(b)).csrf, name: "Table" }));
  const group = created.headers.get("location") ?? "";
  const made = await b.request(`${group}/events`, post({ csrf: (await home(b)).csrf, ...NIGHT }));
  const event = made.headers.get("location") ?? "";
  expect(made.status).toBe(303);
  await addAccount(b, "bob@example.org");
  return { b, group, event };
}

it("a page only another account here can see says so, and its switch comes back to it", async () => {
  const { b, group, event } = await annsThingsThenBob();
  for (const path of [group, `${group}/events/new`, `${group}/polls/new`, event, `${event}/edit`]) {
    const before = b.writes;
    const res = await b.request(path);
    expect(res.status, path).toBe(404);
    const text = await res.text();
    expect(text, path).toContain("This is visible to ann@example.org, also signed in here");
    expect(text, path).toContain("You're viewing as <strong>bob@example.org</strong>");
    expect(text, path).not.toContain("Session 12"); // nothing of the page itself
    expect(b.writes, path).toBe(before);
  }

  const text = await (await b.request(event)).text();
  const session =
    /name="session" value="([^"]+)" \/>\s*<input type="hidden" name="back" value="([^"]+)"/.exec(
      text.slice(text.indexOf("</header>")),
    );
  expect(session?.[2]).toBe(event);
  const csrf = /name="csrf" value="([^"]+)"/.exec(text)?.[1] ?? "";
  const res = await b.request(
    SWITCH_PATH,
    post({ csrf, session: session?.[1] ?? "", back: event }),
  );
  expect(res.headers.get("location")).toBe(event);
  expect((await b.request(event)).status).toBe(200);
});

it("with no account here that can see it, a page is not found, existing or not", async () => {
  const { b, group, event } = await annsThingsThenBob();
  await switchTo(b, "ann@example.org");
  await b.request(SIGN_OUT_PATH, post({ csrf: (await home(b)).csrf }));

  const res = await b.request(group);
  expect(res.status).toBe(404);
  const text = await res.text();
  expect(text).toContain("You're signed in as <strong>bob@example.org</strong>");
  expect(text).toContain("add another account");
  expect(text).not.toContain("ann@example.org");
  // The same page for a group and an event that exist, and ones that never did.
  for (const path of [event, `${GROUPS_PATH}/nope`, "/events/nope"]) {
    const other = await b.request(path);
    expect(other.status, path).toBe(404);
    expect(await other.text(), path).toBe(text);
  }
});

it("an account that may see the group but not the event (HIDDEN) is not offered for it", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  const created = await b.request(GROUPS_PATH, post({ csrf: (await home(b)).csrf, name: "Table" }));
  const group = created.headers.get("location") ?? "";
  await b.request(
    `${group}/invites`,
    post({
      csrf: (await home(b)).csrf,
      email: "bob@example.org",
      editTier: "view",
      visibility: "HIDDEN",
    }),
  );
  const t = new URL(
    /https?:\/\/\S+\/invite\?t=\S+/.exec(b.sent.at(-1)?.text ?? "")?.[0] ?? "",
  ).searchParams.get("t");
  await b.request(INVITE_PATH, post({ t: t ?? "" })); // Bob joins on this browser
  await switchTo(b, "ann@example.org");
  const made = await b.request(`${group}/events`, post({ csrf: (await home(b)).csrf, ...NIGHT }));
  const event = made.headers.get("location") ?? "";
  await addAccount(b, "cat@example.org");
  await switchTo(b, "ann@example.org");
  await b.request(SIGN_OUT_PATH, post({ csrf: (await home(b)).csrf })); // Cat, then Bob

  expect((await home(b)).active).toBe("cat@example.org");
  const eventPage = await (await b.request(event)).text();
  expect(eventPage).toContain("<h1>Not found</h1>");
  expect(eventPage).not.toContain("This is visible to");
  const groupPage = await (await b.request(group)).text();
  expect(groupPage).toContain("This is visible to bob@example.org, also signed in here");
});
