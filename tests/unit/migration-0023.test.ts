// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { loadMigrationSql } from "../conftest.js";

// Migration 0023 withdraws the event-polls still open (rc35), as their creators would: the
// revision bumped and a change_log row attributed to the creator. An event waiting for
// agreement (rc13) is `proposed` too, with no candidate times, and must be left alone, as
// must a poll that was already confirmed.

const T = "2101-10-01T10:00:00.000Z";

it("withdraws open event-polls, attributed to their creators, and nothing else", async () => {
  const migrations = await loadMigrationSql();
  const index = migrations.findIndex(
    (sql) => sql.includes("'withdrawn'") && sql.includes("event_candidate"),
  );
  expect(index).toBeGreaterThan(0);
  const db = createClient({ url: ":memory:" });
  for (const sql of migrations.slice(0, index)) await db.executeMultiple(sql);

  for (const id of ["ann", "bo"]) {
    await db.execute({
      sql: "INSERT INTO person (id, email, created_at) VALUES (?, ?, ?)",
      args: [id, `${id}@example.org`, T],
    });
  }
  const event = (id: string, owner: string, status: string, revision: number) =>
    db.execute({
      sql: `INSERT INTO canonical_event (id, revision, origin, owner_id, title, start_local, end_local, tzid, status, created_at, updated_at)
            VALUES (?, ?, 'user_edit', ?, 'E', '2101-10-20T19:00', '2101-10-20T20:00', 'UTC', ?, ?, ?)`,
      args: [id, revision, owner, status, T, T],
    });
  const candidate = (id: string) =>
    db.execute({
      sql: `INSERT INTO event_candidate (canonical_event_id, slot_index, all_day, start_local, end_local, tzid)
            VALUES (?, 0, 0, '2101-10-20T19:00', '2101-10-20T20:00', 'UTC')`,
      args: [id],
    });
  await event("open-poll", "ann", "proposed", 3);
  await candidate("open-poll");
  await event("bos-poll", "bo", "proposed", 1);
  await candidate("bos-poll");
  await event("confirmed-poll", "ann", "scheduled", 4);
  await candidate("confirmed-poll");
  await event("consent", "ann", "proposed", 2);

  await db.executeMultiple(migrations[index] ?? "");
  const events = await db.execute("SELECT id, status, revision FROM canonical_event ORDER BY id");
  expect(events.rows.map((r) => [r.id, r.status, r.revision])).toEqual([
    ["bos-poll", "withdrawn", 2],
    ["confirmed-poll", "scheduled", 4],
    ["consent", "proposed", 2],
    ["open-poll", "withdrawn", 4],
  ]);
  const log = await db.execute(
    "SELECT canonical_event_id, revision, actor, source, diff, created_at FROM change_log ORDER BY canonical_event_id",
  );
  expect(
    log.rows.map((r) => [r.canonical_event_id, r.revision, r.actor, r.source, r.diff]),
  ).toEqual([
    ["bos-poll", 2, "bo", "ui", '{"status":{"before":"proposed","after":"withdrawn"}}'],
    ["open-poll", 4, "ann", "ui", '{"status":{"before":"proposed","after":"withdrawn"}}'],
  ]);
  for (const r of log.rows)
    expect(String(r.created_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});
