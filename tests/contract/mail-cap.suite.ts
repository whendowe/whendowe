// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { reserveMailSlot } from "../../src/mail/capped.js";

// The send-cap reservation (DESIGN §13 rc9) on BOTH drivers. It depends on
// INSERT … SELECT … WHERE … RETURNING behaving identically on libsql and D1, which is
// precisely the kind of assumption this matrix exists to check.
//
// Residue-tolerant like the storage-port suite: the D1 run shares one database across
// tests, so every test uses its own far-future month and never sees another's rows.

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
