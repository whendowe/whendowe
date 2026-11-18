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

/** Every entry of the account's calendar list with at least this role, page by page. */
async function listEntries(
  accessToken: string,
  minAccessRole: "writer" | "freeBusyReader",
  fetchImpl: FetchLike,
): Promise<z.infer<typeof listEntrySchema>[]> {
  const found: z.infer<typeof listEntrySchema>[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(GOOGLE_CALENDAR_LIST_URL);
    url.searchParams.set("minAccessRole", minAccessRole);
    url.searchParams.set("maxResults", "250");
    if (pageToken !== null) url.searchParams.set("pageToken", pageToken);
    const body = await requestJson(
      fetchImpl,
      url.toString(),
      { method: "GET", headers: bearer(accessToken) },
      listPageSchema,
      "calendar list",
    );
    found.push(...(body.items ?? []));
    pageToken = body.nextPageToken ?? null;
    if (pageToken === null) break;
  }
  return found;
}

function mainFirst<T extends { readonly primary: boolean }>(list: readonly T[]): T[] {
  return [...list.filter((c) => c.primary), ...list.filter((c) => !c.primary)];
}

/** The calendars this account may add events to, its main calendar first. */
export async function listWritableCalendars(
  accessToken: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CalendarChoice[]> {
  const entries = await listEntries(accessToken, "writer", fetchImpl);
  // minAccessRole already filters; checked again, since the list is Google's word.
  return mainFirst(entries.filter((e) => WRITABLE.has(e.accessRole ?? "")).map(choiceOf));
}

/** A calendar whose busy times may count (rc41); `owned` is ticked by default. */
export interface BusyChoice extends CalendarChoice {
  readonly owned: boolean;
}

/**
 * Every calendar in the account's list whose busy times can be read, its main calendar
 * first (rc41): the ones it owns, and the ones it only subscribes to (holidays, a team's).
 */
export async function listBusyCalendars(
  accessToken: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<BusyChoice[]> {
  const entries = await listEntries(accessToken, "freeBusyReader", fetchImpl);
  return mainFirst(entries.map((e) => ({ ...choiceOf(e), owned: e.accessRole === "owner" })));
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

/**
 * Delete a calendar WhenDoWe made (rc40 disconnect, "Delete the WhenDoWe calendar"), and every
 * event in it with it. `calendar.app.created` allows this only for calendars the app made. One
 * already gone is deleted already.
 */
export async function deleteCalendar(
  accessToken: string,
  calendarId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<void> {
  const response = await fetchImpl(`${GOOGLE_CALENDARS_URL}/${encodeURIComponent(calendarId)}`, {
    method: "DELETE",
    headers: bearer(accessToken),
  });
  if (response.ok || response.status === 404 || response.status === 410) return;
  throw new HttpError(response.status, "calendar delete", "not deleted");
}

export const GOOGLE_FREEBUSY_URL ="https://www.googleapis.com/calendar/v3/freeBusy";

const freeBusySchema = z.object({
  calendars: z
    .record(
      z.string(),
      z.object({
        busy: z.array(z.object({ start: z.string(), end: z.string() })).nullish(),
        errors: z.array(z.unknown()).nullish(),
      }),
    )
    .nullish(),
});

/** A busy span as Google sends it: two RFC 3339 times, and nothing about what it is. */
export interface BusySpan {
  readonly start: string;
  readonly end: string;
}

/**
 * When these calendars are busy between two instants (rc41), through `calendar.freebusy`:
 * Google answers with times only — no title, place or attendees — and leaves out events
 * marked free and invitations declined. A calendar Google can't read (gone, or no longer
 * shared) is skipped rather than failing the rest.
 */
export async function fetchFreeBusy(
  accessToken: string,
  query: { readonly timeMin: string; readonly timeMax: string; readonly ids: readonly string[] },
  fetchImpl: FetchLike = defaultFetch,
): Promise<BusySpan[]> {
  if (query.ids.length === 0) return [];
  const body = await requestJson(
    fetchImpl,
    GOOGLE_FREEBUSY_URL,
    {
      method: "POST",
      headers: { ...bearer(accessToken), "content-type": "application/json" },
      body: JSON.stringify({
        timeMin: query.timeMin,
        timeMax: query.timeMax,
        items: query.ids.map((id) => ({ id })),
      }),
    },
    freeBusySchema,
    "free/busy",
  );
  const spans: BusySpan[] = [];
  for (const id of query.ids) {
    const cal = body.calendars?.[id];
    if (cal === undefined || (cal.errors ?? []).length > 0) continue;
    spans.push(...(cal.busy ?? []));
  }
  return spans;
}
