// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@libsql/client";
import { loadConfig } from "../../src/config.js";

// The Node migration runner (DESIGN.md §6): applies the same plain .sql files that
// `wrangler d1 migrations apply` runs on Cloudflare, tracked in the same table
// wrangler uses (d1_migrations) so the two runners agree on what has been applied.
const config = loadConfig(process.env);
const migrationsDir = path.resolve(config.MIGRATIONS_DIR);

const client = createClient({ url: config.DATABASE_URL });

await client.execute(
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)",
);

const applied = new Set(
  (await client.execute("SELECT name FROM d1_migrations")).rows.map((r) => String(r.name)),
);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(path.join(migrationsDir, file), "utf-8");
  await client.executeMultiple(sql);
  await client.execute({
    sql: "INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)",
    args: [file, new Date().toISOString()],
  });
  console.log(JSON.stringify({ reason: "migration_applied", name: file }));
}

client.close();
