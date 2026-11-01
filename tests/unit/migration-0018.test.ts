// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { loadMigrationSql } from "../conftest.js";

// Migration 0018 fills person.signed_in_at from what survives of signing in (rc24). It
// must err towards "signed in": an address marked never-signed-in can be deleted from an
// opt-out link without signing in, so a real account must never be marked that way.
// Sessions are purged after they expire, so each other trace is checked on its own.

const T = "2101-10-01T10:00:00.000Z";

it("marks everyone with a trace of signing in, and only them", async () => {
  const migrations = await loadMigrationSql();
  const index = migrations.findIndex((sql) => sql.includes("`signed_in_at`"));
  expect(index).toBeGreaterThan(0);
  const db = createClient({ url: ":memory:" });
  for (const sql of migrations.slice(0, index)) await db.executeMultiple(sql);

  const person = (id: string, displayName: string | null = null) =>
    db.execute({
      sql: "INSERT INTO person (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
      args: [id, `${id}@example.org`, displayName, T],
    });
  for (const id of ["session", "member", "owner", "calendar", "never"]) await person(id);
  await person("named", "Named");
  await db.execute({
    sql: "INSERT INTO session (id, token_hash, person_id, created_at, expires_at) VALUES ('s1', 'h1', 'session', '2101-10-05T00:00:00.000Z', ?)",
    args: [T],
  });
  await db.execute({
    sql: "INSERT INTO person_group (id, name, created_by, created_at) VALUES ('g1', 'G', 'member', ?)",
    args: [T],
  });
  await db.execute({
    sql: "INSERT INTO group_member (group_id, person_id, role, joined_at) VALUES ('g1', 'member', 'organizer', ?)",
    args: [T],
  });
  await db.execute({
    sql: `INSERT INTO canonical_event (id, origin, owner_id, title, start_local, end_local, tzid, status, created_at, updated_at)
          VALUES ('e1', 'user_edit', 'owner', 'E', '2101-10-20T19:00', '2101-10-20T20:00', 'UTC', 'scheduled', ?, ?)`,
    args: [T, T],
  });
  await db.execute({
    sql: `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id, access_token_enc, refresh_token_enc, created_at, updated_at)
          VALUES ('c1', 'calendar', 'google', 'calendar@example.org', 'primary', 'x', 'x', ?, ?)`,
    args: [T, T],
  });

  await db.executeMultiple(migrations[index] ?? "");
  const rows = await db.execute("SELECT id, signed_in_at FROM person ORDER BY id");
  expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.signed_in_at]))).toEqual({
    calendar: T,
    member: T,
    named: T,
    never: null,
    owner: T,
    session: "2101-10-05T00:00:00.000Z", // the first session, where there is one
  });
});
