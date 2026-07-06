// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  CalendarProvider,
  ChangeBatch,
  EventFields,
  ProviderEvent,
  ProviderMetadata,
  UpsertResult,
} from "./base.js";

// In-memory fake provider (DESIGN.md §9): all reconcile/property tests run against
// this, never the real Google API. Change notifications go into an explicit outbox
// that tests drain on command — later, reordered, or duplicated. The full
// fault-injecting simulator (crash hooks at every effect boundary, injected clock)
// is M2 scope; the storage model and outbox shape are laid down here so the M2
// upgrade adds hooks, not rewrites.

interface StoredEvent {
  event: ProviderEvent;
  deleted: boolean;
}

export class FakeCalendarProvider implements CalendarProvider {
  private readonly events = new Map<string, StoredEvent>();
  private readonly outbox: ProviderEvent[] = [];
  private idCounter = 0;
  private etagCounter = 0;
  private syncCounter = 0;

  listChanges(_syncToken: string | null): Promise<ChangeBatch> {
    const changes = [...this.outbox];
    this.outbox.length = 0;
    this.syncCounter += 1;
    return Promise.resolve({ changes, nextSyncToken: `sync-${this.syncCounter}` });
  }

  upsert(
    providerEventId: string | null,
    fields: EventFields,
    metadata: ProviderMetadata,
  ): Promise<UpsertResult> {
    const id = providerEventId ?? `fake-${++this.idCounter}`;
    const etag = `etag-${++this.etagCounter}`;
    const event: ProviderEvent = {
      id,
      etag,
      fields,
      metadata,
      isDeleted: false,
      recurringEventId: null,
    };
    this.events.set(id, { event, deleted: false });
    this.outbox.push(event);
    return Promise.resolve({ id, etag });
  }

  delete(providerEventId: string): Promise<void> {
    const stored = this.events.get(providerEventId);
    if (stored === undefined || stored.deleted) {
      return Promise.resolve(); // already gone counts as success (§11)
    }
    stored.deleted = true;
    const tombstone: ProviderEvent = { ...stored.event, isDeleted: true };
    this.events.set(providerEventId, { event: tombstone, deleted: true });
    this.outbox.push(tombstone);
    return Promise.resolve();
  }

  findByMetadata(canonicalUid: string): Promise<ProviderEvent | null> {
    for (const { event, deleted } of this.events.values()) {
      if (!deleted && event.metadata.canonicalUid === canonicalUid) {
        return Promise.resolve(event);
      }
    }
    return Promise.resolve(null);
  }

  /** Test hook: number of undelivered change notifications. */
  pendingNotifications(): number {
    return this.outbox.length;
  }
}
