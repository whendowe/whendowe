// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { cappedMailPort } from "../../src/mail/capped.js";
import type { MailMessage, MailPort } from "../../src/mail/port.js";
import { LOGIN_REQUESTS_PER_WINDOW } from "../../src/people/login.js";
import { createApp } from "../../src/web/app.js";
import { CONFIRM_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from "../../src/web/routes/auth.js";
import { SESSION_COOKIE } from "../../src/web/session.js";
import { loadMigrationSql } from "../conftest.js";

// The whole sign-in flow, end to end, against in-memory SQLite and a recording mail
// port. Each security property in src/web/routes/auth.ts has a case here.

const BASE = "https://whendowe.example";

interface Harness {
  app: ReturnType<typeof createApp>;
  sent: MailMessage[];
  storage: StoragePort;
}

async function harness(
  options: { mail?: MailPort; cap?: { daily: number; monthly: number } } = {},
): Promise<Harness> {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const sent: MailMessage[] = [];
  const recording: MailPort = {
    send: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
  };
  const now = () => new Date().toISOString();
  const mail = cappedMailPort(options.mail ?? recording, storage, {
    cap: options.cap ?? { daily: 1000, monthly: 1000 },
    now,
  });
  const app = createApp({ auth: { storage, mail, publicBaseUrl: BASE, secureCookies: true, now } });
  return { app, sent, storage };
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

async function requestLink(
  h: Harness,
  email: string,
  extraHeaders: Record<string, string> = {},
): Promise<URL> {
  const init = form({ email });
  const res = await h.app.request(SIGN_IN_PATH, {
    ...init,
    headers: { ...init.headers, ...extraHeaders },
  });
  expect(res.status).toBe(200);
  const text = h.sent.at(-1)?.text ?? "";
  const match = /https?:\/\/\S+/.exec(text);
  if (match === null) throw new Error("no link in mail");
  return new URL(match[0]);
}

function sessionCookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const cookie = header.split(";")[0] ?? "";
  if (!cookie.startsWith(`${SESSION_COOKIE}=`)) throw new Error(`no session cookie in: ${header}`);
  return cookie;
}

async function signIn(h: Harness, email: string): Promise<string> {
  const link = await requestLink(h, email);
  const res = await h.app.request(CONFIRM_PATH, form({ t: link.searchParams.get("t") ?? "" }));
  expect(res.status).toBe(303);
  return sessionCookieFrom(res);
}

// --- the happy path -------------------------------------------------------------

it("shows a sign-in form, and the home page offers it when signed out", async () => {
  const h = await harness();
  expect(await (await h.app.request(SIGN_IN_PATH)).text()).toContain('name="email"');
  expect(await (await h.app.request("/")).text()).toContain(SIGN_IN_PATH);
});

it("emails a link, confirms on POST, and signs the person in", async () => {
  const h = await harness();
  const cookie = await signIn(h, "Ann@Example.org");
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  expect(home).toMatch(/<summary>.*Signed in as.*<strong>ann@example\.org<\/strong>/s);
  expect(h.sent[0]?.to).toBe("ann@example.org");
  // Anyone can ask for a link: it draws on the cap's anonymous share (DESIGN §13 rc21).
  expect(h.sent[0]?.anonymous).toBe(true);
});

it("sets the session cookie HttpOnly, Secure, SameSite=Lax", async () => {
  const h = await harness();
  const link = await requestLink(h, "cookie@example.org");
  const res = await h.app.request(CONFIRM_PATH, form({ t: link.searchParams.get("t") ?? "" }));
  const header = res.headers.get("set-cookie") ?? "";
  expect(header).toContain("HttpOnly");
  expect(header).toContain("Secure");
  expect(header).toContain("SameSite=Lax");
});

// --- the security properties ------------------------------------------------------

it("builds the link from PUBLIC_BASE_URL, ignoring a forged Host header", async () => {
  // Host-header injection: if the link followed Host, an attacker could make the app
  // email a victim THEIR OWN real login link pointing at the attacker's server.
  const h = await harness();
  const link = await requestLink(h, "victim@example.org", {
    host: "evil.example",
    "x-forwarded-host": "evil.example",
  });
  expect(link.origin).toBe(BASE);
  expect(h.sent[0]?.text).not.toContain("evil.example");
});

it("GET on the link never consumes it — a mail scanner opening it burns nothing", async () => {
  const h = await harness();
  const link = await requestLink(h, "scanned@example.org");
  const path = `${link.pathname}${link.search}`;
  for (let i = 0; i < 3; i += 1) {
    expect((await h.app.request(path)).status).toBe(200);
  }
  // …and the human's POST still works afterwards.
  const res = await h.app.request(CONFIRM_PATH, form({ t: link.searchParams.get("t") ?? "" }));
  expect(res.status).toBe(303);
});

it("the confirm page names the account, and keeps the token out of Referer and caches", async () => {
  const h = await harness();
  const link = await requestLink(h, "named@example.org");
  const res = await h.app.request(`${link.pathname}${link.search}`);
  expect(await res.text()).toContain("Sign in as named@example.org?");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cache-control")).toBe("no-store");
});

it("a link works exactly once", async () => {
  const h = await harness();
  const link = await requestLink(h, "once@example.org");
  const t = link.searchParams.get("t") ?? "";
  expect((await h.app.request(CONFIRM_PATH, form({ t }))).status).toBe(303);
  const again = await h.app.request(CONFIRM_PATH, form({ t }));
  expect(again.status).toBe(400);
  expect(again.headers.get("set-cookie")).toBeNull();
  expect((await h.app.request(`${CONFIRM_PATH}?t=${encodeURIComponent(t)}`)).status).toBe(400);
});

it("a bogus or missing token is treated like an expired one", async () => {
  const h = await harness();
  expect((await h.app.request(`${CONFIRM_PATH}?t=nonsense`)).status).toBe(400);
  expect((await h.app.request(CONFIRM_PATH)).status).toBe(400);
  expect((await h.app.request(CONFIRM_PATH, form({}))).status).toBe(400);
});

it("rejects an invalid address without sending anything, and escapes it on the page", async () => {
  const h = await harness();
  const res = await h.app.request(SIGN_IN_PATH, form({ email: '"><script>alert(1)</script>' }));
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).not.toContain("<script>alert(1)</script>");
  expect(body).toContain("&lt;script&gt;");
  expect(h.sent).toHaveLength(0);
});

