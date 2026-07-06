// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CanonicalEventRow } from "../db/schema.js";
import type { ProviderEvent } from "../providers/base.js";

// Conflict resolution policy (DESIGN.md §11 apply_inbound_edit). MVP policy is
// last-write-wins; the designed upgrade path (base_revision + non-overlapping
// fast-forward merge) needs no schema change. Implemented in M4 (§15).
export interface ConflictResolution {
  readonly accepted: boolean;
  readonly fields: Partial<CanonicalEventRow>;
}

export function resolveConflict(
  _canonical: CanonicalEventRow,
  _incoming: ProviderEvent,
  _baseRevision: number | null,
): ConflictResolution {
  throw new Error("resolveConflict() lands in M4 (DESIGN.md §15)");
}
