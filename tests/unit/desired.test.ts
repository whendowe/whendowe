// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { CanonicalEventRow, ProjectionRow } from "../../src/db/schema.js";
import type { FeedEntry } from "../../src/feeds/ics.js";
import { desired } from "../../src/reconcile/desired.js";
import {
  fieldsHash,
  fromWhenDoWeLine,
  project,
  projectEntry,
} from "../../src/reconcile/project.js";

const NOW = "2026-07-07T00:00:00Z";

function event(overrides: Partial<CanonicalEventRow> = {}): CanonicalEventRow {
  return {
    id: "evt-1",
    revision: 1,
    origin: "user_edit",
    ownerId: "owner-1",
    title: "School pickup",
    description: null,
    location: null,
    startLocal: "2026-07-07T15:00:00",
    endLocal: "2026-07-07T15:30:00",
    tzid: "Europe/Prague",
    allDay: 0,
    rrule: null,
    exdates: "[]",
    status: "scheduled", // the M0 value "active" means "scheduled" since DESIGN rc11
    groupId: null,
    createdAt: NOW,
    updatedAt: NOW,
    retainDays: 365,
    verifiedAt: null,
    ...overrides,
  };
}

function projectionRow(overrides: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    id: "prj-1",
    canonicalEventId: "evt-1",
    calendarConnectionId: "conn-1",
    visibilityProfile: "FULL",
    providerEventId: null,
    providerEtag: null,
    lastPushedHash: null,
    recentWriteNonces: "[]",
    baseRevision: null,
    state: "pending_create",
    lastError: null,
    retryAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("desired() — the §10 deletion-model policy", () => {
  it("an active event on a live projection is Present with FULL fields", () => {
    const result = desired(event(), projectionRow());
    expect(result).toEqual({ kind: "present", fields: project(event(), "FULL") });
  });

  it("only a scheduled event projects: every other lifecycle state is Absent (WORKFLOWS §9)", () => {
    // An open poll must not land in anyone's calendar at its placeholder time.
    for (const status of ["draft", "proposed", "declined", "withdrawn", "cancelled"]) {
      expect(desired(event({ status }), projectionRow())).toEqual({ kind: "absent" });
    }
    expect(desired(event({ status: "scheduled" }), projectionRow()).kind).toBe("present");
  });

  it("a cancelled event is Absent (default policy: instant vanish)", () => {
    expect(desired(event({ status: "cancelled" }), projectionRow())).toEqual({ kind: "absent" });
  });

  it("an unsubscribed projection is Absent — without touching the canonical event", () => {
    expect(desired(event(), projectionRow({ state: "pending_delete" }))).toEqual({
      kind: "absent",
    });
    expect(desired(event(), projectionRow({ state: "deleted" }))).toEqual({ kind: "absent" });
  });

  it("rejects an unknown visibility profile loudly (zod at the storage boundary)", () => {
    expect(() => desired(event(), projectionRow({ visibilityProfile: "PUBLIC" }))).toThrow();
  });
});

describe("project() — FULL is identity on the provider fieldset (§5 seam)", () => {
  it("maps the §10 row onto provider fields", () => {
    expect(project(event(), "FULL")).toEqual({
      title: "School pickup",
      description: null,
      location: null,
      startLocal: "2026-07-07T15:00:00",
      endLocal: "2026-07-07T15:30:00",
      tzid: "Europe/Prague",
      allDay: false,
      rrule: null,
      sourceUrl: null,
    });
  });
});

describe("projectEntry() — a copy in a calendar shows what the feed shows (§10 rc40)", () => {
  const LINK = "https://when.example/events/evt-1";
  const entry = (overrides: Partial<FeedEntry> = {}): FeedEntry => ({
    id: "evt-1",
    revision: 3,
    updatedAt: NOW,
    status: "scheduled",
    visibility: "DETAILS",
    title: "School pickup",
    description: "Bring the bike",
    location: "Main gate",
    allDay: false,
    startLocal: "2026-07-07T15:00:00",
    endLocal: "2026-07-07T15:30:00",
    tzid: "Europe/Prague",
    rrule: "FREQ=WEEKLY;BYDAY=TU",
    url: LINK,
    ...overrides,
  });
  const times = {
    startLocal: "2026-07-07T15:00:00",
    endLocal: "2026-07-07T15:30:00",
    tzid: "Europe/Prague",
    allDay: false,
    rrule: "FREQ=WEEKLY;BYDAY=TU",
  };

  it("begins the description with where to change it, then the event's own notes", () => {
    expect(projectEntry(entry())).toEqual({
      title: "School pickup",
      description: `From WhenDoWe — change it there: ${LINK}. Edits made here in Google aren't kept yet.\n\nBring the bike`,
      location: "Main gate",
      ...times,
      sourceUrl: LINK,
    });
  });

  it("is only the line when the event has no notes", () => {
    expect(projectEntry(entry({ description: null })).description).toBe(fromWhenDoWeLine(LINK));
  });

  it("is Busy at BUSY: no place, notes or link, and the same times", () => {
    expect(projectEntry(entry({ visibility: "BUSY", url: null }))).toEqual({
      title: "Busy",
      description: null,
      location: null,
      ...times,
      sourceUrl: null,
    });
  });

  it("never names a BUSY event, whatever the entry carries", () => {
    const copy = projectEntry(entry({ visibility: "BUSY" }));
    expect(JSON.stringify(copy)).not.toContain("School pickup");
    expect(JSON.stringify(copy)).not.toContain(LINK);
  });

  it("is Busy when there is no link to give", () => {
    expect(projectEntry(entry({ url: null })).title).toBe("Busy");
  });
});

describe("fieldsHash() — the push hash is over the fields sent (§11)", () => {
  const base = projectEntry({
    id: "evt-1",
    revision: 1,
    updatedAt: NOW,
    status: "scheduled",
    visibility: "DETAILS",
    title: "Pickup",
    description: null,
    location: null,
    allDay: false,
    startLocal: "2026-07-07T15:00:00",
    endLocal: "2026-07-07T15:30:00",
    tzid: "Europe/Prague",
    rrule: null,
    url: "https://when.example/events/evt-1",
  });

  it("is the same for the same fields", async () => {
    expect(await fieldsHash(base)).toBe(await fieldsHash({ ...base }));
  });

  it("changes when any one field changes", async () => {
    const changed = [
      { ...base, title: "Pickup!" },
      { ...base, description: "x" },
      { ...base, location: "x" },
      { ...base, startLocal: "2026-07-07T15:05:00" },
      { ...base, endLocal: "2026-07-07T15:35:00" },
      { ...base, tzid: "UTC" },
      { ...base, allDay: true },
      { ...base, rrule: "FREQ=DAILY" },
      { ...base, sourceUrl: null },
    ];
    const hashes = new Set(await Promise.all([base, ...changed].map(fieldsHash)));
    expect(hashes.size).toBe(changed.length + 1);
  });

  it("tells a null from the text null", async () => {
    expect(await fieldsHash({ ...base, location: null })).not.toBe(
      await fieldsHash({ ...base, location: "null" }),
    );
  });
});
