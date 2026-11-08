// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { defaultFetch, type FetchLike, HttpError, requestJson } from "./http.js";

// Identify the account a fresh connection belongs to (DESIGN.md §10:
// calendar_connection.account_email / calendar_id are both NOT NULL).
//
// Why this call rather than an `email` scope: reading the account's email from an
// id_token would mean requesting `openid email` on top of the calendar scopes,
// which §13's least-scope rule and §12's scope list both argue against. The
// primary calendar entry carries the identity we need and is already covered by
// `calendar.calendarlist.readonly`, one of the three scopes we hold (rc40).
//
// rc40 also lists the calendars a person may choose from, checks the one they chose,
// and makes a new WhenDoWe calendar (`calendar.app.created`).
//
// HONEST CAVEAT: for a normal Google account the primary calendar's `id` IS the
// account's email address, and that is what this is used for. Google's reference
// documents `id` only as "Identifier of the calendar" and stops short of
// guaranteeing the equality, so treat it as the provider's account identifier
// that happens to be an email in practice. If a future account type returns
// something else, we will have stored a non-email in account_email — wrong-looking
// but still the correct identity for the column's purpose (telling connections
// apart and showing the user which account they linked). The authoritative fix
// would be requesting the `email` scope, which is a design-deviation decision.

export const GOOGLE_PRIMARY_CALENDAR_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary";

// `nullish`, not `optional`: an external API may express "no value" as either an
// omitted key or an explicit null, and only `id` is load-bearing enough to require.
// Being strict about the difference would fail a connect over a cosmetic field.
const primaryCalendarSchema = z.object({
  id: z.string().min(1),
  summary: z.string().nullish(),
  timeZone: z.string().nullish(),
  accessRole: z.string().nullish(),
});

export interface PrimaryCalendar {
  /** The calendar id — also the account identifier. See the caveat above. */
  readonly id: string;
  readonly summary: string | null;
  /** IANA zone, e.g. "Europe/Prague". Null if Google omitted it. */
  readonly timeZone: string | null;
  readonly accessRole: string | null;
}

export async function fetchPrimaryCalendar(
  accessToken: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<PrimaryCalendar> {
  const response = await requestJson(
    fetchImpl,
    GOOGLE_PRIMARY_CALENDAR_URL,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    },
    primaryCalendarSchema,
    "primary calendar lookup",
  );

  return {
    id: response.id,
    summary: response.summary ?? null,
    timeZone: response.timeZone ?? null,
    accessRole: response.accessRole ?? null,
  };
}

export const GOOGLE_CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
export const GOOGLE_CALENDARS_URL = "https://www.googleapis.com/calendar/v3/calendars";

/** Roles that may add events (rc40): the only calendars worth offering. */
const WRITABLE = new Set(["owner", "writer"]);

/** Pages of 250 read at most: 1,000 calendars is past anyone's list. */
const MAX_PAGES = 4;

const listEntrySchema = z.object({
  id: z.string().min(1),
  summary: z.string().nullish(),
  summaryOverride: z.string().nullish(),
  primary: z.boolean().nullish(),
  accessRole: z.string().nullish(),
});

const listPageSchema = z.object({
  items: z.array(listEntrySchema).nullish(),
  nextPageToken: z.string().nullish(),
});

const createdSchema = z.object({ id: z.string().min(1) });

/** A calendar someone may choose (rc40). Its name is what they typed: untrusted. */
export interface CalendarChoice {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
}

function choiceOf(entry: z.infer<typeof listEntrySchema>): CalendarChoice {
  return {
    id: entry.id,
    // The name they gave it in their own list, else its own name.
    name: entry.summaryOverride ?? entry.summary ?? entry.id,
    primary: entry.primary === true,
  };
}

function bearer(accessToken: string) {
  return { authorization: `Bearer ${accessToken}`, accept: "application/json" };
}

/** The calendars this account may add events to, its main calendar first. */
export async function listWritableCalendars(
  accessToken: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CalendarChoice[]> {
  const found: CalendarChoice[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(GOOGLE_CALENDAR_LIST_URL);
    url.searchParams.set("minAccessRole", "writer");
    url.searchParams.set("maxResults", "250");
    if (pageToken !== null) url.searchParams.set("pageToken", pageToken);
    const body = await requestJson(
      fetchImpl,
      url.toString(),
      { method: "GET", headers: bearer(accessToken) },
      listPageSchema,
      "calendar list",
    );
    for (const entry of body.items ?? []) {
      // minAccessRole already filters; checked again, since the list is Google's word.
      if (WRITABLE.has(entry.accessRole ?? "")) found.push(choiceOf(entry));
    }
    pageToken = body.nextPageToken ?? null;
    if (pageToken === null) break;
  }
  return [...found.filter((c) => c.primary), ...found.filter((c) => !c.primary)];
}

/**
 * The chosen calendar, if this account may still add events to it, else null. The
 * id came back from a form, so it is checked with Google, not trusted (rc40).
 */
export async function findWritableCalendar(
  accessToken: string,
  calendarId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CalendarChoice | null> {
  try {
    const entry = await requestJson(
      fetchImpl,
      `${GOOGLE_CALENDAR_LIST_URL}/${encodeURIComponent(calendarId)}`,
      { method: "GET", headers: bearer(accessToken) },
      listEntrySchema,
      "calendar lookup",
    );
    return WRITABLE.has(entry.accessRole ?? "") ? choiceOf(entry) : null;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

/** Make a new calendar in this account (rc40's default); returns its id. */
export async function createCalendar(
  accessToken: string,
  calendar: { readonly summary: string; readonly timeZone: string | null },
  fetchImpl: FetchLike = defaultFetch,
): Promise<string> {
  const created = await requestJson(
    fetchImpl,
    GOOGLE_CALENDARS_URL,
    {
      method: "POST",
      headers: { ...bearer(accessToken), "content-type": "application/json" },
      body: JSON.stringify({
        summary: calendar.summary,
        ...(calendar.timeZone === null ? {} : { timeZone: calendar.timeZone }),
      }),
    },
    createdSchema,
    "calendar create",
  );
  return created.id;
}
