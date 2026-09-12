// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import {
  extractRrule,
  googleEventSchema,
  toProviderEvent,
  unsupportedRecurrenceLines,
} from "../../src/providers/google-event.js";

function mapped(raw: unknown) {
  return toProviderEvent(googleEventSchema.parse(raw));
}

const TIMED = {
  id: "evt-1",
  etag: '"etag-1"',
  status: "confirmed",
  summary: "Standup",
  start: { dateTime: "2026-09-13T09:00:00+02:00", timeZone: "Europe/Prague" },
  end: { dateTime: "2026-09-13T09:15:00+02:00", timeZone: "Europe/Prague" },
};

// --- timed events and the wall-clock split ---

it("splits a timed event into wall clock plus TZID", () => {
  const event = mapped(TIMED);
  expect(event.fields.startLocal).toBe("2026-09-13T09:00:00");
  expect(event.fields.endLocal).toBe("2026-09-13T09:15:00");
  expect(event.fields.tzid).toBe("Europe/Prague");
  expect(event.fields.allDay).toBe(false);
  expect(event.id).toBe("evt-1");
  expect(event.etag).toBe('"etag-1"');
  expect(event.isDeleted).toBe(false);
});

it("discards the offset rather than storing it", () => {
  // Keeping +02:00 would freeze today's DST rules into a series that has to follow
  // the zone as those rules change (§10's RFC 5545-native model).
  const event = mapped(TIMED);
  expect(event.fields.startLocal).not.toContain("+");
  expect(event.fields.startLocal).not.toContain("Z");
});

it("treats a Z instant with no declared zone as UTC", () => {
  const event = mapped({
    ...TIMED,
    start: { dateTime: "2026-09-13T09:00:00Z" },
    end: { dateTime: "2026-09-13T10:00:00Z" },
  });
  expect(event.fields.startLocal).toBe("2026-09-13T09:00:00");
  expect(event.fields.tzid).toBe("UTC");
});

it("leaves tzid null when only an offset is given", () => {
  // The calendar's default zone applies; the caller knows it, this mapper does not.
  const event = mapped({
    ...TIMED,
    start: { dateTime: "2026-09-13T09:00:00+02:00" },
    end: { dateTime: "2026-09-13T10:00:00+02:00" },
  });
  expect(event.fields.tzid).toBeNull();
});

it("accepts fractional seconds", () => {
  const event = mapped({
    ...TIMED,
    start: { dateTime: "2026-09-13T09:00:00.000+02:00" },
    end: { dateTime: "2026-09-13T09:15:00.500+02:00" },
  });
  expect(event.fields.startLocal).toBe("2026-09-13T09:00:00.000");
});

// --- all-day events ---

it("maps an all-day event to bare dates with no zone", () => {
  const event = mapped({
    id: "evt-2",
    etag: '"e"',
    summary: "Holiday",
    start: { date: "2026-09-13" },
    end: { date: "2026-09-14" },
  });
  expect(event.fields.allDay).toBe(true);
  expect(event.fields.startLocal).toBe("2026-09-13");
  // Google's end.date is EXCLUSIVE, and so is RFC 5545's DTEND for DATE values —
  // storing it unchanged is the correct mapping, not an off-by-one.
  expect(event.fields.endLocal).toBe("2026-09-14");
  expect(event.fields.tzid).toBeNull();
});

it("refuses an event that mixes an all-day bound with a timed one", () => {
  expect(() =>
    mapped({
      id: "evt-3",
      etag: '"e"',
      start: { date: "2026-09-13" },
      end: { dateTime: "2026-09-13T10:00:00Z" },
    }),
  ).toThrow(/mixes an all-day bound/);
});

// --- cancellations ---

it("maps a cancelled event to a tombstone", () => {
  // Google strips almost every field from a cancellation, so the mapping must not
  // require them — §11's inbound-deletion path needs only the id and the flag.
  const event = mapped({ id: "evt-4", etag: '"e"', status: "cancelled" });
  expect(event.isDeleted).toBe(true);
  expect(event.id).toBe("evt-4");
  expect(event.fields.title).toBe("");
});

it("keeps identity metadata on a tombstone", () => {
  // Without this, an inbound deletion could not be matched to its canonical event.
  const event = mapped({
    id: "evt-5",
    etag: '"e"',
    status: "cancelled",
    extendedProperties: { private: { canonical_uid: "uid-1", write_nonce: "nonce-1" } },
  });
  expect(event.isDeleted).toBe(true);
  expect(event.metadata.canonicalUid).toBe("uid-1");
  expect(event.metadata.writeNonce).toBe("nonce-1");
});

// --- identity metadata (§12) ---

