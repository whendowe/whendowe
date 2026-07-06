// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CanonicalEventRow, ProjectionRow } from "../db/schema.js";
import type { ProviderEvent } from "../providers/base.js";
import type { Action } from "./actions.js";

// The functional core (DESIGN.md §9): one pure decision per reconcile step.
// Effects (provider calls, storage writes) live in the thin interpreter in tick.ts.
// This purity is what lets Hegel exercise decisions cheaply under plain vitest.
// Implemented in M2 (§15); the signature is the M0 seam.
export function decide(
  _projection: ProjectionRow,
  _canonical: CanonicalEventRow,
  _incoming: ProviderEvent | null,
): Action {
  throw new Error("decide() lands in M2 (DESIGN.md §15)");
}
