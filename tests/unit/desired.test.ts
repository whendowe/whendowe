// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { CanonicalEventRow, ProjectionRow } from "../../src/db/schema.js";
import { desired } from "../../src/reconcile/desired.js";
import { project } from "../../src/reconcile/project.js";

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
    });
  });
});
