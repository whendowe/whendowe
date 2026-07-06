// SPDX-License-Identifier: AGPL-3.0-or-later

// The async storage port — the ONLY way domain code touches storage (DESIGN.md §6/§16).
// SQLite dialect only; no D1-exclusive features. Atomicity is the statement-list
// batch() — the shared unit of atomicity on both platforms (D1 has no interactive
// transactions). All SQL is parameterized; string-built SQL is forbidden (AGENTS.md).

/** Values SQLite can bind. Booleans are stored as integer 0/1 by convention (§10). */
export type SqlValue = string | number | null | Uint8Array;

export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

export interface StoragePort {
  /** Run one parameterized statement and return its rows (empty for non-SELECT). */
  query(stmt: SqlStatement): Promise<SqlRow[]>;
  /**
   * Run a list of parameterized statements atomically: either all apply or none.
   * This is the transaction primitive on both D1 and SQLite drivers.
   */
  batch(stmts: readonly SqlStatement[]): Promise<void>;
}

/** Convenience constructor for a parameterized statement. */
export function stmt(sql: string, ...params: readonly SqlValue[]): SqlStatement {
  return { sql, params };
}
