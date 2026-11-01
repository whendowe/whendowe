// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import type { SqlStatement, StoragePort } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { createApp } from "../../src/web/app.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { SESSION_COOKIE } from "../../src/web/session.js";
import { loadMigrationSql } from "../conftest.js";

// One browser against the whole app (DESIGN §13 rc18): it sends its cookie, keeps
// whatever a response sets, and counts every storage statement that writes. Shared by
// the route tests (tests/unit/accounts-routes.test.ts) and the accounts property.

export interface Browser {
  cookie: string;
  /** Statements that wrote to storage, since the browser was made. */
  writes: number;
  readonly sent: MailMessage[];
  /** The storage behind the app, for acting "elsewhere" (another device, an expiry). */
  readonly storage: StoragePort;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const writing = (s: SqlStatement) => !/^\s*SELECT\b/i.test(s.sql);

export async function browser(
  options: {
    now?: () => string;
    /** A send that fails: the error to throw for it, or null to deliver. */
    mailFails?: (m: MailMessage) => Error | null;
  } = {},
): Promise<Browser> {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const inner = sqliteStoragePort(client);
  let writes = 0;
  const storage: StoragePort = {
    query: (s) => {
      if (writing(s)) writes += 1;
      return inner.query(s);
    },
    batch: (stmts) => {
      writes += stmts.filter(writing).length;
      return inner.batch(stmts);
    },
  };
  const sent: MailMessage[] = [];
  const app = createApp({
    auth: {
      storage,
      mail: {
        send: (m) => {
          const error = options.mailFails?.(m) ?? null;
          if (error !== null) return Promise.reject(error);
          sent.push(m);
          return Promise.resolve();
        },
      },
      publicBaseUrl: "https://whendowe.example",
      secureCookies: true,
      now: options.now ?? (() => new Date().toISOString()),
    },
  });
  const b: Browser = {
    cookie: "",
    get writes() {
      return writes;
    },
    set writes(n) {
      writes = n;
    },
    sent,
    storage: inner,
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (b.cookie !== "") headers.set("cookie", b.cookie);
      const res = await app.request(path, { ...init, headers });
      const set = res.headers.get("set-cookie");
      if (set?.startsWith(`${SESSION_COOKIE}=`)) {
        const value = set.split(";")[0] ?? "";
        b.cookie = value === `${SESSION_COOKIE}=` ? "" : value;
      }
      return res;
    },
  };
  return b;
}

export const post = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

/** Request a sign-in link for an address, and open it in this browser. */
export async function addAccount(b: Browser, email: string): Promise<Response> {
  await b.request(SIGN_IN_PATH, post({ email }));
  const link = new URL(/https?:\/\/\S+/.exec(b.sent.at(-1)?.text ?? "")?.[0] ?? "");
  return b.request(CONFIRM_PATH, post({ t: link.searchParams.get("t") ?? "" }));
}

/**
 * Give the active account a handle (DESIGN §10 rc21): what others see instead of its
 * address. Tests use the part of the address before @, so "adam@example.org" is "adam".
 */
export async function nameActive(b: Browser, email: string): Promise<void> {
  const { csrf } = await home(b);
  await b.request("/account", post({ csrf, handle: email.split("@")[0] ?? "" }));
}

/** The home page as this browser sees it: the account in use, the others, its CSRF. */
export async function home(b: Browser) {
  const text = await (await b.request("/")).text();
  const switches = text.matchAll(
    /name="session" value="([^"]+)" \/>\s*<input type="hidden" name="back"[^>]*>\s*<button type="submit">Switch to <strong>([^<]+)/g,
  );
  return {
    text,
    active: /<summary>.*?<strong>([^<]+)<\/strong>/s.exec(text)?.[1] ?? null,
    others: [...switches].map((m) => ({ sessionId: m[1] ?? "", email: m[2] ?? "" })),
    csrf: /name="csrf" value="([^"]+)"/.exec(text)?.[1] ?? "",
  };
}

export const tokensIn = (cookie: string) =>
  cookie
    .slice(SESSION_COOKIE.length + 1)
    .split(".")
    .filter(Boolean);
