// SPDX-License-Identifier: AGPL-3.0-or-later

// The CalendarProvider port (DESIGN.md §5): GoogleCalendarProvider is the only real
// implementation in MVP; CalDAV/Graph arrive behind this same interface. The fake
// provider (fake.ts) implements it in memory for all reconcile/property tests.

/** The provider-facing fieldset — output of project(event, profile) (§11 PUSH). */
export interface EventFields {
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly startLocal: string; // RFC 5545 wall-clock, zone-less
  readonly endLocal: string;
  readonly tzid: string | null;
  readonly allDay: boolean;
  readonly rrule: string | null;
}

/** Identity metadata stamped into provider-side hidden storage (§3.4, §12). */
export interface ProviderMetadata {
  readonly canonicalUid: string;
  readonly writeNonce?: string;
}

export interface ProviderEvent {
  readonly id: string;
  readonly etag: string;
  readonly fields: EventFields;
  readonly metadata: Partial<ProviderMetadata>;
  readonly isDeleted: boolean;
  /** Non-null when this is an INSTANCE of a recurring series (§11: skipped in MVP). */
  readonly recurringEventId: string | null;
}

export interface ChangeBatch {
  readonly changes: readonly ProviderEvent[];
  readonly nextSyncToken: string;
}

export interface UpsertResult {
  readonly id: string;
  readonly etag: string;
}

/** Thrown by listChanges when the incremental cursor has expired → full resync (§12). */
export class SyncTokenExpiredError extends Error {
  constructor() {
    super("sync token expired; full resync required");
    this.name = "SyncTokenExpiredError";
  }
}

export interface CalendarProvider {
  /** Incremental changes since syncToken; null cursor means full sync. */
  listChanges(syncToken: string | null): Promise<ChangeBatch>;
  /** Create (id null) or update a provider event. Metadata rides along on every write. */
  upsert(
    providerEventId: string | null,
    fields: EventFields,
    metadata: ProviderMetadata,
  ): Promise<UpsertResult>;
  /** Delete a provider event. 404/410 (already gone) counts as success (§11). */
  delete(providerEventId: string): Promise<void>;
  /** Lookup by explicit identity metadata — the duplicate-create recovery path (§11). */
  findByMetadata(canonicalUid: string): Promise<ProviderEvent | null>;
}
