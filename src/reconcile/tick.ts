// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StoragePort } from "../db/port.js";
import type { CalendarProvider } from "../providers/base.js";

// One chunked reconcile tick (DESIGN.md §11): PULL provider changes and classify,
// then PUSH pending projections. Orchestration over the ports only — the imperative
// shell around the pure decide(). Invariants it must uphold (§9): idempotency,
// convergence, and the steady-state ZERO-WRITE path (§6 economics). Implemented in M2.
export interface TickPorts {
  readonly storage: StoragePort;
  readonly provider: CalendarProvider;
  readonly now: () => string; // injected clock (ISO-8601 UTC) — simulator-friendly (§9)
  readonly newNonce: () => string; // injected nonce generator
}

export function runTick(_ports: TickPorts, _connectionId: string): Promise<void> {
  return Promise.reject(new Error("runTick() lands in M2 (DESIGN.md §15)"));
}
