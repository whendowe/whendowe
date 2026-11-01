// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { StoragePort } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { cappedMailPort, MailCapReachedError } from "../../src/mail/capped.js";
import {
  cloudflareBindingMailPort,
  cloudflareRestMailPort,
  type EmailBindingLike,
} from "../../src/mail/cloudflare.js";
import { consoleMailPort } from "../../src/mail/console.js";
import { disabledMailPort, type MailMessage, type MailPort } from "../../src/mail/port.js";
import type { FetchLike, HttpRequestInit } from "../../src/oauth/http.js";
import { loadMigrationSql } from "../conftest.js";

const MESSAGE: MailMessage = {
  to: "player@example.com",
  subject: "Your sign-in link",
  text: "https://whendowe.org/auth/confirm?t=SECRET-TOKEN-VALUE",
  cause: { kind: "self" },
};
const FROM = { address: "login@notify.whendowe.org", name: "WhenDoWe" };
const NOW = "2101-06-01T12:00:00.000Z";

async function storage(): Promise<StoragePort> {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  return sqliteStoragePort(client);
}

function recordingPort(): { port: MailPort; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    port: {
      send: (m) => {
        sent.push(m);
        return Promise.resolve();
      },
    },
    sent,
  };
}

// --- fail closed by default -------------------------------------------------------

it("defaults to the disabled adapter, which refuses to send", async () => {
  expect(loadConfig({}).MAIL_PROVIDER).toBe("disabled");
  await expect(disabledMailPort.send(MESSAGE)).rejects.toThrow(/not configured/);
});

it("console adapter prints the message — explicit development opt-in only", async () => {
  const lines: string[] = [];
  await consoleMailPort((l) => lines.push(l)).send(MESSAGE);
  expect(lines.join("\n")).toContain("SECRET-TOKEN-VALUE");
  expect(lines.join("\n")).toContain("NOT sent");
});

// --- the cap ------------------------------------------------------------------------

it("sends while under the cap and refuses, unsent, once it is reached", async () => {
  const { port, sent } = recordingPort();
  const capped = cappedMailPort(port, await storage(), {
    cap: { daily: 2, monthly: 100 },
    now: () => NOW,
  });
  await capped.send(MESSAGE);
  await capped.send(MESSAGE);
  await expect(capped.send(MESSAGE)).rejects.toBeInstanceOf(MailCapReachedError);
  expect(sent).toHaveLength(2);
});

it("counts a failed send against the cap (bounds a retry loop)", async () => {
  // The accident this exists for: a provider failing and the caller retrying.
  const failing: MailPort = { send: () => Promise.reject(new Error("provider down")) };
  const capped = cappedMailPort(failing, await storage(), {
    cap: { daily: 3, monthly: 100 },
    now: () => NOW,
  });
  for (let i = 0; i < 3; i += 1)
    await expect(capped.send(MESSAGE)).rejects.toThrow(/provider down/);
  await expect(capped.send(MESSAGE)).rejects.toBeInstanceOf(MailCapReachedError);
});

it("rejects an incoherent cap at construction", async () => {
  const s = await storage();
  const { port } = recordingPort();
  expect(() => cappedMailPort(port, s, { cap: { daily: 10, monthly: 5 }, now: () => NOW })).toThrow(
    /exceeds monthly/,
  );
  expect(() =>
    cappedMailPort(port, s, { cap: { daily: 1.5, monthly: 5 }, now: () => NOW }),
  ).toThrow(/non-negative integers/);
});

it("defaults sit under the 3,000 included sends, so overage is impossible by default", () => {
  const config = loadConfig({});
  expect(config.MAIL_DAILY_CAP).toBe(200);
  expect(config.MAIL_MONTHLY_CAP).toBe(2500);
  expect(config.MAIL_MONTHLY_CAP).toBeLessThan(3000);
});

it("rejects a malformed sender address", () => {
  expect(() => loadConfig({ MAIL_FROM_ADDRESS: "not an email" })).toThrow();
  expect(loadConfig({ MAIL_FROM_ADDRESS: FROM.address }).MAIL_FROM_ADDRESS).toBe(FROM.address);
});

// --- Cloudflare binding (hosted Workers) --------------------------------------------

it("binding: sends with `email` in the from object and no credentials", async () => {
  const calls: unknown[] = [];
  const binding: EmailBindingLike = {
    send: (m) => {
      calls.push(m);
      return Promise.resolve({ messageId: "x" });
    },
  };
  await cloudflareBindingMailPort(binding, FROM).send(MESSAGE);
  expect(calls[0]).toEqual({
    to: MESSAGE.to,
    from: { email: FROM.address, name: FROM.name },
    subject: MESSAGE.subject,
    text: MESSAGE.text,
  });
});

it("binding: surfaces the error code but never the raw message", async () => {
  const binding: EmailBindingLike = {
    send: () =>
      Promise.reject(
        Object.assign(new Error(`bad recipient ${MESSAGE.to}`), { code: "E_RECIPIENT" }),
      ),
  };
  const failure = cloudflareBindingMailPort(binding, FROM).send(MESSAGE);
  await expect(failure).rejects.toThrow(/E_RECIPIENT/);
  await expect(failure).rejects.not.toThrow(new RegExp(MESSAGE.to));
});

// --- Cloudflare REST (Node self-host) -----------------------------------------------

function restFake(
  status: number,
  body: unknown,
): { impl: FetchLike; calls: { url: string; init: HttpRequestInit }[] } {
  const calls: { url: string; init: HttpRequestInit }[] = [];
  return {
    calls,
    impl: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    },
  };
}

it("REST: posts to the account's send endpoint with `address` in the from object", async () => {
  const { impl, calls } = restFake(200, { success: true, result: { delivered: [MESSAGE.to] } });
  await cloudflareRestMailPort({
    accountId: "acct",
    apiToken: "tok",
    from: FROM,
    fetchImpl: impl,
  }).send(MESSAGE);
  expect(calls[0]?.url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/acct/email/sending/send",
  );
  expect(calls[0]?.init.headers.authorization).toBe("Bearer tok");
  expect(JSON.parse(calls[0]?.init.body ?? "{}").from).toEqual({
    address: FROM.address,
    name: FROM.name,
  });
});

it("REST: a permanent bounce is a failure even on HTTP 200", async () => {
  const { impl } = restFake(200, { success: true, result: { permanent_bounces: [MESSAGE.to] } });
  const failure = cloudflareRestMailPort({
    accountId: "a",
    apiToken: "t",
    from: FROM,
    fetchImpl: impl,
  }).send(MESSAGE);
  await expect(failure).rejects.toThrow(/permanently bounced/);
  await expect(failure).rejects.not.toThrow(new RegExp(MESSAGE.to));
});

it("REST: success: false and HTTP errors fail without leaking the token", async () => {
  const notOk = restFake(200, { success: false });
  await expect(
    cloudflareRestMailPort({
      accountId: "a",
      apiToken: "SECRET-API-TOKEN",
      from: FROM,
      fetchImpl: notOk.impl,
    }).send(MESSAGE),
  ).rejects.toThrow(/success: false/);

  const unauthorized = restFake(401, {
    success: false,
    errors: [{ code: 10000, message: "Authentication error" }],
  });
  const failure = cloudflareRestMailPort({
    accountId: "a",
    apiToken: "SECRET-API-TOKEN",
    from: FROM,
    fetchImpl: unauthorized.impl,
  }).send(MESSAGE);
  await expect(failure).rejects.toThrow(/HTTP 401/);
  await expect(failure).rejects.not.toThrow(/SECRET-API-TOKEN/);
});
