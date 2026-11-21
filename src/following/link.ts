// SPDX-License-Identifier: AGPL-3.0-or-later

// What can be followed (DESIGN §10 rc56): an iCal link. Pure: a pasted link becomes the https:
// address to fetch, or the reason it can't. `webcal:` is read as `https:`; a Google Calendar
// embed or share link becomes its public iCal address, so a page's "subscribe" link and the
// embed on it both work as pasted. Whether the host is a public address is the fetch's to
// check (rc57), as only a lookup can say.

/** Longer than any calendar address seen; a bound on what is stored and fetched. */
export const MAX_LINK_LENGTH = 2000;

export type LinkRefusal =
  | "not-a-link" // not a URL at all, or too long
  | "not-https" // http:, ftp:, javascript:, … — only https: (and webcal:) is fetched
  | "credentials" // user:password@ — nothing is sent but a plain GET
  | "port"; // only the default port: anything else is a way to reach a service that isn't a calendar

export type FollowableLink =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: LinkRefusal };

const GOOGLE_HOST = "calendar.google.com";

/** A Google calendar id, as `src` or a decoded `cid` names it: something@something. */
const GOOGLE_ID = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;

/** `cid` in a share link is the id itself, or the id in base64 (url-safe, unpadded). */
function googleCid(cid: string): string | null {
  if (GOOGLE_ID.test(cid)) return cid;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(cid)) return null;
  try {
    const decoded = atob(cid.replaceAll("-", "+").replaceAll("_", "/"));
    return GOOGLE_ID.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function googleIcal(id: string): string {
  return `https://${GOOGLE_HOST}/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
}

/** The Google calendar an embed (`?src=`) or share (`?cid=`) link names; null if neither. */
function googleCalendarId(url: URL): string | null {
  if (url.hostname !== GOOGLE_HOST) return null;
  if (url.pathname.startsWith("/calendar/ical/")) return null; // already its iCal address
  const src = url.searchParams.get("src");
  if (src !== null && GOOGLE_ID.test(src)) return src;
  const cid = url.searchParams.get("cid");
  return cid === null ? null : googleCid(cid);
}

/** A pasted link -> the https: address to fetch. The fragment is dropped; the query kept. */
export function followableLink(pasted: string): FollowableLink {
  const text = pasted.trim();
  if (text === "" || text.length > MAX_LINK_LENGTH) return { ok: false, reason: "not-a-link" };
  let url: URL;
  try {
    url = new URL(/^webcals?:/i.test(text) ? text.replace(/^webcals?:/i, "https:") : text);
  } catch {
    return { ok: false, reason: "not-a-link" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not-https" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  if (url.port !== "") return { ok: false, reason: "port" };
  const google = googleCalendarId(url);
  if (google !== null) return { ok: true, url: googleIcal(google) };
  url.hash = "";
  return { ok: true, url: url.toString() };
}
