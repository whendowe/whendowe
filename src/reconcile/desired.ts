// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CanonicalEventRow, ProjectionRow } from "../db/schema.js";
import type { EventFields } from "../providers/base.js";
import { parseVisibilityProfile, project } from "./project.js";

// Desired-state policy incl. the deletion model (DESIGN.md §10): interpretation of
// recorded intents is a pure policy — desired(canonical, projection) -> Present | Absent.
// Reconcile converges mirrors to it; every candidate deletion UX (instant vanish,
// grace period, trash-with-restore, per-calendar unsubscribe) is just a policy
// variant. Swapping policies touches no schema and no sync machinery.

export type Desired =
  | { readonly kind: "present"; readonly fields: EventFields }
  | { readonly kind: "absent" };

/** Default MVP policy: cancelled events and unsubscribed projections vanish. */
export function desired(canonical: CanonicalEventRow, projection: ProjectionRow): Desired {
  if (canonical.status === "cancelled") {
    return { kind: "absent" };
  }
  if (projection.state === "pending_delete" || projection.state === "deleted") {
    return { kind: "absent" };
  }
  return {
    kind: "present",
    fields: project(canonical, parseVisibilityProfile(projection.visibilityProfile)),
  };
}
