// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { loadConfig, mailCapOf } from "../../src/config.js";
import type { StoragePort } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import {
  cappedMailPort,
  MailCapReachedError,
  SenderShareReachedError,
  senderShareOf,
} from "../../src/mail/capped.js";
import {
  cloudflareBindingMailPort,
  cloudflareRestMailPort,
  type EmailBindingLike,
} from "../../src/mail/cloudflare.js";
import { consoleMailPort } from "../../src/mail/console.js";
import { disabledMailPort, type MailMessage, type MailPort } from "../../src/mail/port.js";
import type { FetchLike, HttpRequestInit } from "../../src/oauth/http.js";
import { cappedText } from "../../src/web/layout.js";
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

// --- each sender's share (rc37, rc39) -----------------------------------------------

async function withSender(signedIn: string | null): Promise<StoragePort> {
  const s = await storage();
  await s.batch([
    {
      sql: "INSERT INTO person (id, email, created_at, signed_in_at) VALUES (?, ?, ?, ?)",
      params: ["dm", "dm@example.org", "2001-01-01T00:00:00.000Z", signedIn],
    },
  ]);
  return s;
}

const FROM_DM: MailMessage = {
  ...MESSAGE,
  subject: "dm invited you",
  cause: { kind: "from", senderId: "dm", groupId: null, why: "dm invited this address" },
};

it("mail someone caused draws on their share; their own mail and others' don't", async () => {
  const { port, sent } = recordingPort();
  const capped = cappedMailPort(port, await withSender("2001-01-01T00:00:00.000Z"), {
    cap: { daily: 10, monthly: 100, senderDaily: 2 },
    now: () => NOW,
  });
  await capped.send(FROM_DM);
  await capped.send(FROM_DM);
  const refused = capped.send(FROM_DM);
  await expect(refused).rejects.toBeInstanceOf(SenderShareReachedError);
  await expect(refused).rejects.toMatchObject({ period: "day", newUntil: null });
  await capped.send(MESSAGE); // a sign-in link to dm's own address still goes
  expect(sent.map((m) => m.subject)).toEqual([
    "dm invited you",
    "dm invited you",
    "Your sign-in link",
  ]);
});

it("a new account is told when its first week ends", async () => {
  const { port, sent } = recordingPort();
  const capped = cappedMailPort(port, await withSender("2101-05-30T09:00:00.000Z"), {
    cap: { daily: 200, monthly: 2500 },
    now: () => NOW,
  });
  for (let i = 0; i < 20; i += 1) await capped.send(FROM_DM);
  await expect(capped.send(FROM_DM)).rejects.toMatchObject({
    period: "day",
    newUntil: "2101-06-06T09:00:00.000Z",
  });
  expect(sent).toHaveLength(20);
  // Where a new account's share is no smaller, being new isn't the reason, and isn't said.
  const small = cappedMailPort(port, await withSender("2101-05-30T09:00:00.000Z"), {
    cap: { daily: 8, monthly: 100 },
    now: () => NOW,
  });
  await small.send(FROM_DM);
  await small.send(FROM_DM);
  await expect(small.send(FROM_DM)).rejects.toMatchObject({ period: "day", newUntil: null });
});

it("default shares: a quarter of the day, a fifth of the month, 20 a day for a week", () => {
  expect(senderShareOf({ daily: 200, monthly: 2500 })).toEqual({
    daily: 50,
    monthly: 500,
    newDaily: 20,
    newDays: 7,
  });
  // A small instance: a new account's share never outgrows the ordinary one.
  expect(senderShareOf({ daily: 40, monthly: 500 }).newDaily).toBe(10);
  expect(mailCapOf(loadConfig({}))).toStrictEqual({ daily: 200, monthly: 2500 });
  expect(
    mailCapOf(
      loadConfig({
        MAIL_SENDER_DAILY_CAP: "30",
        MAIL_SENDER_MONTHLY_CAP: "300",
        MAIL_NEW_SENDER_DAILY_CAP: "5",
        MAIL_NEW_SENDER_DAYS: "14",
      }),
    ),
  ).toEqual({
    daily: 200,
    monthly: 2500,
    senderDaily: 30,
    senderMonthly: 300,
    newSenderDaily: 5,
    newSenderDays: 14,
  });
});

