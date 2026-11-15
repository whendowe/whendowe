// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CanonicalEventRow, ProjectionRow } from "../db/schema.js";
import type { EventFields, ProviderEvent } from "../providers/base.js";
import type { Action } from "./actions.js";

// The functional core (DESIGN.md §9): one pure decision per reconcile step.
// Effects (provider calls, storage writes) live in the thin interpreter in tick.ts.
// This purity is what lets Hegel exercise decisions cheaply under plain vitest.
// decide() is PULL's, for MVP-5 (§15); the signature is the M0 seam. decidePush() is PUSH's,
// MVP-4 G2.
export function decide(
  _projection: ProjectionRow,
  _canonical: CanonicalEventRow,
  _incoming: ProviderEvent | null,
): Action {
  throw new Error("decide() lands in M2 (DESIGN.md §15)");
}

/** What a copy should be, worked out from the person's feed (§10 rc40), with its push hash. */
export interface DesiredCopy {
  readonly fields: EventFields;
  readonly hash: string;
}

/**
 * PUSH's decision for one event on one connection (§11): converge the copy to what the feed
 * says it should be. `desired` null means the event shouldn't be in this calendar (cancelled,
 * left, removed); `projection` null means WhenDoWe has never made a copy here.
 *
 * Steady state is `noop` with no write (§6): a synced copy whose hash matches. A copy found
 * deleted in the provider is never put back and never touched again (rc40). An errored copy
 * waits for its `retry_at` (§12). A copy WhenDoWe removed is made again if the event returns.
 */
export function decidePush(
  desired: DesiredCopy | null,
  projection: ProjectionRow | null,
  now: string,
): Action {
  if (projection === null) {
    return desired === null ? { kind: "noop" } : { kind: "create_mirror", fields: desired.fields };
  }
  if (projection.unsubscribedAt !== null) return { kind: "noop" };
  if (projection.state === "error" && projection.retryAt !== null && projection.retryAt > now) {
    return { kind: "noop" };
  }
  const id = projection.state === "deleted" ? null : projection.providerEventId;
  if (desired === null) {
    return id === null ? { kind: "noop" } : { kind: "delete_mirror", providerEventId: id };
  }
  if (id === null) return { kind: "create_mirror", fields: desired.fields };
  if (projection.state === "synced" && projection.lastPushedHash === desired.hash) {
    return { kind: "noop" };
  }
  return { kind: "push", providerEventId: id, fields: desired.fields };
}

/** The first retry after a failure, and the longest wait between two (§12 capped backoff). */
export const RETRY_FIRST_MS = 60_000;
export const RETRY_CAP_MS = 60 * 60_000;

/**
 * When to try a failed copy again: a minute after the first failure, then twice the last wait,
 * at most an hour. The last wait is read back from the row (`retry_at` less `updated_at`, both
 * set at the failure), so the backoff needs no attempt counter.
 */
export function nextRetryAt(now: string, previous: ProjectionRow | null): string {
  const last =
    previous?.state === "error" && previous.retryAt !== null
      ? Date.parse(previous.retryAt) - Date.parse(previous.updatedAt)
      : 0;
  const wait = last > 0 ? Math.min(last * 2, RETRY_CAP_MS) : RETRY_FIRST_MS;
  return new Date(Date.parse(now) + wait).toISOString();
}
