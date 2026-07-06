// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Shared test helpers (Node-side projects only — workerd tests get migrations
// via the TEST_MIGRATIONS binding in vitest.workers.config.ts instead).

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** All migration files' SQL, in application order. */
export async function loadMigrationSql(): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map((f) => readFile(path.join(migrationsDir, f), "utf-8")));
}