it("reads canonical uid and write nonce from private extended properties", () => {
  const event = mapped({
    ...TIMED,
    extendedProperties: { private: { canonical_uid: "uid-9", write_nonce: "nonce-9" } },
  });
  expect(event.metadata.canonicalUid).toBe("uid-9");
  expect(event.metadata.writeNonce).toBe("nonce-9");
});

it("leaves metadata empty for a foreign event", () => {
  // An event we did not write has no canonical uid — that absence is what marks it
  // as an import candidate rather than one of our own projections (§12).
  const event = mapped(TIMED);
  expect(event.metadata.canonicalUid).toBeUndefined();
  expect(event.metadata.writeNonce).toBeUndefined();
});

it("ignores unrelated private properties", () => {
  const event = mapped({
    ...TIMED,
    extendedProperties: { private: { somethingElse: "x" } },
  });
  expect(event.metadata.canonicalUid).toBeUndefined();
});

// --- recurrence ---

it("extracts the RRULE from recurrence lines", () => {
  const event = mapped({ ...TIMED, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] });
  expect(event.fields.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
});

it("returns null when there is no recurrence", () => {
  expect(mapped(TIMED).fields.rrule).toBeNull();
  expect(extractRrule(null)).toBeNull();
  expect(extractRrule(undefined)).toBeNull();
  expect(extractRrule(["EXDATE;TZID=Europe/Prague:20260920T090000"])).toBeNull();
});

it("drops recurrence lines the MVP cannot represent, and can report them", () => {
  // KNOWN LIMITATION: the series is imported claiming occurrences its source
  // excludes. §16 keeps `exdates` empty by design, but on the read side that makes
  // imported data wrong rather than merely incomplete.
  const recurrence = ["RRULE:FREQ=WEEKLY", "EXDATE;TZID=Europe/Prague:20260920T090000"];
  const event = mapped({ ...TIMED, recurrence });
  expect(event.fields.rrule).toBe("FREQ=WEEKLY");
  expect(unsupportedRecurrenceLines(recurrence)).toEqual([
    "EXDATE;TZID=Europe/Prague:20260920T090000",
  ]);
  expect(unsupportedRecurrenceLines(null)).toEqual([]);
});

it("marks an instance of a series", () => {
  // Instances are skipped downstream: the MVP syncs whole series only (§16).
  const event = mapped({ ...TIMED, recurringEventId: "evt-master" });
  expect(event.recurringEventId).toBe("evt-master");
  expect(mapped(TIMED).recurringEventId).toBeNull();
});

// --- optional and hostile field values ---

it("maps an untitled event to an empty title", () => {
  // Google permits untitled events; "" satisfies NOT NULL without inventing a
  // placeholder that would later sync back out as if the user had typed it.
  expect(mapped({ ...TIMED, summary: undefined }).fields.title).toBe("");
  expect(mapped({ ...TIMED, summary: null }).fields.title).toBe("");
});

it("nulls absent description and location", () => {
  const event = mapped(TIMED);
  expect(event.fields.description).toBeNull();
  expect(event.fields.location).toBeNull();
});

it("carries hostile-looking text through unaltered", () => {
  // This layer must NOT sanitise: escaping belongs at render and RFC 5545
  // serialisation belongs in ICS output (§13). Mangling here would corrupt data.
  const nasty = '<script>alert(1)</script> & "quotes"';
  const event = mapped({ ...TIMED, summary: nasty, description: nasty });
  expect(event.fields.title).toBe(nasty);
  expect(event.fields.description).toBe(nasty);
});

// --- malformed input ---

it("rejects an event with no start or end", () => {
  expect(() => mapped({ id: "e", etag: '"e"', summary: "x" })).toThrow(/missing start or end/);
});

it("rejects a bound with neither date nor dateTime", () => {
  expect(() => mapped({ ...TIMED, start: {}, end: {} })).toThrow(/neither date nor dateTime/);
});

it("rejects a malformed dateTime", () => {
  expect(() => mapped({ ...TIMED, start: { dateTime: "13/09/2026 09:00" } })).toThrow(
    /not an RFC 3339 timestamp/,
  );
  // Missing offset entirely — Google always sends one.
  expect(() => mapped({ ...TIMED, start: { dateTime: "2026-09-13T09:00:00" } })).toThrow(
    /not an RFC 3339 timestamp/,
  );
});

it("rejects a malformed all-day date", () => {
  expect(() =>
    mapped({ ...TIMED, start: { date: "2026-9-13" }, end: { date: "2026-09-14" } }),
  ).toThrow(/not a calendar date/);
});

it("requires an id and etag", () => {
  expect(() => googleEventSchema.parse({ etag: '"e"' })).toThrow();
  expect(() => googleEventSchema.parse({ id: "e" })).toThrow();
});
