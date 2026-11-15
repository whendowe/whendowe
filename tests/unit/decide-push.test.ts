// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { ProjectionRow } from "../../src/db/schema.js";
import {
  type DesiredCopy,
  decidePush,
  nextRetryAt,
  RETRY_CAP_MS,
  RETRY_FIRST_MS,
} from "../../src/reconcile/decide.js";

// PUSH's decision (DESIGN §11, §10 rc40): converge each copy to what the feed says, and
// do nothing — no write — when it already matches (§6).

const NOW = "2026-11-16T10:00:00.000Z";
const FIELDS = {
  title: "Pickup",
  description: null,
  location: null,
  startLocal: "2026-11-17T15:00:00",
  endLocal: "2026-11-17T15:30:00",
  tzid: "Europe/Prague",
  allDay: false,
  rrule: null,
  sourceUrl: null,
};
const WANT: DesiredCopy = { fields: FIELDS, hash: "h1" };

function row(overrides: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    id: "prj-1",
    canonicalEventId: "evt-1",
    calendarConnectionId: "conn-1",
    visibilityProfile: "FULL",
    providerEventId: "g1",
    providerEtag: "e1",
    lastPushedHash: "h1",
    recentWriteNonces: "[]",
    baseRevision: 1,
    state: "synced",
    lastError: null,
    retryAt: null,
    unsubscribedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("decidePush", () => {
  it("does nothing for a synced copy that matches: the steady state", () => {
    expect(decidePush(WANT, row(), NOW)).toEqual({ kind: "noop" });
  });

  it("makes a copy that should exist and never has", () => {
    expect(decidePush(WANT, null, NOW)).toEqual({ kind: "create_mirror", fields: FIELDS });
  });

  it("does nothing for an event that shouldn't be there and never was", () => {
    expect(decidePush(null, null, NOW)).toEqual({ kind: "noop" });
  });

  it("pushes a copy whose fields changed, to the copy it has", () => {
    expect(decidePush({ ...WANT, hash: "h2" }, row(), NOW)).toEqual({
      kind: "push",
      providerEventId: "g1",
      fields: FIELDS,
    });
  });

  it.each([
    "pending_update",
    "pending_create",
    "error",
  ])("pushes a %s copy even when the hash matches", (state) => {
    expect(decidePush(WANT, row({ state }), NOW)).toEqual({
      kind: "push",
      providerEventId: "g1",
      fields: FIELDS,
    });
  });

  it("removes a copy of an event that shouldn't be there any more", () => {
    expect(decidePush(null, row(), NOW)).toEqual({ kind: "delete_mirror", providerEventId: "g1" });
    expect(decidePush(null, row({ state: "error" }), NOW)).toEqual({
      kind: "delete_mirror",
      providerEventId: "g1",
    });
  });

  it("does nothing more once a copy is removed, and makes it again if the event returns", () => {
    const removed = row({ state: "deleted" });
    expect(decidePush(null, removed, NOW)).toEqual({ kind: "noop" });
    expect(decidePush(WANT, removed, NOW)).toEqual({ kind: "create_mirror", fields: FIELDS });
  });

  it("makes a copy when a row has none yet", () => {
    expect(decidePush(WANT, row({ providerEventId: null, state: "error" }), NOW)).toEqual({
      kind: "create_mirror",
      fields: FIELDS,
    });
    expect(decidePush(null, row({ providerEventId: null, state: "error" }), NOW)).toEqual({
      kind: "noop",
    });
  });

  it("never puts back or touches a copy deleted in the provider (rc40)", () => {
    for (const state of ["deleted", "synced", "error"]) {
      const gone = row({ state, unsubscribedAt: NOW });
      expect(decidePush({ ...WANT, hash: "h2" }, gone, NOW)).toEqual({ kind: "noop" });
      expect(decidePush(null, gone, NOW)).toEqual({ kind: "noop" });
    }
  });

  it("waits for an errored copy's retry time, and tries again at it (§12)", () => {
    const later = "2026-11-16T10:01:00.000Z";
    expect(decidePush(WANT, row({ state: "error", retryAt: later }), NOW)).toEqual({
      kind: "noop",
    });
    expect(decidePush(null, row({ state: "error", retryAt: later }), NOW)).toEqual({
      kind: "noop",
    });
    expect(decidePush(WANT, row({ state: "error", retryAt: NOW }), NOW).kind).toBe("push");
  });

  it("ignores a retry time on a row that isn't in error", () => {
    const later = "2026-11-16T10:01:00.000Z";
    expect(decidePush({ ...WANT, hash: "h2" }, row({ retryAt: later }), NOW).kind).toBe("push");
  });

  it("is idempotent: once its push is recorded, the same copy decides nothing", () => {
    const cases: Array<[DesiredCopy | null, ProjectionRow | null]> = [
      [WANT, null],
      [{ ...WANT, hash: "h2" }, row()],
      [WANT, row({ state: "error" })],
      [WANT, row({ state: "deleted" })],
    ];
    for (const [want, before] of cases) {
      expect(decidePush(want, before, NOW).kind).not.toBe("noop");
      const after = row({ state: "synced", lastPushedHash: want?.hash ?? null });
      expect(decidePush(want, after, NOW)).toEqual({ kind: "noop" });
    }
  });
});

describe("nextRetryAt — capped backoff from the row itself (§12)", () => {
  const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
  const failed = (wait: number) => row({ state: "error", updatedAt: at(-wait), retryAt: at(0) });

  it("waits a minute after a first failure", () => {
    expect(nextRetryAt(NOW, null)).toBe(at(RETRY_FIRST_MS));
    expect(nextRetryAt(NOW, row())).toBe(at(RETRY_FIRST_MS));
    expect(nextRetryAt(NOW, row({ state: "error", retryAt: null }))).toBe(at(RETRY_FIRST_MS));
  });

  it("doubles the last wait", () => {
    expect(nextRetryAt(NOW, failed(RETRY_FIRST_MS))).toBe(at(2 * RETRY_FIRST_MS));
    expect(nextRetryAt(NOW, failed(8 * RETRY_FIRST_MS))).toBe(at(16 * RETRY_FIRST_MS));
  });

  it("never waits more than an hour", () => {
    expect(RETRY_CAP_MS).toBe(60 * 60_000);
    expect(nextRetryAt(NOW, failed(40 * 60_000))).toBe(at(RETRY_CAP_MS));
    expect(nextRetryAt(NOW, failed(RETRY_CAP_MS))).toBe(at(RETRY_CAP_MS));
  });

  it("starts over from a minute when the stored times make no sense", () => {
    expect(nextRetryAt(NOW, row({ state: "error", updatedAt: at(0), retryAt: at(0) }))).toBe(
      at(RETRY_FIRST_MS),
    );
    expect(nextRetryAt(NOW, row({ state: "error", updatedAt: at(5), retryAt: at(0) }))).toBe(
      at(RETRY_FIRST_MS),
    );
  });

  it("ignores a retry time left on a row that isn't in error", () => {
    expect(nextRetryAt(NOW, row({ updatedAt: at(-RETRY_CAP_MS), retryAt: at(0) }))).toBe(
      at(RETRY_FIRST_MS),
    );
  });
});
