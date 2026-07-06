// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  CalendarProvider,
  ChangeBatch,
  EventFields,
  ProviderEvent,
  ProviderMetadata,
  UpsertResult,
} from "./base.js";

// Google Calendar via plain REST fetch — no SDK (DESIGN.md §6). Identity and
// write-nonces live in extendedProperties.private (§12). Implemented in M1.
export class GoogleCalendarProvider implements CalendarProvider {
  listChanges(_syncToken: string | null): Promise<ChangeBatch> {
    return Promise.reject(new Error("GoogleCalendarProvider lands in M1 (DESIGN.md §15)"));
  }

  upsert(
    _providerEventId: string | null,
    _fields: EventFields,
    _metadata: ProviderMetadata,
  ): Promise<UpsertResult> {
    return Promise.reject(new Error("GoogleCalendarProvider lands in M1 (DESIGN.md §15)"));
  }

  delete(_providerEventId: string): Promise<void> {
    return Promise.reject(new Error("GoogleCalendarProvider lands in M1 (DESIGN.md §15)"));
  }

  findByMetadata(_canonicalUid: string): Promise<ProviderEvent | null> {
    return Promise.reject(new Error("GoogleCalendarProvider lands in M1 (DESIGN.md §15)"));
  }
}
