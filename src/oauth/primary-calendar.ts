// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { defaultFetch, type FetchLike, requestJson } from "./http.js";

// Identify the account a fresh connection belongs to (DESIGN.md §10:
// calendar_connection.account_email / calendar_id are both NOT NULL).
//
// Why this call rather than an `email` scope: reading the account's email from an
// id_token would mean requesting `openid email` on top of the calendar scopes,
// which §13's least-scope rule and §12's scope list both argue against. The
// primary calendar entry carries the identity we need and is already covered by
// the `calendar` scope we hold.
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
