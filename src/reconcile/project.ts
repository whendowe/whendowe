// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { CanonicalEventRow } from "../db/schema.js";
import type { EventFields } from "../providers/base.js";
import { assertNever } from "./actions.js";

// project(event, profile) -> fields (DESIGN.md §5 seam). MVP: FULL (identity) only;
// PUBLIC/INVITED/CONFIRMED tiers arrive behind this same signature. The §9
// visibility-integrity property holds trivially for FULL and becomes load-bearing
// the day a second profile appears. The push hash is computed over THIS filtered
// fieldset, never over raw canonical (§16).

export const visibilityProfileSchema = z.enum(["FULL"]);
export type VisibilityProfile = z.infer<typeof visibilityProfileSchema>;

/** Parse the stored text column at the storage boundary (zod at every I/O boundary). */
export function parseVisibilityProfile(value: string): VisibilityProfile {
  return visibilityProfileSchema.parse(value);
}

export function project(event: CanonicalEventRow, profile: VisibilityProfile): EventFields {
  switch (profile) {
    case "FULL":
      return {
        title: event.title,
        description: event.description,
        location: event.location,
        startLocal: event.startLocal,
        endLocal: event.endLocal,
        tzid: event.tzid,
        allDay: event.allDay === 1,
        rrule: event.rrule,
      };
    default:
      return assertNever(profile);
  }
}
