// SPDX-License-Identifier: AGPL-3.0-or-later
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { SqlRow, SqlStatement, StoragePort } from "./port.js";

// Driver: Cloudflare D1 binding. Type-only platform imports; the binding itself
// is injected by deploy/cloudflare (DESIGN.md §16: no platform imports in domain code).
export function d1StoragePort(db: D1Database): StoragePort {
  const prepare = (s: SqlStatement): D1PreparedStatement => db.prepare(s.sql).bind(...s.params);

  return {
    async query(s: SqlStatement): Promise<SqlRow[]> {
      const { results } = await prepare(s).all();
      return results as SqlRow[];
    },

    async batch(stmts: readonly SqlStatement[]): Promise<void> {
      if (stmts.length === 0) return;
      // D1 batch() is sequential and transactional: any failure rolls back all.
      await db.batch(stmts.map(prepare));
    },
  };
}
