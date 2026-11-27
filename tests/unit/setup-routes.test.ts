// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../../deploy/node/cli.js";
import { capabilityConfigOf, loadConfig } from "../../src/config.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { disabledMailPort } from "../../src/mail/port.js";
import { MAX_ACCOUNTS } from "../../src/people/accounts.js";
import type { CapabilityConfig } from "../../src/people/capability.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { createSession } from "../../src/people/session.js";
import { createApp } from "../../src/web/app.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { OPERATOR_PATH } from "../../src/web/routes/operator.js";
import { ownerNotice, SETUP_COMMAND, SETUP_PATH } from "../../src/web/routes/setup.js";
import { SESSION_COOKIE } from "../../src/web/session.js";
import { loadMigrationSql } from "../conftest.js";

// The first owner of an instance with no operator (DESIGN §10 rc60 *Running without email*):
// `setup-link` prints a link to its own terminal, its page claims the instance, and an instance
// with no owner says so to signed-out visitors. No mail is configured: none is needed.

const NO_OWNER = "This instance has no owner yet";

async function harness(options: { publicBaseUrl?: string; operators?: string } = {}) {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const config = loadConfig({
    PUBLIC_BASE_URL: options.publicBaseUrl ?? "http://localhost",
    OPERATOR_EMAILS: options.operators ?? "",
  });
  const capabilities: CapabilityConfig = capabilityConfigOf(config);
  const app = createApp({
    auth: {
      storage,
      mail: disabledMailPort,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      secureCookies: false,
      now: () => new Date().toISOString(),
      capabilities,
    },
  });
  const printed: string[] = [];
  const cli = (...args: string[]) =>
    runCli(args, {
      storage,
      config,
      now: () => new Date().toISOString(),
      out: (text) => printed.push(text),
    });
  /** The last link the command printed. */
  const lastLink = () => new URL(/https?:\/\/\S+/.exec(printed.at(-1) ?? "")?.[0] ?? "");
  return { app, storage, cli, printed, lastLink };
}

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

afterEach(() => {
  vi.restoreAllMocks();
});

