// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { loadMigrationSql } from "../conftest.js";

// Migration 0005 REBUILDS canonical_event (DESIGN §16 rc11's one recorded exception).
// A rebuild drops the old table, and dropping a parent table can cascade-delete its
// children — the change log, overrides, participation. So this checks the thing that
// would actually hurt: existing rows and their children survive, and M0's 'active'
// becomes 'scheduled'.
//
// SQLite (libsql) only: it steps through migrations one by one, which the workerd
// harness cannot (it applies them all up front). D1's behaviour with EXISTING data is
// therefore untested — acceptable only because no instance has ever been deployed,
// which is exactly the condition §16 attaches to this exception.

const T = "2026-10-17T10:00:00.000Z";

it("preserves existing events and their children, mapping active → scheduled", async () => {
  const migrations = await loadMigrationSql();
  const index = migrations.findIndex((sql) => sql.includes("__new_canonical_event"));
  expect(index).toBeGreaterThan(0);

  const db = createClient({ url: ":memory:" });
  for (const sql of migrations.slice(0, index)) await db.executeMultiple(sql);

  // Shape as of migration 0004: status 'active', no group_id.
  await db.execute({
    sql: `INSERT INTO canonical_event
          (id, origin, owner_id, title, start_local, end_local, tzid, status, created_at, updated_at)
          VALUES ('e1', 'user_edit', 'p1', 'Game night', '2026-10-20T19:00:00', '2026-10-20T23:00:00',
                  'Europe/Prague', 'active', ?, ?)`,
    args: [T, T],
  });
  await db.execute({
    sql: "INSERT INTO change_log (canonical_event_id, revision, actor, source, diff, created_at) VALUES ('e1', 1, 'p1', 'ui', '{}', ?)",
    args: [T],
  });
  await db.execute({
    sql: "INSERT INTO event_override (id, canonical_event_id, recurrence_id, field_overrides, created_at, updated_at) VALUES ('o1', 'e1', '2026-10-20T19:00:00', '{}', ?, ?)",
    args: [T, T],
  });

  for (const sql of migrations.slice(index)) await db.executeMultiple(sql);

  const event = (
    await db.execute("SELECT status, title, group_id FROM canonical_event WHERE id = 'e1'")
  ).rows[0];
  expect(event?.status).toBe("scheduled");
  expect(event?.title).toBe("Game night");
  expect(event?.group_id).toBeNull();
  // The children a cascading drop would have destroyed:
  expect(
    (await db.execute("SELECT count(*) AS n FROM change_log WHERE canonical_event_id = 'e1'"))
      .rows[0]?.n,
  ).toBe(1);
  expect(
    (await db.execute("SELECT count(*) AS n FROM event_override WHERE canonical_event_id = 'e1'"))
      .rows[0]?.n,
  ).toBe(1);
  // …and their foreign keys still point at the rebuilt table, so integrity holds.
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
});

it("the rebuilt table enforces the new lifecycle CHECK", async () => {
  const db = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await db.executeMultiple(sql);
  const insert = (status: string) =>
    db.execute({
      sql: `INSERT INTO canonical_event (id, origin, owner_id, title, start_local, end_local, status, created_at, updated_at)
            VALUES (?, 'user_edit', 'p', 't', '2026-10-20', '2026-10-21', ?, ?, ?)`,
      args: [`e-${status}`, status, T, T],
    });
  for (const ok of ["draft", "proposed", "scheduled", "declined", "withdrawn", "cancelled"]) {
    await expect(insert(ok)).resolves.toBeDefined();
  }
  await expect(insert("active")).rejects.toThrow();
});
