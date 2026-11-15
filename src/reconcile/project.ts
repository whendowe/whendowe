// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { bytesToBase64Url } from "../crypto/base64.js";
import type { CanonicalEventRow } from "../db/schema.js";
import { BUSY_SUMMARY, type FeedEntry } from "../feeds/ics.js";
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
        sourceUrl: null,
      };
    default:
      return assertNever(profile);
  }
}

/**
 * The line a copy's description begins with (§10 rc40): where to change it, and that an
 * edit made in Google is overwritten until MVP-5, since an overwrite nobody was told about
 * looks like a bug.
 */
export function fromWhenDoWeLine(url: string): string {
  return `From WhenDoWe — change it there: ${url}. Edits made here in Google aren't kept yet.`;
}

/**
 * A feed entry as its copy in a calendar (§10 rc40): exactly what the feed shows, at the
 * reader's tier. `BUSY` is "Busy" with no place, notes or link, since a link would name the
 * event; any other tier carries the line and the link.
 */
export function projectEntry(entry: FeedEntry): EventFields {
  const times = {
    startLocal: entry.startLocal,
    endLocal: entry.endLocal,
    tzid: entry.tzid,
    allDay: entry.allDay,
    rrule: entry.rrule,
  };
  if (entry.visibility === "BUSY" || entry.url === null) {
    return { title: BUSY_SUMMARY, description: null, location: null, ...times, sourceUrl: null };
  }
  const line = fromWhenDoWeLine(entry.url);
  return {
    title: entry.title,
    description: entry.description === null ? line : `${line}\n\n${entry.description}`,
    location: entry.location,
    ...times,
    sourceUrl: entry.url,
  };
}

/**
 * The push hash (§11): over the fields sent, never the raw event, so a change the copy
 * doesn't show (a tier that hides it) pushes nothing. Keys in a fixed order.
 */
export async function fieldsHash(fields: EventFields): Promise<string> {
  const ordered = [
    fields.title,
    fields.description,
    fields.location,
    fields.startLocal,
    fields.endLocal,
    fields.tzid,
    fields.allDay,
    fields.rrule,
    fields.sourceUrl,
  ];
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(ordered)),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}
