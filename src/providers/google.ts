// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { defaultFetch, type FetchLike, HttpError, requestJson } from "../oauth/http.js";
import {
  type CalendarProvider,
  type ChangeBatch,
  type EventFields,
  type ProviderEvent,
  type ProviderMetadata,
  SyncTokenExpiredError,
  type UpsertResult,
} from "./base.js";
import { googleEventSchema, toProviderEvent } from "./google-event.js";

// Google Calendar via plain REST fetch — no SDK (DESIGN.md §6). Identity and
// write-nonces live in extendedProperties.private (§12).
//
// M1 implements the READ side: listChanges. The write side (upsert/delete/
// findByMetadata) is M2's PUSH path and still rejects.

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/** Google's cap is 2500; 250 keeps any single response small and predictable. */
const DEFAULT_PAGE_SIZE = 250;

/** Guard against an upstream that keeps handing back page tokens forever. */
const MAX_PAGES = 200;

const eventsListSchema = z.object({
  items: z.array(googleEventSchema).nullish(),
  nextPageToken: z.string().nullish(),
  /** Present only on the LAST page of a listing. */
  nextSyncToken: z.string().nullish(),
});

export interface GoogleCalendarProviderOptions {
  /** The provider-side calendar id, e.g. the account's primary calendar. */
  readonly calendarId: string;
  /**
   * Resolved per call rather than held as a string, so token refresh can slot in
   * behind it in M2 without touching this class.
   */
  readonly getAccessToken: () => Promise<string>;
  readonly fetchImpl?: FetchLike;
  readonly pageSize?: number;
}

export class GoogleCalendarProvider implements CalendarProvider {
  private readonly options: GoogleCalendarProviderOptions;

  constructor(options: GoogleCalendarProviderOptions) {
    this.options = options;
  }

  /**
   * Incremental changes since `syncToken`; a null cursor means a full listing.
   *
   * Throws SyncTokenExpiredError on 410 GONE so the caller runs §12's full-resync
   * path — which is more than "replay everything": deletions that happened while
   * the cursor was dead never appear as changes, so the caller must also diff the
   * other direction. That reverse diff is the caller's job, not this method's.
   *
   * `singleEvents=false` on purpose: the MVP syncs whole series, never expanded
   * instances (§16). Masters arrive with their RRULE; modified or cancelled
   * instances arrive with recurringEventId set, for the caller to skip.
   *
   * Request parameters are deliberately identical across full and incremental
   * calls. Google invalidates a sync token if the filters change between syncs,
   * and the time-window filters cannot be combined with a syncToken at all —
   * which is also why no timeMin is applied.
   */
  async listChanges(syncToken: string | null): Promise<ChangeBatch> {
    const accessToken = await this.options.getAccessToken();
    const pageSize = this.options.pageSize ?? DEFAULT_PAGE_SIZE;
    const fetchImpl = this.options.fetchImpl ?? defaultFetch;

    const changes: ProviderEvent[] = [];
    let pageToken: string | null = null;
    let nextSyncToken: string | null = null;
    let reachedLastPage = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(
        `${CALENDAR_API_BASE}/${encodeURIComponent(this.options.calendarId)}/events`,
      );
      url.searchParams.set("showDeleted", "true");
      url.searchParams.set("singleEvents", "false");
      url.searchParams.set("maxResults", String(pageSize));
      if (syncToken !== null) {
        url.searchParams.set("syncToken", syncToken);
      }
      if (pageToken !== null) {
        url.searchParams.set("pageToken", pageToken);
      }

      let response: z.infer<typeof eventsListSchema>;
      try {
        response = await requestJson(
          fetchImpl,
          url.toString(),
          {
            method: "GET",
            headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
          },
          eventsListSchema,
          "calendar events list",
        );
      } catch (error) {
        // 410 GONE is protocol, not failure: the cursor expired (§12).
        if (error instanceof HttpError && error.status === 410) {
          throw new SyncTokenExpiredError();
        }
        throw error;
      }

      for (const item of response.items ?? []) {
        changes.push(toProviderEvent(item));
      }

      if (response.nextPageToken !== null && response.nextPageToken !== undefined) {
        pageToken = response.nextPageToken;
        continue;
      }

      nextSyncToken = response.nextSyncToken ?? null;
      reachedLastPage = true;
      break;
    }

    if (!reachedLastPage) {
      // Distinct from the missing-cursor case below: conflating them would blame a
      // missing sync token for what is actually runaway pagination.
      throw new Error(`calendar events list exceeded ${MAX_PAGES} pages`);
    }

    if (nextSyncToken === null) {
      // Without a cursor the next tick would re-list everything, silently turning
      // the steady-state zero-write path (§6/§16) into a full scan every minute.
      throw new Error("calendar events list finished without a nextSyncToken");
    }

    return { changes, nextSyncToken };
  }

  upsert(
    _providerEventId: string | null,
    _fields: EventFields,
    _metadata: ProviderMetadata,
  ): Promise<UpsertResult> {
    return Promise.reject(new Error("GoogleCalendarProvider.upsert lands in M2 (DESIGN.md §15)"));
  }

  delete(_providerEventId: string): Promise<void> {
    return Promise.reject(new Error("GoogleCalendarProvider.delete lands in M2 (DESIGN.md §15)"));
  }

  findByMetadata(_canonicalUid: string): Promise<ProviderEvent | null> {
    return Promise.reject(
      new Error("GoogleCalendarProvider.findByMetadata lands in M2 (DESIGN.md §15)"),
    );
  }
}
