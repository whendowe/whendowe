// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { loadMigrationSql } from "../conftest.js";
import { runEventsContract } from "./events.suite.js";

// Events contract vs the Node/libsql driver.
runEventsContract(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) {
    await client.executeMultiple(sql);
  }
  return sqliteStoragePort(client);
});
