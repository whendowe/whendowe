// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";

// The storage-port contract suite (DESIGN.md §9): MUST pass on BOTH drivers.
// tests/contract/sqlite.contract.test.ts runs it against libsql in-memory;
// tests/workers/d1.contract.test.ts runs it against a real D1 binding in workerd.
// This matrix is what stops the two deployment adapters drifting apart silently.
//
// The suite is residue-tolerant (distinct ids per test) because the D1 run shares
// one database across tests, while the sqlite run gets a fresh in-memory database.

const NOW = "2026-07-06T00:00:00Z";

function insertEvent(id: string) {
  return {
    sql: `INSERT INTO canonical_event
          (id, origin, owner_id, title, start_local, end_local, tzid, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      id,
      "user_edit",
      "owner-1",
      "Test event",
      "2026-07-06T09:00:00",
      "2026-07-06T10:00:00",
      "Europe/Prague",
      NOW,
      NOW,
    ],
  };
}

export function runStoragePortContract(makePort: () => Promise<StoragePort>): void {
  describe("storage port contract", () => {
    it("inserts via batch and reads back with parameter binding and schema defaults", async () => {
      const port = await makePort();
      await port.batch([insertEvent("evt-roundtrip")]);

      const rows = await port.query({
        sql: "SELECT id, title, revision, all_day, exdates, status FROM canonical_event WHERE id = ?",
        params: ["evt-roundtrip"],
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("evt-roundtrip");
      expect(rows[0]?.title).toBe("Test event");
      expect(rows[0]?.revision).toBe(1); // integer default
      expect(rows[0]?.all_day).toBe(0); // boolean-as-integer convention (§10)
      expect(rows[0]?.exdates).toBe("[]"); // JSON-in-text convention (§10)
      expect(rows[0]?.status).toBe("active");
    });

    it("binds NULL and reads it back as null", async () => {
      const port = await makePort();
      await port.batch([insertEvent("evt-null")]);

      const rows = await port.query({
        sql: "SELECT description, rrule FROM canonical_event WHERE id = ?",
        params: ["evt-null"],
      });
      expect(rows[0]?.description).toBeNull();
      expect(rows[0]?.rrule).toBeNull();
    });

    it("batch is atomic: a failing statement rolls back the whole batch", async () => {
      const port = await makePort();

      await expect(
        port.batch([
          insertEvent("evt-atomic"),
          insertEvent("evt-atomic"), // duplicate PK → the batch must fail…
        ]),
      ).rejects.toThrow();

      const rows = await port.query({
        sql: "SELECT id FROM canonical_event WHERE id = ?",
        params: ["evt-atomic"],
      });
      expect(rows).toHaveLength(0); // …and the first insert must NOT have survived
    });

    it("enforces the schema's CHECK constraints", async () => {
      const port = await makePort();
      await expect(
        port.batch([
          {
            sql: `INSERT INTO canonical_event
                  (id, origin, owner_id, title, start_local, end_local, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              "evt-badorigin",
              "not_a_valid_origin",
              "owner-1",
              "x",
              "2026-07-06T09:00:00",
              "2026-07-06T10:00:00",
              NOW,
              NOW,
            ],
          },
        ]),
      ).rejects.toThrow();
    });

    it("enforces UNIQUE (canonical_event_id, revision) on change_log", async () => {
      const port = await makePort();
      await port.batch([
        insertEvent("evt-changelog"),
        {
          sql: "INSERT INTO change_log (canonical_event_id, revision, actor, source, diff, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          params: ["evt-changelog", 1, "system", "ui", "{}", NOW],
        },
      ]);

      await expect(
        port.batch([
          {
            sql: "INSERT INTO change_log (canonical_event_id, revision, actor, source, diff, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params: ["evt-changelog", 1, "system", "ui", "{}", NOW],
          },
        ]),
      ).rejects.toThrow();
    });

    it("supports the optimistic revision bump (§11): zero rows on stale expected revision", async () => {
      const port = await makePort();
      await port.batch([insertEvent("evt-optimistic")]);

      await port.batch([
        {
          sql: "UPDATE canonical_event SET revision = revision + 1 WHERE id = ? AND revision = ?",
          params: ["evt-optimistic", 1],
        },
      ]);
      // Stale bump (expected=1 again) must not apply:
      await port.batch([
        {
          sql: "UPDATE canonical_event SET revision = revision + 1 WHERE id = ? AND revision = ?",
          params: ["evt-optimistic", 1],
        },
      ]);

      const rows = await port.query({
        sql: "SELECT revision FROM canonical_event WHERE id = ?",
        params: ["evt-optimistic"],
      });
      expect(rows[0]?.revision).toBe(2);
    });

    // §10's deletion model calls ON DELETE CASCADE "a row-hygiene backstop inside
    // purge", and every FK in the schema assumes it is enforced. SQLite does NOT
    // enforce foreign keys unless each connection runs PRAGMA foreign_keys = ON,
    // whereas D1 enforces them by default — so without these tests the two drivers
    // could silently disagree on the same schema.
    it("enforces foreign keys: rejects a row whose parent does not exist", async () => {
      const port = await makePort();
      await expect(
        port.batch([
          {
            sql: `INSERT INTO event_override
                  (id, canonical_event_id, recurrence_id, field_overrides, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            params: ["ovr-orphan", "evt-does-not-exist", "2026-07-06T09:00:00", "{}", NOW, NOW],
          },
        ]),
      ).rejects.toThrow();
    });

    it("enforces foreign keys: ON DELETE CASCADE removes children", async () => {
      const port = await makePort();
      await port.batch([
        insertEvent("evt-cascade"),
        {
          sql: `INSERT INTO event_override
                (id, canonical_event_id, recurrence_id, field_overrides, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: ["ovr-cascade", "evt-cascade", "2026-07-06T09:00:00", "{}", NOW, NOW],
        },
      ]);
      await port.batch([{ sql: "DELETE FROM canonical_event WHERE id = ?", params: ["evt-cascade"] }]);

      const left = await port.query({
        sql: "SELECT id FROM event_override WHERE id = ?",
        params: ["ovr-cascade"],
      });
      expect(left).toHaveLength(0);
    });

    it("empty batch is a no-op", async () => {
      const port = await makePort();
      await expect(port.batch([])).resolves.toBeUndefined();
    });
  });
}
