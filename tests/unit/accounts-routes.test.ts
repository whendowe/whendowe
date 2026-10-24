// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { MAX_ACCOUNTS } from "../../src/people/accounts.js";
import {
  backTo,
  CONFIRM_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_ALL_PATH,
  SIGN_OUT_PATH,
  SWITCH_PATH,
} from "../../src/web/routes/auth.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { addAccount, browser, home, post, tokensIn } from "../property/one-browser.js";

// Several accounts signed in on one browser (DESIGN §13 rc18), end to end through the
// app: adding, switching, signing out, the limit, and a form from a stale tab.

it("signing in while signed in adds an account, which becomes active", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  const form = await (await b.request(SIGN_IN_PATH)).text();
  expect(form).toContain("Add another account");
  expect(form).toContain("You stay signed in as ann@example.org");

  await addAccount(b, "bob@example.org");
  const h = await home(b);
  expect(h.active).toBe("bob@example.org");
  expect(h.others.map((o) => o.email)).toEqual(["ann@example.org"]);
  expect(tokensIn(b.cookie)).toHaveLength(2);
});

it("switching only reorders the cookie: no storage write, and back to the same page", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  await addAccount(b, "bob@example.org");
  const h = await home(b);
  const target = h.others[0]?.sessionId ?? "";

  const before = b.writes;
  const res = await b.request(
    SWITCH_PATH,
    post({ csrf: h.csrf, session: target, back: GROUPS_PATH }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(GROUPS_PATH);
  expect((await home(b)).active).toBe("ann@example.org");
  expect(b.writes).toBe(before); // switching, and the page views after it
});

it("a form from a tab rendered before a switch is refused, and changes nothing", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  await addAccount(b, "bob@example.org");
  const asBob = await home(b); // the stale tab
  await b.request(
    SWITCH_PATH,
    post({ csrf: asBob.csrf, session: asBob.others[0]?.sessionId ?? "", back: "/" }),
  );

  const before = b.writes;
  const res = await b.request(GROUPS_PATH, post({ csrf: asBob.csrf, name: "Bob's group" }));
  expect(res.status).toBe(403);
  const text = await res.text();
  expect(text).toContain("Nothing was changed");
  expect(text).toContain("This page was for <strong>bob@example.org</strong>");
  expect(b.writes).toBe(before);
  expect((await home(b)).active).toBe("ann@example.org");
});

it("sign out ends only the active account; the next becomes active", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  await addAccount(b, "bob@example.org");
  const bobsCookie = b.cookie;
  await b.request(SIGN_OUT_PATH, post({ csrf: (await home(b)).csrf }));
  const h = await home(b);
  expect(h.active).toBe("ann@example.org");
  expect(h.others).toEqual([]);
  // Bob's session is revoked on the server, so the old cookie now resolves to Ann only.
  const old = b.cookie;
  b.cookie = bobsCookie;
  expect((await home(b)).active).toBe("ann@example.org");
  // ...and that response drops the dead token from the cookie.
  expect(tokensIn(b.cookie)).toEqual(tokensIn(old));
});

it("sign out of all revokes every account on this browser and clears the cookie", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  await addAccount(b, "bob@example.org");
  const both = b.cookie;
  await b.request(SIGN_OUT_ALL_PATH, post({ csrf: (await home(b)).csrf }));
  expect(b.cookie).toBe("");
  b.cookie = both;
  expect((await home(b)).active).toBeNull();
});

it(`holds at most ${MAX_ACCOUNTS} accounts, and refuses another without using its link`, async () => {
  const b = await browser();
  for (let i = 0; i < MAX_ACCOUNTS; i++) await addAccount(b, `p${i}@example.org`);
  expect((await b.request(SIGN_IN_PATH)).status).toBe(409);
  expect((await home(b)).text).not.toContain("Add another account");

  // A link requested elsewhere and opened here is refused, but stays usable.
  await b.request(SIGN_IN_PATH, post({ email: "fifth@example.org" }));
  const link = new URL(/https?:\/\/\S+/.exec(b.sent.at(-1)?.text ?? "")?.[0] ?? "");
  const t = link.searchParams.get("t") ?? "";
  expect((await b.request(CONFIRM_PATH, post({ t }))).status).toBe(409);
  expect(tokensIn(b.cookie)).toHaveLength(MAX_ACCOUNTS);
  await b.request(SIGN_OUT_PATH, post({ csrf: (await home(b)).csrf }));
  expect((await b.request(CONFIRM_PATH, post({ t }))).status).toBe(303);
  expect((await home(b)).active).toBe("fifth@example.org");
});

it("signing in again as an account already here replaces its session", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  const first = b.cookie;
  await addAccount(b, "bob@example.org");
  await addAccount(b, "ann@example.org");
  const h = await home(b);
  expect(h.active).toBe("ann@example.org");
  expect(h.others.map((o) => o.email)).toEqual(["bob@example.org"]);
  b.cookie = first;
  expect((await home(b)).active).toBeNull(); // the old session was revoked
});

it("ignores what in the cookie is not a token", async () => {
  const b = await browser();
  await addAccount(b, "ann@example.org");
  b.cookie = `${b.cookie}.not-a-token.${"x".repeat(43)}`;
  expect((await home(b)).active).toBe("ann@example.org");
  expect(tokensIn(b.cookie)).toHaveLength(1);
});

it("a switch only ever returns to this site", () => {
  expect(backTo("/groups/abc")).toBe("/groups/abc");
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "", 3, "/a b"]) {
    expect(backTo(bad)).toBe("/");
  }
});
