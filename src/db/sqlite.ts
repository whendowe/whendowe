// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Client, InStatement, InValue, Row } from "@libsql/client";
import type { SqlRow, SqlStatement, SqlValue, StoragePort } from "./port.js";

// Driver: libsql over a local SQLite file (the Node/Docker deployment).
// Chosen over better-sqlite3 because it is async-native and installs with
// `ignore-scripts=true` (prebuilt binaries as optionalDependencies — §18).

function toInStatement(s: SqlStatement): InStatement {
  return { sql: s.sql, args: s.params as InValue[] };
}

function toSqlValue(v: Row[number]): SqlValue {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as SqlValue;
}

function toSqlRow(row: Row, columns: readonly string[]): SqlRow {
  const out: Record<string, SqlValue> = {};
  for (const col of columns) {
    const value = row[col];
    out[col] = value === undefined ? null : toSqlValue(value);
  }
  return out;
}

export function sqliteStoragePort(client: Client): StoragePort {
  return {
    async query(s: SqlStatement): Promise<SqlRow[]> {
      const rs = await client.execute(toInStatement(s));
      return rs.rows.map((row) => toSqlRow(row, rs.columns));
    },

    async batch(stmts: readonly SqlStatement[]): Promise<void> {
      if (stmts.length === 0) return;
      // libsql "write" batch runs in one implicit transaction: all or nothing.
      await client.batch(stmts.map(toInStatement), "write");
    },
  };
}
