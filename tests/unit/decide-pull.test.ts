// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { ProjectionRow } from "../../src/db/schema.js";
import type { ProviderEvent } from "../../src/providers/base.js";
import {
  fromCopy,
  type InboundFields,
  mergeInbound,
  OUR_LINE_PREFIX,
} from "../../src/reconcile/conflict.js";
import { decidePull } from "../../src/reconcile/decide.js";
import { fromWhenDoWeLine } from "../../src/reconcile/project.js";

// PULL (DESIGN §11 classify_and_apply, §10 rc53): what one change Google reports is, and how a
// copy's fields read in the event's own terms.

const NOW = "2101-11-19T10:00:00.000Z";
const FIELDS = {
  title: "Pickup",
  description: null,
  location: null,
  startLocal: "2101-11-20T15:00:00",
  endLocal: "2101-11-20T15:30:00",
  tzid: "Europe/Prague",
  allDay: false,
  rrule: null,
  sourceUrl: null,
};

function row(overrides: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    id: "prj-1",
    canonicalEventId: "evt-1",
    calendarConnectionId: "conn-1",
    visibilityProfile: "FULL",
    providerEventId: "g1",
    providerEtag: "e1",
    lastPushedHash: "h1",
    recentWriteNonces: JSON.stringify(["n1", "n2"]),
    baseRevision: 3,
    state: "synced",
    lastError: null,
    retryAt: null,
    unsubscribedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function change(overrides: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    id: "g1",
    etag: "e2",
    fields: FIELDS,
    metadata: { canonicalUid: "evt-1" },
    isDeleted: false,
    recurringEventId: null,
    ...overrides,
  };
}

describe("decidePull", () => {
  it("takes in a real edit: a new etag, an unknown nonce, other fields", () => {
    const incoming = change({ metadata: { canonicalUid: "evt-1", writeNonce: "n0" } });
    expect(decidePull(row(), incoming, "h2")).toEqual({ kind: "apply_inbound", incoming });
  });

  it("recognises our own write read back, by any one of the three layers", () => {
    for (const [incoming, hash] of [
      [change({ metadata: { canonicalUid: "evt-1", writeNonce: "n1" } }), "h2"],
      [change({ etag: "e1" }), "h2"],
      [change(), "h1"],
    ] as const) {
      expect(decidePull(row(), incoming, hash).kind).toBe("suppress_echo");
    }
  });

  it("skips a change to one occurrence of a series, first of all", () => {
    expect(decidePull(null, change({ recurringEventId: "g0" }), "h2")).toEqual({
      kind: "skip_instance",
    });
  });

  it("does nothing for a change to no copy of ours, one given up, or an older copy since replaced", () => {
    expect(decidePull(null, change(), "h2")).toEqual({ kind: "noop" });
    expect(decidePull(row({ unsubscribedAt: NOW }), change(), "h2")).toEqual({ kind: "noop" });
    expect(decidePull(row({ providerEventId: "g9" }), change(), "h2")).toEqual({ kind: "noop" });
  });

  it("a copy deleted in Google is its person unsubscribing, unless we had removed it", () => {
    expect(decidePull(row(), change({ isDeleted: true }), "h2")).toEqual({
      kind: "unsubscribe",
    });
    expect(decidePull(row({ state: "deleted" }), change({ isDeleted: true }), "h2")).toEqual({
      kind: "noop",
    });
  });

  it("a ring that isn't a list of nonces is no ring", () => {
    const incoming = change({ metadata: { canonicalUid: "evt-1", writeNonce: "n1" } });
    expect(decidePull(row({ recentWriteNonces: '{"n1":1}' }), incoming, "h2").kind).toBe(
      "apply_inbound",
    );
  });
});

describe("fromCopy", () => {
  const line = fromWhenDoWeLine("https://whendowe.example/events/evt-1");

  it("takes our line off the description, whatever it says, and keeps what follows", () => {
    expect(line.startsWith(OUR_LINE_PREFIX)).toBe(true);
    expect(fromCopy({ ...FIELDS, description: `${line}\n\nBring the bag` }).description).toBe(
      "Bring the bag",
    );
    expect(fromCopy({ ...FIELDS, description: line }).description).toBeNull();
    expect(
      fromCopy({ ...FIELDS, description: `${OUR_LINE_PREFIX}an older wording.\n\nNotes` })
        .description,
    ).toBe("Notes");
  });

  it("keeps a description that doesn't start with our line, and reads empty text as none", () => {
    expect(fromCopy({ ...FIELDS, description: "Mine\n\nFrom WhenDoWe — x" }).description).toBe(
      "Mine\n\nFrom WhenDoWe — x",
    );
    expect(fromCopy({ ...FIELDS, description: "  ", location: "" })).toMatchObject({
      description: null,
      location: null,
    });
  });

  it("never carries the repeat rule or the link back", () => {
    expect(
      fromCopy({ ...FIELDS, rrule: "FREQ=WEEKLY", sourceUrl: "https://x.example" }),
    ).not.toHaveProperty("rrule");
  });
});

describe("mergeInbound", () => {
  const base: InboundFields = {
    title: "Pickup",
    description: null,
    location: "Gate",
    startLocal: "2101-11-20T15:00:00",
    endLocal: "2101-11-20T15:30:00",
    tzid: "Europe/Prague",
    allDay: false,
  };

  it("one moved the time, the other fixed the place: both stay", () => {
    const merge = mergeInbound({
      base,
      current: { ...base, location: "Side gate" },
      incoming: { ...base, startLocal: "2101-11-20T16:00:00", endLocal: "2101-11-20T16:30:00" },
      visibility: "FULL",
    });
    expect(merge.fields).toMatchObject({
      location: "Side gate",
      startLocal: "2101-11-20T16:00:00",
    });
    expect(merge.applied).toEqual(["time"]);
    expect(merge.replaced).toEqual([]);
  });

  it("time moves as one: Google's start never meets an end set here", () => {
    const merge = mergeInbound({
      base,
      current: { ...base, endLocal: "2101-11-20T17:00:00" },
      incoming: { ...base, startLocal: "2101-11-20T18:00:00", endLocal: "2101-11-20T18:30:00" },
      visibility: "FULL",
    });
    expect(merge.fields).toMatchObject({
      startLocal: "2101-11-20T18:00:00",
      endLocal: "2101-11-20T18:30:00",
    });
    expect(merge.replaced).toEqual(["time"]);
  });

  it("both made the same change: nothing to apply, and no collision", () => {
    const moved = { ...base, location: "Side gate" };
    expect(mergeInbound({ base, current: moved, incoming: moved, visibility: "FULL" })).toEqual({
      fields: moved,
      applied: [],
      replaced: [],
    });
  });

  it("a part the copy doesn't show never comes in: a DETAILS copy's notes, a BUSY copy's title", () => {
    expect(
      mergeInbound({
        base,
        current: base,
        incoming: { ...base, description: "typed in Google" },
        visibility: "DETAILS",
      }).applied,
    ).toEqual([]);
    expect(
      mergeInbound({
        base,
        current: base,
        incoming: { ...base, title: "Busy" },
        visibility: "BUSY",
      }).applied,
    ).toEqual([]);
  });
});