it("a refusal names the instance's month, a share's period, and at seven days isn't new", async () => {
  const { port } = recordingPort();
  // The instance's month is full on a day with room: the instance's cap, not the share.
  const month = await withSender("2001-01-01T00:00:00.000Z");
  for (const at of ["2101-06-01", "2101-06-02", "2101-06-03", "2101-06-04", "2101-06-05"])
    await cappedMailPort(port, month, {
      cap: { daily: 5, monthly: 5 },
      now: () => `${at}T08:00:00.000Z`,
    }).send(MESSAGE);
  const full = cappedMailPort(port, month, {
    cap: { daily: 5, monthly: 5 },
    now: () => "2101-06-06T08:00:00.000Z",
  });
  const refused = full.send(FROM_DM);
  await expect(refused).rejects.toBeInstanceOf(MailCapReachedError);
  await expect(refused).rejects.not.toBeInstanceOf(SenderShareReachedError);
  await expect(refused).rejects.toThrow("outbound mail cap reached (daily 5, monthly 5); not sent");
  // Exactly seven days after the first sign-in the account isn't new any more.
  const week = cappedMailPort(port, await withSender("2101-05-25T12:00:00.000Z"), {
    cap: { daily: 200, monthly: 2500, senderDaily: 2, newSenderDaily: 1 },
    now: () => NOW,
  });
  await week.send(FROM_DM);
  await week.send(FROM_DM);
  const daily = week.send(FROM_DM);
  await expect(daily).rejects.toMatchObject({ name: "SenderShareReachedError", newUntil: null });
  await expect(daily).rejects.toThrow("this sender's daily mail share is used; not sent");
  const monthly = new SenderShareReachedError({ daily: 1, monthly: 1 }, "month", null);
  expect(monthly.message).toBe("this sender's monthly mail share is used; not sent");
  expect(new MailCapReachedError({ daily: 1, monthly: 1 }).name).toBe("MailCapReachedError");
});

it("a sign-in link draws on the anonymous share through the port", async () => {
  const { port, sent } = recordingPort();
  const capped = cappedMailPort(port, await storage(), {
    cap: { daily: 10, monthly: 100, anonymousDaily: 1 },
    now: () => NOW,
  });
  await capped.send({ ...MESSAGE, anonymous: true });
  await expect(capped.send({ ...MESSAGE, anonymous: true })).rejects.toBeInstanceOf(
    MailCapReachedError,
  );
  await capped.send(MESSAGE);
  expect(sent).toHaveLength(2);
});

it("refuses a share larger than what it is a share of, at start-up", async () => {
  const s = await storage();
  const { port } = recordingPort();
  const make = (cap: Parameters<typeof cappedMailPort>[2]["cap"]) => () =>
    cappedMailPort(port, s, { cap, now: () => NOW });
  expect(make({ daily: 10, monthly: 100, senderDaily: 11 })).toThrow(/exceeds the cap/);
  expect(make({ daily: 10, monthly: 100, senderMonthly: 101 })).toThrow(/exceeds the cap/);
  expect(make({ daily: 10, monthly: 100, senderDaily: 5, newSenderDaily: 6 })).toThrow(
    /new sender/,
  );
  expect(make({ daily: 10, monthly: 100, newSenderDays: -1 })).toThrow(/non-negative integers/);
  expect(make({ daily: 10, monthly: 100, senderDaily: 1.5 })).toThrow(/non-negative integers/);
  // Exactly the cap, or exactly the ordinary share, is fine.
  expect(
    make({ daily: 10, monthly: 100, senderDaily: 10, senderMonthly: 100, newSenderDaily: 10 }),
  ).not.toThrow();
});

it("says whose cap stopped the mail, and when it comes back", () => {
  const cap = { daily: 1, monthly: 1 };
  expect(cappedText(new MailCapReachedError(cap), NOW, true)).toBe(
    "We can't send email right now. Please try again later.",
  );
  expect(cappedText(new SenderShareReachedError(cap, "day", null), NOW, true)).toBe(
    "You've sent as much email today as one person can. You can send more tomorrow, or copy their links to send yourself.",
  );
  expect(cappedText(new SenderShareReachedError(cap, "day", null), NOW, false)).toBe(
    "You've sent as much email today as one person can. You can send more tomorrow.",
  );
  expect(
    cappedText(new SenderShareReachedError(cap, "day", "2101-06-06T09:00:00.000Z"), NOW, false),
  ).toBe(
    "New accounts send less email in their first week, until 2101-06-06 09:00 UTC. You can send more tomorrow.",
  );
  expect(cappedText(new SenderShareReachedError(cap, "month", null), NOW, true)).toBe(
    "You've sent as much email this month as one person can. You can send more from 2101-07-01, or copy their links to send yourself.",
  );
  // December rolls over into the next year.
  expect(
    cappedText(new SenderShareReachedError(cap, "month", null), "2101-12-31T23:00:00.000Z", false),
  ).toBe(
    "You've sent as much email this month as one person can. You can send more from 2102-01-01.",
  );
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
