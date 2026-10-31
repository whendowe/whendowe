// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { loadMigrationSql } from "../conftest.js";
import { runPurgeContract } from "./purge.suite.js";

// Leaving, deleting and the purge pipeline vs the Node/libsql driver.
runPurgeContract(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) {
    await client.executeMultiple(sql);
  }
  return sqliteStoragePort(client);
});