it("rate-limits link requests per address with a 429", async () => {
  const h = await harness();
  for (let i = 0; i < LOGIN_REQUESTS_PER_WINDOW; i += 1) await requestLink(h, "flood@example.org");
  const res = await h.app.request(SIGN_IN_PATH, form({ email: "flood@example.org" }));
  expect(res.status).toBe(429);
  expect(h.sent).toHaveLength(LOGIN_REQUESTS_PER_WINDOW);
});

it("says so when the mail cap is reached, and sends nothing", async () => {
  const h = await harness({ cap: { daily: 0, monthly: 0 } });
  const res = await h.app.request(SIGN_IN_PATH, form({ email: "capped@example.org" }));
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("can't send email right now");
  expect(h.sent).toHaveLength(0);
});

it("reports a provider failure without claiming the mail was sent", async () => {
  const failing: MailPort = { send: () => Promise.reject(new Error("provider down")) };
  const h = await harness({ mail: failing });
  const res = await h.app.request(SIGN_IN_PATH, form({ email: "down@example.org" }));
  expect(res.status).toBe(502);
  expect(await res.text()).not.toContain("Check your email");
});

// --- sign-out ---------------------------------------------------------------------

it("sign-out requires this session's CSRF token", async () => {
  const h = await harness();
  const cookie = await signIn(h, "out@example.org");

  // A forged cross-site POST without the token is refused, and the session survives.
  const forged = await h.app.request(SIGN_OUT_PATH, {
    ...form({}),
    headers: { ...form({}).headers, cookie },
  });
  expect(forged.status).toBe(403);
  expect(await (await h.app.request("/", { headers: { cookie } })).text()).toContain(
    "Signed in as",
  );

  // The real form carries the token rendered into the page.
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "";
  const init = form({ csrf });
  const res = await h.app.request(SIGN_OUT_PATH, { ...init, headers: { ...init.headers, cookie } });
  expect(res.status).toBe(303);
  expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
  // The old cookie is dead server-side too, not merely cleared in this browser.
  expect(await (await h.app.request("/", { headers: { cookie } })).text()).not.toContain(
    "Signed in as",
  );
});

it("signing in again after sign-out reuses the same person", async () => {
  const h = await harness();
  await signIn(h, "same@example.org");
  await signIn(h, "SAME@example.org");
  const rows = await h.storage.query({
    sql: "SELECT count(*) AS n FROM person WHERE email = ?",
    params: ["same@example.org"],
  });
  expect(rows[0]?.n).toBe(1);
});
