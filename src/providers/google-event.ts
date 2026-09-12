// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { ProviderEvent } from "./base.js";

// Google Calendar event resource → ProviderEvent (DESIGN.md §12).
//
// Pure mapping, kept apart from the HTTP in google.ts so the fiddly parts — local
// time extraction, all-day handling, recurrence, identity metadata — are testable
// without a fetch anywhere near them.
//
// Every field here is UNTRUSTED input: titles, descriptions and locations are
// authored by whoever shares the calendar (§13). This module only parses and maps;
// escaping happens at render, serialising happens per RFC 5545 in ICS output.

/**
 * A Google date-time: local wall clock plus an offset, e.g.
 * "2026-09-13T09:00:00+02:00" or "...Z". Split so the wall clock can be stored
 * zone-lessly with TZID alongside, which is the RFC 5545-native shape §10 wants.
 */
const DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})$/;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const eventDateTimeSchema = z.object({
  /** Present for all-day events. Google's `end.date` is EXCLUSIVE. */
  date: z.string().optional(),
  /** Present for timed events. RFC 3339 with offset. */
  dateTime: z.string().optional(),
  /** IANA zone. Absent means the calendar's default applies. */
  timeZone: z.string().optional(),
});

export const googleEventSchema = z.object({
  id: z.string().min(1),
  // Google omits etag only in unusual cases; treat it as required since the echo
  // and change-detection layers key off it.
  etag: z.string().min(1),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
  /** Absent for untitled events — Google shows "(No title)"; we store "". */
  summary: z.string().nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  start: eventDateTimeSchema.optional(),
  end: eventDateTimeSchema.optional(),
  /** RFC 5545 lines: RRULE / EXRULE / RDATE / EXDATE. */
  recurrence: z.array(z.string()).nullish(),
  /** Set on an INSTANCE of a series, pointing at the master event. */
  recurringEventId: z.string().nullish(),
  extendedProperties: z
    .object({
      private: z.record(z.string(), z.string()).nullish(),
    })
    .nullish(),
});

export type GoogleEvent = z.infer<typeof googleEventSchema>;

interface LocalTime {
  readonly local: string;
  readonly tzid: string | null;
  readonly allDay: boolean;
}

function parseLocalTime(value: z.infer<typeof eventDateTimeSchema>, which: string): LocalTime {
  if (value.date !== undefined) {
    if (!DATE_PATTERN.test(value.date)) {
      throw new Error(`google event ${which}.date is not a calendar date`);
    }
    // All-day: a bare date, no zone. RFC 5545 DATE values are floating, and
    // Google's exclusive `end.date` already matches RFC 5545's exclusive DTEND —
    // so it is stored as received rather than adjusted.
    return { local: value.date, tzid: null, allDay: true };
  }

  if (value.dateTime === undefined) {
    throw new Error(`google event ${which} has neither date nor dateTime`);
  }

  const match = DATE_TIME_PATTERN.exec(value.dateTime);
  if (match === null) {
    throw new Error(`google event ${which}.dateTime is not an RFC 3339 timestamp`);
  }
  const [, wallClock, offset] = match;
  if (wallClock === undefined || offset === undefined) {
    throw new Error(`google event ${which}.dateTime is not an RFC 3339 timestamp`);
  }

  // The offset is discarded on purpose: the wall clock plus TZID is the canonical
  // representation (§10), and keeping the offset would freeze today's DST rules
  // into a series that must follow the zone as those rules change.
  return {
    local: wallClock,
    // A "Z" instant with no declared zone genuinely is UTC; anything else takes
    // the event's zone, falling back to the caller's calendar default.
    tzid: value.timeZone ?? (offset === "Z" ? "UTC" : null),
    allDay: false,
  };
}

/**
 * Extract the single RRULE §10 models from Google's recurrence lines.
 *
 * KNOWN MVP LIMITATION: only RRULE is taken. RDATE/EXDATE/EXRULE lines are
 * dropped, so a series carrying exclusions is imported claiming occurrences that
 * the source excludes. §16 makes this the deliberate shape — `exdates` and
 * `event_override` exist as schema seams that "stay empty", with the constraint
 * stated behaviourally as "no code path writes it yet" — but on the READ side it
 * means imported data can be wrong rather than merely incomplete. Flagged in the
 * PR; if it should instead skip such events, that is a design decision.
 */
export function extractRrule(recurrence: readonly string[] | null | undefined): string | null {
  if (recurrence === null || recurrence === undefined) {
    return null;
  }
  for (const line of recurrence) {
    if (line.startsWith("RRULE:")) {
      return line.slice("RRULE:".length);
    }
  }
  return null;
}

/** Lines this MVP cannot represent, so a caller can count or report them. */
export function unsupportedRecurrenceLines(
  recurrence: readonly string[] | null | undefined,
): readonly string[] {
  if (recurrence === null || recurrence === undefined) {
    return [];
  }
  return recurrence.filter((line) => !line.startsWith("RRULE:"));
}

/**
 * Map a parsed Google event onto the provider port's shape.
 *
 * A cancelled event carries almost no other fields — Google strips them — so it is
 * mapped to a tombstone with empty field values rather than being rejected. §11's
 * inbound-deletion handling only needs the id and the isDeleted flag.
 */
export function toProviderEvent(event: GoogleEvent): ProviderEvent {
  const isDeleted = event.status === "cancelled";

  const privateProps = event.extendedProperties?.private ?? null;
  const canonicalUid = privateProps?.canonical_uid;
  const writeNonce = privateProps?.write_nonce;

  if (isDeleted) {
    return {
      id: event.id,
      etag: event.etag,
      fields: {
        title: "",
        description: null,
        location: null,
        startLocal: "",
        endLocal: "",
        tzid: null,
        allDay: false,
        rrule: null,
      },
      metadata: {
        ...(canonicalUid === undefined ? {} : { canonicalUid }),
        ...(writeNonce === undefined ? {} : { writeNonce }),
      },
      isDeleted: true,
      recurringEventId: event.recurringEventId ?? null,
    };
  }

  if (event.start === undefined || event.end === undefined) {
    throw new Error("google event is missing start or end");
  }

  const start = parseLocalTime(event.start, "start");
  const end = parseLocalTime(event.end, "end");
  if (start.allDay !== end.allDay) {
    throw new Error("google event mixes an all-day bound with a timed one");
  }

  return {
    id: event.id,
    etag: event.etag,
    fields: {
      // Untitled events are legal in Google; "" keeps title NOT NULL satisfiable
      // without inventing a placeholder that would then sync back out.
      title: event.summary ?? "",
      description: event.description ?? null,
      location: event.location ?? null,
      startLocal: start.local,
      endLocal: end.local,
      tzid: start.tzid,
      allDay: start.allDay,
      rrule: extractRrule(event.recurrence),
    },
    metadata: {
      ...(canonicalUid === undefined ? {} : { canonicalUid }),
      ...(writeNonce === undefined ? {} : { writeNonce }),
    },
    isDeleted: false,
    recurringEventId: event.recurringEventId ?? null,
  };
}
