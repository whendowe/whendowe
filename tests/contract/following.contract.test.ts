// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { loadMigrationSql } from "../conftest.js";
import { runFollowingContract } from "./following.suite.js";

// Following calendars vs the Node/libsql driver.
runFollowingContract(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) {
    await client.executeMultiple(sql);
  }
  return sqliteStoragePort(client);
});
