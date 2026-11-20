// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  CalendarProvider,
  ChangeBatch,
  Channel,
  EventFields,
  ProviderEvent,
  ProviderMetadata,
  UpsertResult,
} from "./base.js";
import { ProviderEventGoneError, SyncTokenExpiredError } from "./base.js";

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

  listChanges(syncToken: string | null): Promise<ChangeBatch> {
    if (this.expireNext) {
      this.expireNext = false;
      return Promise.reject(new SyncTokenExpiredError());
    }
    // A full listing (null cursor) is everything there; otherwise what changed since.
    const changes =
      syncToken === null ? [...this.events.values()].map((e) => e.event) : [...this.outbox];
    this.outbox.length = 0;
    // The cursor moves only when something changed, so a quiet read is visibly quiet.
    if (changes.length > 0 || syncToken === null) this.syncCounter += 1;
    return Promise.resolve({ changes, nextSyncToken: `sync-${this.syncCounter}` });
  }

  /** Test hook: the next read finds its cursor expired (410, §12). */
  expireNext = false;

  upsert(
    providerEventId: string | null,
    fields: EventFields,
    metadata: ProviderMetadata,
  ): Promise<UpsertResult> {
    if (providerEventId !== null && this.events.get(providerEventId)?.deleted !== false) {
      return Promise.reject(new ProviderEventGoneError()); // never revived (§10 rc40)
    }
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

  /**
   * Test hook: a person edits the event in the provider's own app (rc53). As Google does, the
   * hidden metadata — the canonical id and the nonce of our last write — is kept, and the etag
   * changes. `recurringEventId` set makes it an edit to one occurrence of a series.
   */
  editByPerson(
    providerEventId: string,
    fields: Partial<EventFields>,
    recurringEventId: string | null = null,
  ): void {
    const stored = this.events.get(providerEventId);
    if (stored === undefined || stored.deleted) throw new Error("no such event to edit");
    const event: ProviderEvent = {
      ...stored.event,
      etag: `etag-${++this.etagCounter}`,
      fields: { ...stored.event.fields, ...fields },
      recurringEventId,
    };
    this.events.set(providerEventId, { event, deleted: false });
    this.outbox.push(event);
  }

  /** Test hook: what the provider holds for an event now. */
  holds(providerEventId: string): ProviderEvent | null {
    return this.events.get(providerEventId)?.event ?? null;
  }

  /** Test hook: the channels made and not stopped, by id (rc53 push). */
  readonly channels = new Map<string, { token: string; address: string; resourceId: string }>();
  /** Test hook: the next watch fails. */
  failWatch: Error | null = null;
  private resourceCounter = 0;

  watch(input: {
    readonly id: string;
    readonly token: string;
    readonly address: string;
    readonly ttlSeconds: number;
  }): Promise<Channel> {
    if (this.failWatch !== null) {
      const error = this.failWatch;
      this.failWatch = null;
      return Promise.reject(error);
    }
    const resourceId = `resource-${++this.resourceCounter}`;
    this.channels.set(input.id, { token: input.token, address: input.address, resourceId });
    // The fake's clock is the caller's: expiry is reported relative to now by the test.
    return Promise.resolve({
      resourceId,
      expiresAt: new Date(this.now() + input.ttlSeconds * 1000).toISOString(),
    });
  }

  stopWatch(input: { readonly id: string; readonly resourceId: string }): Promise<void> {
    if (this.channels.get(input.id)?.resourceId === input.resourceId)
      this.channels.delete(input.id);
    return Promise.resolve();
  }

  /** The clock channel expiries are counted from; a test sets it to its own. */
  now: () => number = () => Date.now();

  /** Test hook: number of undelivered change notifications. */
  pendingNotifications(): number {
    return this.outbox.length;
  }
}
