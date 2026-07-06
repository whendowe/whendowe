// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EventFields, ProviderEvent } from "../providers/base.js";

// The Action ADT (DESIGN.md §9): the exhaustive tagged union that the pure
// decide() returns and the thin interpreter executes. The switch-with-never
// pattern guarantees every case is handled; adding a variant breaks the build
// everywhere it must be handled — that is the point.

export type Action =
  | { readonly kind: "create_mirror"; readonly fields: EventFields }
  | { readonly kind: "adopt_orphan"; readonly providerEventId: string; readonly etag: string }
  | { readonly kind: "push"; readonly providerEventId: string; readonly fields: EventFields }
  | { readonly kind: "suppress_echo"; readonly incoming: ProviderEvent }
  | { readonly kind: "apply_inbound"; readonly incoming: ProviderEvent }
  | { readonly kind: "delete_mirror"; readonly providerEventId: string }
  | { readonly kind: "noop" };

/** Exhaustiveness backstop: reachable only if a switch misses a variant. */
export function assertNever(x: never): never {
  throw new Error(`unreachable action variant: ${JSON.stringify(x)}`);
}

// Structured-log reasons (DESIGN.md §14): every decision the pure core can make
// is a loggable reason, so the logs are a trace of decisions, not prose.
export type LogReason =
  | "pushed"
  | "skipped_unchanged"
  | "echo_suppressed"
  | "inbound_applied"
  | "inbound_delete_unsubscribed"
  | "skipped_instance_edit"
  | "adopted_orphan"
  | "retry_scheduled"
  | "error";

/** Map an Action to its §14 log-vocabulary reason. Total by construction. */
export function actionReason(action: Action): LogReason {
  switch (action.kind) {
    case "create_mirror":
    case "push":
      return "pushed";
    case "adopt_orphan":
      return "adopted_orphan";
    case "suppress_echo":
      return "echo_suppressed";
    case "apply_inbound":
      return "inbound_applied";
    case "delete_mirror":
      return "inbound_delete_unsubscribed";
    case "noop":
      return "skipped_unchanged";
    default:
      return assertNever(action);
  }
}
