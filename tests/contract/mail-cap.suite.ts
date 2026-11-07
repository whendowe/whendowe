// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  MailCapReachedError,
  refusal,
  reserveMailSlot,
  SenderShareReachedError,
  sentThisMonth,
} from "../../src/mail/capped.js";
import { exportPerson } from "../../src/privacy/export.js";

// The send-cap reservation (DESIGN §13 rc9) on BOTH drivers. It depends on
// INSERT … SELECT … WHERE … RETURNING behaving identically on libsql and D1, which is
// precisely the kind of assumption this matrix exists to check.
//
// Residue-tolerant like the storage-port suite: the D1 run shares one database across
// tests, so every test uses its own far-future month and never sees another's rows.

let people = 0;

/** A person to send as; `signedIn` null = never signed in. Unique across the shared D1 run. */
async function sender(port: StoragePort, signedIn: string | null): Promise<string> {
  people += 1;
  const id = `mail-cap-sender-${people}-${Math.random().toString(36).slice(2)}`;
  await port.batch([
    {
      sql: "INSERT INTO person (id, email, created_at, signed_in_at) VALUES (?, ?, ?, ?)",
      params: [id, `${id}@example.org`, "2001-01-01T00:00:00.000Z", signedIn],
    },
  ]);
  return id;
}

const LONG_AGO = "2001-01-01T00:00:00.000Z";