it("with no owner, home and sign-in say so; setup-link prints a link whose page makes you the owner", async () => {
  const h = await harness();
  for (const path of ["/", SIGN_IN_PATH])
    expect(await (await h.app.request(path)).text()).toContain(NO_OWNER);

  expect(await h.cli("setup-link")).toBe(0);
  const link = h.lastLink();
  expect(link.origin + link.pathname).toBe(`http://localhost${SETUP_PATH}`);
  const t = link.searchParams.get("t") ?? "";

  // The page renders and uses nothing: twice is fine.
  for (let i = 0; i < 2; i++) {
    const res = await h.app.request(`${SETUP_PATH}?t=${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("Make me the owner");
  }

  const claimed = await h.app.request(
    SETUP_PATH,
    post({ t, name: "Ann", email: "Ann@Example.org" }),
  );
  expect(claimed.status).toBe(303);
  expect(claimed.headers.get("location")).toBe("/");
  const cookie = cookieOf(claimed);
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  expect(home).toContain("ann@example.org");
  const operator = await h.app.request(OPERATOR_PATH, { headers: { cookie } });
  expect(operator.status).toBe(200);
  expect(await operator.text()).toMatch(/<h2>Operators<\/h2>\s*<ul><li>ann@example\.org<\/li>/);
  const via = await h.storage.query({ sql: "SELECT via FROM session", params: [] });
  expect(via).toEqual([{ via: "setup" }]);

  // Owned: the notice is gone, the link is spent, and no new one is made.
  for (const path of ["/", SIGN_IN_PATH])
    expect(await (await h.app.request(path)).text()).not.toContain(NO_OWNER);
  const again = await h.app.request(`${SETUP_PATH}?t=${t}`);
  expect(again.status).toBe(400);
  expect(await again.text()).toContain(SETUP_COMMAND);
  expect(await h.cli("setup-link")).toBe(1);
  expect(h.printed.at(-1)).toContain("already has an owner");
  expect(h.printed.at(-1)).not.toMatch(/https?:\/\//);
});

it("a wrong name or address keeps the link and says why; a bad link says how to get another", async () => {
  const h = await harness();
  await h.cli("setup-link");
  const t = h.lastLink().searchParams.get("t") ?? "";
  const noName = await h.app.request(SETUP_PATH, post({ t, name: " ", email: "a@example.org" }));
  expect(noName.status).toBe(400);
  const page = await noName.text();
  expect(page).toContain("Choose a name.");
  expect(page).toContain(`name="t" value="${t}"`);
  const noAddress = await h.app.request(SETUP_PATH, post({ t, name: "Ann", email: "nope" }));
  expect(noAddress.status).toBe(400);
  expect(await noAddress.text()).toContain("doesn&#39;t look like an email address");

  await findOrCreatePerson(h.storage, "taken@example.org", { now: new Date().toISOString() });
  const taken = await h.app.request(
    SETUP_PATH,
    post({ t, name: "Ann", email: "taken@example.org" }),
  );
  expect(taken.status).toBe(400);
  expect(await taken.text()).toContain("already has that address");
  expect(cookieOf(taken)).toBe("");

  for (const bad of [`${SETUP_PATH}`, `${SETUP_PATH}?t=nope`]) {
    const res = await h.app.request(bad);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(SETUP_COMMAND);
  }
  expect(
    (await h.app.request(SETUP_PATH, post({ t: "nope", name: "A", email: "b@example.org" })))
      .status,
  ).toBe(400);
  // Still good after all that.
  expect(
    (await h.app.request(SETUP_PATH, post({ t, name: "Ann", email: "a@example.org" }))).status,
  ).toBe(303);
});

it("the page says when it was opened at another address than the links are made from", async () => {
  const elsewhere = await harness({ publicBaseUrl: "https://when.example" });
  await elsewhere.cli("setup-link");
  const t = elsewhere.lastLink().searchParams.get("t") ?? "";
  expect(elsewhere.lastLink().origin).toBe("https://when.example");
  const page = await (await elsewhere.app.request(`${SETUP_PATH}?t=${t}`)).text();
  expect(page).toContain("PUBLIC_BASE_URL=http://localhost");

  const same = await harness();
  await same.cli("setup-link");
  const t2 = same.lastLink().searchParams.get("t") ?? "";
  expect(await (await same.app.request(`${SETUP_PATH}?t=${t2}`)).text()).not.toContain(
    "PUBLIC_BASE_URL",
  );
});

it("an instance with operators in its configuration has no setup and says nothing about owners", async () => {
  const h = await harness({ operators: "op@example.org" });
  for (const path of ["/", SIGN_IN_PATH])
    expect(await (await h.app.request(path)).text()).not.toContain(NO_OWNER);
  expect(await h.cli("setup-link")).toBe(1);
});

it("sign-in-link signs in an account that exists, as console; nobody else", async () => {
  const h = await harness();
  expect(await h.cli("sign-in-link", "ghost@example.org")).toBe(1);
  expect(h.printed.at(-1)).toContain("No account here");
  expect(await h.cli("sign-in-link", "not an address")).toBe(2);
  expect(await h.cli("sign-in-link")).toBe(2);
  expect(await h.cli("something-else")).toBe(2);

  await findOrCreatePerson(h.storage, "lost@example.org", { now: new Date().toISOString() });
  expect(await h.cli("sign-in-link", "Lost@Example.org")).toBe(0);
  const link = h.lastLink();
  expect(link.pathname).toBe(CONFIRM_PATH);
  const signedIn = await h.app.request(CONFIRM_PATH, post({ t: link.searchParams.get("t") ?? "" }));
  expect(signedIn.status).toBe(303);
  expect(await h.storage.query({ sql: "SELECT via FROM session", params: [] })).toEqual([
    { via: "console" },
  ]);
});

it("no link is ever logged: the commands print only to their terminal, the pages log nothing", async () => {
  const logged: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args) => {
      logged.push(args);
    });
  const h = await harness();
  await h.cli("setup-link");
  const t = h.lastLink().searchParams.get("t") ?? "";
  await h.app.request(`${SETUP_PATH}?t=${t}`);
  await h.app.request(SETUP_PATH, post({ t, name: "Ann", email: "ann@example.org" }));
  await h.cli("sign-in-link", "ann@example.org");
  expect(logged).toEqual([]);
});

it("the setup pages are titled and sensitive, keep what was typed (cut to 200), and say each problem", async () => {
  const h = await harness();
  await h.cli("setup-link");
  const t = h.lastLink().searchParams.get("t") ?? "";
  const form = await (await h.app.request(`${SETUP_PATH}?t=${t}`)).text();
  expect(form).toContain("<title>Setup · WhenDoWe</title>");
  // Nothing between the introduction and the form: no error, no address warning.
  expect(form).toMatch(/Others join when you invite them\.<\/p>\s*<form/);
  expect(form).toContain('name="name" maxlength="40" required autocomplete="name" value=""');
  expect(form).toContain('name="email" type="email" required autocomplete="email" value=""');

  const long = await h.app.request(
    SETUP_PATH,
    post({ t, name: "n".repeat(300), email: `${"e".repeat(300)}@example.org` }),
  );
  expect(long.status).toBe(400);
  expect(long.headers.get("cache-control")).toBe("no-store");
  expect(long.headers.get("referrer-policy")).toBe("no-referrer");
  const longPage = await long.text();
  expect(longPage).toContain("<title>Setup · WhenDoWe</title>");
  expect(longPage).toContain("Keep it under 40 characters.");
  expect(longPage).toContain(`value="${"n".repeat(200)}"`);
  expect(longPage).toContain(`value="${"e".repeat(200)}"`);

  const missing = await h.app.request(SETUP_PATH, post({ t }));
  expect(missing.status).toBe(400);
  expect(await missing.text()).toContain("Choose a name.");

  const forms: Record<string, string>[] = [{}, { t: "nope", name: "Ann", email: "a@example.org" }];
  for (const fields of forms) {
    const used = await h.app.request(SETUP_PATH, post(fields));
    expect(used.status).toBe(400);
    const text = await used.text();
    expect(text).toContain("<title>Setup link · WhenDoWe</title>");
    expect(text).toContain(SETUP_COMMAND);
    expect(text).not.toContain("already has that address");
  }
});

it("a browser already holding four accounts is refused before the link is used", async () => {
  const h = await harness();
  const tokens: string[] = [];
  for (let i = 0; i < MAX_ACCOUNTS; i++) {
    const p = await findOrCreatePerson(h.storage, `p${i}@example.org`, {
      now: new Date().toISOString(),
    });
    tokens.push(
      (await createSession(h.storage, p.id, { now: new Date().toISOString(), via: "magic" })).token,
    );
  }
  const cookie = `${SESSION_COOKIE}=${tokens.join(".")}`;
  await h.cli("setup-link");
  const t = h.lastLink().searchParams.get("t") ?? "";
  const full = await h.app.request(
    SETUP_PATH,
    post({ t, name: "Ann", email: "ann@example.org" }, cookie),
  );
  expect(full.status).toBe(409);
  expect(
    (await h.app.request(SETUP_PATH, post({ t, name: "Ann", email: "ann@example.org" }))).status,
  ).toBe(303);
});

it("the notice is asked of the database until there is an owner, then is nothing", async () => {
  const h = await harness();
  const notice = ownerNotice({
    storage: h.storage,
    mail: disabledMailPort,
    publicBaseUrl: "http://localhost",
    secureCookies: false,
    now: () => new Date().toISOString(),
  });
  expect(String(await notice())).toContain(NO_OWNER);
  await h.cli("setup-link");
  const t = h.lastLink().searchParams.get("t") ?? "";
  await h.app.request(SETUP_PATH, post({ t, name: "Ann", email: "ann@example.org" }));
  expect(await notice()).toBe("");
  expect(await notice()).toBe("");
});

it("each command takes exactly its arguments, and says what went wrong", async () => {
  const h = await harness();
  await findOrCreatePerson(h.storage, "lost@example.org", { now: new Date().toISOString() });
  for (const args of [
    ["setup-link", "extra"],
    ["sign-in-link", "lost@example.org", "extra"],
    ["setup", "lost@example.org"],
    [],
  ]) {
    expect(await h.cli(...args)).toBe(2);
    expect(h.printed.at(-1)).toContain("Usage:");
    expect(h.printed.at(-1)).not.toMatch(/https?:\/\//);
  }
  expect(await h.storage.query({ sql: "SELECT id FROM setup_token", params: [] })).toEqual([]);
  expect(await h.storage.query({ sql: "SELECT id FROM login_token", params: [] })).toEqual([]);
  expect(await h.cli("sign-in-link", "not an address")).toBe(2);
  expect(h.printed.at(-1)).toBe("That doesn't look like an email address.\n");
});

it("only the owner the setup link made is an operator; another account is not", async () => {
  const h = await harness();
  await h.cli("setup-link");
  const t = h.lastLink().searchParams.get("t") ?? "";
  await h.app.request(SETUP_PATH, post({ t, name: "Ann", email: "ann@example.org" }));
  await findOrCreatePerson(h.storage, "bob@example.org", { now: new Date().toISOString() });
  await h.cli("sign-in-link", "bob@example.org");
  const bob = cookieOf(
    await h.app.request(CONFIRM_PATH, post({ t: h.lastLink().searchParams.get("t") ?? "" })),
  );
  expect((await h.app.request(OPERATOR_PATH, { headers: { cookie: bob } })).status).toBe(404);
});
