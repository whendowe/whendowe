// SPDX-License-Identifier: AGPL-3.0-or-later

// change_log append + diff (DESIGN.md §10/§14): the append-only attribution feed
// and merge base. diff() is the pure half; append (a batch() write pairing the
// revision bump with the log row) lands with the M3 UI / M4 inbound path.

export interface FieldChange {
  readonly before: string | number | null;
  readonly after: string | number | null;
}

export type Diff = Record<string, FieldChange>;

/** Field-level diff of two flat records. Empty diff ⇒ no revision bump, no log row (§11). */
export function diff(
  before: Record<string, string | number | null>,
  after: Record<string, string | number | null>,
): Diff {
  const out: Record<string, FieldChange> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const b = before[key] ?? null;
    const a = after[key] ?? null;
    if (b !== a) {
      out[key] = { before: b, after: a };
    }
  }
  return out;
}