export function runMailCapContract(makePort: () => Promise<StoragePort>): void {
  describe("mail cap reservation", () => {
    it("reserves up to the daily cap, then refuses", async () => {
      const port = await makePort();
      const cap = { daily: 2, monthly: 100 };
      const at = "2101-01-15T10:00:00.000Z";
      expect(await reserveMailSlot(port, cap, at)).toBe(true);
      expect(await reserveMailSlot(port, cap, at)).toBe(true);
      expect(await reserveMailSlot(port, cap, at)).toBe(false);
      // A new UTC day starts a fresh daily count.
      expect(await reserveMailSlot(port, cap, "2101-01-16T00:00:00.000Z")).toBe(true);
    });

    it("enforces the monthly cap across days", async () => {
      const port = await makePort();
      const cap = { daily: 10, monthly: 3 };
      expect(await reserveMailSlot(port, cap, "2101-02-01T09:00:00.000Z")).toBe(true);
      expect(await reserveMailSlot(port, cap, "2101-02-02T09:00:00.000Z")).toBe(true);
      expect(await reserveMailSlot(port, cap, "2101-02-03T09:00:00.000Z")).toBe(true);
      expect(await reserveMailSlot(port, cap, "2101-02-04T09:00:00.000Z")).toBe(false);
      // …and a new month starts fresh.
      expect(await reserveMailSlot(port, cap, "2101-03-01T09:00:00.000Z")).toBe(true);
    });

    it("a zero cap never reserves", async () => {
      const port = await makePort();
      expect(
        await reserveMailSlot(port, { daily: 0, monthly: 0 }, "2101-04-01T00:00:00.000Z"),
      ).toBe(false);
    });

    it("anonymous sends stop at their share, leaving the rest for everyone else", async () => {
      // rc21: a script asking for sign-in links can't spend the whole day.
      const port = await makePort();
      const cap = { daily: 4, monthly: 100, anonymousDaily: 1 };
      const at = "2101-06-10T12:00:00.000Z";
      expect(await reserveMailSlot(port, cap, at, { anonymous: true })).toBe(true);
      expect(await reserveMailSlot(port, cap, at, { anonymous: true })).toBe(false);
      expect(await reserveMailSlot(port, cap, at)).toBe(true);
      expect(await reserveMailSlot(port, cap, at)).toBe(true);
      expect(await reserveMailSlot(port, cap, at)).toBe(true);
      expect(await reserveMailSlot(port, cap, at)).toBe(false);
      // The default share is a quarter of the day.
      const quarter = { daily: 8, monthly: 100 };
      const day = "2101-06-11T12:00:00.000Z";
      const anon = await Promise.all(
        Array.from({ length: 5 }, () => reserveMailSlot(port, quarter, day, { anonymous: true })),
      );
      expect(anon.filter(Boolean)).toHaveLength(2);
    });

    it("a sender stops at their daily share; everyone else still sends (rc37)", async () => {
      const port = await makePort();
      const cap = { daily: 10, monthly: 100, senderDaily: 2 };
      const [a, b] = [await sender(port, LONG_AGO), await sender(port, LONG_AGO)];
      const at = "2101-07-10T12:00:00.000Z";
      expect(await reserveMailSlot(port, cap, at, { senderId: a })).toBe(true);
      expect(await reserveMailSlot(port, cap, at, { senderId: a })).toBe(true);
      expect(await reserveMailSlot(port, cap, at, { senderId: a })).toBe(false);
      expect(await reserveMailSlot(port, cap, at, { senderId: b })).toBe(true);
      expect(await reserveMailSlot(port, cap, at)).toBe(true); // mail to your own address
      expect(await reserveMailSlot(port, cap, at, { anonymous: true })).toBe(true);
      // A new UTC day is a fresh share.
      expect(await reserveMailSlot(port, cap, "2101-07-11T00:00:00.000Z", { senderId: a })).toBe(
        true,
      );
      expect(await sentThisMonth(port, a, at)).toBe(3);
      // The export shows the count, all the cap keeps about you.
      expect((await exportPerson(port, a, at)).emails_you_caused_this_month).toBe(3);
      expect(await sentThisMonth(port, b, at)).toBe(1);
      expect(await sentThisMonth(port, a, "2101-08-01T00:00:00.000Z")).toBe(0);
    });

    it("a sender's monthly share holds across days, and a new month is fresh", async () => {
      const port = await makePort();
      const cap = {
        daily: 10,
        monthly: 100,
        senderDaily: 10,
        senderMonthly: 2,
        newSenderDaily: 10,
      };
      const a = await sender(port, LONG_AGO);
      expect(await reserveMailSlot(port, cap, "2101-08-01T09:00:00.000Z", { senderId: a })).toBe(
        true,
      );
      expect(await reserveMailSlot(port, cap, "2101-08-02T09:00:00.000Z", { senderId: a })).toBe(
        true,
      );
      expect(await reserveMailSlot(port, cap, "2101-08-03T09:00:00.000Z", { senderId: a })).toBe(
        false,
      );
      expect(await reserveMailSlot(port, cap, "2101-09-01T09:00:00.000Z", { senderId: a })).toBe(
        true,
      );
    });

    it("a new account sends less for its first days, then the ordinary share (rc39)", async () => {
      const port = await makePort();
      const cap = {
        daily: 100,
        monthly: 1000,
        senderDaily: 3,
        newSenderDaily: 1,
        newSenderDays: 7,
      };
      const first = "2101-10-01T12:00:00.000Z";
      const a = await sender(port, first);
      const reserve = (at: string) => reserveMailSlot(port, cap, at, { senderId: a });
      // A minute before its seventh day is up: still new.
      const lastNewDay = "2101-10-08T11:59:00.000Z";
      expect(await reserve(lastNewDay)).toBe(true);
      expect(await reserve(lastNewDay)).toBe(false);
      // Seven days to the millisecond: the ordinary share, counting what the day already sent.
      const grown = "2101-10-08T12:00:00.000Z";
      expect(await reserve(grown)).toBe(true);
      expect(await reserve(grown)).toBe(true);
      expect(await reserve(grown)).toBe(false);
      // Someone who never signed in is treated as new.
      const never = await sender(port, null);
      const day = "2101-10-20T12:00:00.000Z";
      expect(await reserveMailSlot(port, cap, day, { senderId: never })).toBe(true);
      expect(await reserveMailSlot(port, cap, day, { senderId: never })).toBe(false);
    });

    it("a refusal says whose: the instance's cap, or the sender's day, month or first week", async () => {
      const port = await makePort();
      const cap = { daily: 4, monthly: 100, senderDaily: 2, senderMonthly: 3, newSenderDaily: 1 };
      const old = await sender(port, LONG_AGO);
      const day1 = "2101-11-02T12:00:00.000Z";
      await reserveMailSlot(port, cap, day1, { senderId: old });
      await reserveMailSlot(port, cap, day1, { senderId: old });
      const daily = await refusal(port, cap, day1, { senderId: old });
      expect(daily).toBeInstanceOf(SenderShareReachedError);
      expect(daily).toMatchObject({ period: "day", newUntil: null });
      const day2 = "2101-11-03T12:00:00.000Z";
      await reserveMailSlot(port, cap, day2, { senderId: old });
      expect(await refusal(port, cap, day2, { senderId: old })).toMatchObject({
        period: "month",
        newUntil: null,
      });
      const fresh = await sender(port, "2101-11-01T08:00:00.000Z");
      await reserveMailSlot(port, cap, day2, { senderId: fresh });
      expect(await refusal(port, cap, day2, { senderId: fresh })).toMatchObject({
        period: "day",
        newUntil: "2101-11-08T08:00:00.000Z",
      });
      const never = await sender(port, null);
      expect(await refusal(port, cap, day2, { senderId: never })).toMatchObject({
        period: "day",
        newUntil: null,
      });
      // Two more fill the instance's day (4): then it is the instance's cap, not theirs.
      const other = await sender(port, LONG_AGO);
      await reserveMailSlot(port, cap, day2, { senderId: other });
      await reserveMailSlot(port, cap, day2);
      const full = await refusal(port, cap, day2, { senderId: other });
      expect(full).toBeInstanceOf(MailCapReachedError);
      expect(full).not.toBeInstanceOf(SenderShareReachedError);
      expect(await refusal(port, cap, day2)).not.toBeInstanceOf(SenderShareReachedError);
    });

    it("erasing a sender forgets who sent, and keeps the count", async () => {
      const port = await makePort();
      const a = await sender(port, LONG_AGO);
      const at = "2101-12-05T12:00:00.000Z";
      const cap = { daily: 10, monthly: 100 };
      expect(await reserveMailSlot(port, cap, at, { senderId: a })).toBe(true);
      await port.batch([{ sql: "DELETE FROM person WHERE id = ?", params: [a] }]);
      const rows = await port.query({
        sql: "SELECT count(*) AS n, count(sender_id) AS named FROM mail_send WHERE day = ?",
        params: ["2101-12-05"],
      });
      expect(rows[0]).toMatchObject({ n: 1, named: 0 });
    });

    it("concurrent sends from one sender never exceed their share", async () => {
      const port = await makePort();
      const a = await sender(port, LONG_AGO);
      const cap = { daily: 100, monthly: 1000, senderDaily: 3 };
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          reserveMailSlot(port, cap, "2102-01-10T12:00:00.000Z", { senderId: a }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(3);
    });

    it("concurrent reservations never exceed the cap", async () => {
      // 20 simultaneous attempts against a cap of 5: exactly 5 may win. With a
      // count-then-insert design every one of them could see room and send. This
      // exercises the single-statement semantics on each driver; it is not a
      // multi-isolate race test (one test process can't produce that), which is why
      // the guarantee rests on the statement being atomic, documented in capped.ts.
      const port = await makePort();
      const cap = { daily: 5, monthly: 100 };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => reserveMailSlot(port, cap, "2101-05-10T12:00:00.000Z")),
      );
      expect(results.filter(Boolean)).toHaveLength(5);
    });
  });
}
