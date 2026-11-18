// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { TokenCipher } from "../../crypto/tokens.js";
import type { StoragePort } from "../../db/port.js";
import { stmt } from "../../db/port.js";
import { busyFromSpans, type GoogleBusySource, rangeOf } from "../../feeds/busy.js";
import { uuidv7 } from "../../ids.js";
import { buildAuthorizeUrl } from "../../oauth/authorize.js";
import {
  buildFlowClearCookie,
  buildFlowSetCookie,
  buildPendingClearCookie,
  buildPendingSetCookie,
  type OAuthFlow,
  type PendingConnection,
  readFlowCookie,
  readPendingCookie,
  sealFlow,
  sealPending,
  unsealFlow,
  unsealPending,
} from "../../oauth/flow-cookie.js";
import type { FetchLike } from "../../oauth/http.js";
import {
  GOOGLE_SIGN_IN_SCOPES,
  type GoogleIdentity,
  readGoogleIdToken,
} from "../../oauth/identity.js";
import { createPkcePair, createState, timingSafeEqual } from "../../oauth/pkce.js";
import {
  type BusyChoice,
  type CalendarChoice,
  createCalendar,
  deleteCalendar,
  fetchFreeBusy,
  fetchPrimaryCalendar,
  findWritableCalendar,
  listBusyCalendars,
  listWritableCalendars,
} from "../../oauth/primary-calendar.js";
import {
  exchangeAuthorizationCode,
  exchangeForIdToken,
  refreshAccessToken,
  revokeGoogleGrant,
} from "../../oauth/token-exchange.js";
import {
  type CapabilityConfig,
  EVERYTHING,
  GOOGLE_BUSY_UNAVAILABLE,
  hasCapability,
  UNAVAILABLE,
} from "../../people/capability.js";
import { findOrCreatePerson, findPersonByEmail, normalizeEmail } from "../../people/person.js";
import { copiesOn, forgetConnection } from "../../reconcile/tick.js";
import { type Html, html } from "../layout.js";
import {
  type AppEnv,
  page,
  requireSignedIn,
  roomFor,
  signInAs,
  verifyFormCsrf,
} from "../session.js";
import { type AuthDeps, GOOGLE_SIGN_IN_PATH, SIGN_IN_PATH, tooManyAccounts } from "./auth.js";

// The Google connect flow (DESIGN.md §12/§13), owned by a signed-in person (MVP-1 E).
//
// Changes from M1, each closing a gap M1 documented:
// - Connecting requires a session, and the connection belongs to THAT person. M1
//   stored every connection under a placeholder owner 'self', so on a public
//   instance anyone who reached the page could attach a calendar.
// - The connect POST is CSRF-checked. M1 recorded this as a known gap because there
//   was no session to bind a token to; now there is.
// - The flow cookie carries the person who started the flow, and the callback
//   refuses unless that same person is still signed in. Otherwise signing out and in
//   as someone else mid-flow would attach the calendar to whoever is signed in last.
// - Pages render through the layout's `html` tag, so escaping is the default.
//
// Sign in with Google (§13 rc20) shares the callback: the sealed flow cookie names
// the purpose, and the callback dispatches on it. The redirect URI registered on the
// OAuth client therefore stays one URI.

export const CONNECT_PATH = "/oauth/google/connect";
export const CALLBACK_PATH = "/oauth/google/callback";
/** Where a first connection's calendar is chosen (rc40); under /oauth, where its cookie is. */
export const CHOOSE_PATH = "/oauth/google/calendar";
/** Where the calendars whose busy times count are changed later (rc41). */
export const BUSY_PATH = "/oauth/google/busy";
/** Where disconnecting asks what to do with the copies (rc40). */
export const DISCONNECT_PATH = "/oauth/google/disconnect";

/** The choice that makes a new calendar, and that calendar's name (rc40). */
const NEW_CALENDAR = "new";
export const NEW_CALENDAR_NAME = "WhenDoWe";

const choiceSchema = z.string().min(1).max(1024);

/** The calendars whose busy times count (rc41): none, one or several ticks of `busy`. */
const MAX_BUSY = 50;
/** What disconnecting does with the copies (rc40); `calendar` only for one WhenDoWe made. */
const copiesSchema = z.enum(["remove", "keep", "calendar"]);

const busySchema = z
  .union([choiceSchema, z.array(choiceSchema)])
  .optional()
  .transform((v) => [...new Set(v === undefined ? [] : typeof v === "string" ? [v] : v)]);

export { GOOGLE_SIGN_IN_PATH };

export interface OAuthRouteDeps {
  readonly storage: StoragePort;
  readonly cipher: TokenCipher;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must equal a redirect URI registered on the OAuth client, character for character. */
  readonly redirectUri: string;
  /** Injected clock, ISO-8601 UTC (§9). */
  readonly now: () => string;
  /** Injected id generator; UUIDv7 by default (schema.ts convention). */
  readonly newId?: () => string;
  readonly fetchImpl?: FetchLike;
  /** Set false only where `Secure` cookies are rejected over http. */
  readonly secureCookies?: boolean;
}

// The callback query. Google sends either (code, state) or (error, state).
//
// The length caps are what make this parse able to fail at all: every field is
// optional, so without them the guard below would be unreachable. Anyone can point
// a browser at this endpoint with a megabyte of query string, and rejecting that
// before it reaches the cipher or the token endpoint is cheap.
const MAX_QUERY_FIELD = 2048;

const callbackQuerySchema = z.object({
  code: z.string().min(1).max(MAX_QUERY_FIELD).optional(),
  state: z.string().min(1).max(MAX_QUERY_FIELD).optional(),
  error: z.string().min(1).max(MAX_QUERY_FIELD).optional(),
});

/** A person's Google connection, if any: one per account (rc40). */
export async function googleConnectionOf(
  storage: StoragePort,
  personId: string,
): Promise<{ accountEmail: string; calendarId: string; status: string } | null> {
  const [row] = await storage.query(
    stmt(
      "SELECT account_email, calendar_id, status FROM calendar_connection WHERE owner_id = ? AND provider = 'google'",
      personId,
    ),
  );
  return row === undefined
    ? null
    : {
        accountEmail: String(row.account_email),
        calendarId: String(row.calendar_id),
        status: String(row.status),
      };
}

/**
 * Whether this account may connect Google Calendar (rc43 `calendar_sync`). Checked at every
 * step that starts or completes a connection, so a flow begun before a revoke can't finish.
 */
export function maySync(
  storage: StoragePort,
  capabilities: CapabilityConfig | undefined,
  personId: string,
): Promise<boolean> {
  return hasCapability(storage, capabilities ?? EVERYTHING, personId, "calendar_sync");
}

/** Truncated so a hostile `?error=` cannot flood the response. Escaped by `html`. */
function shortCode(value: string): string {
  return value.slice(0, 64);
}

function secondsSinceEpoch(nowIso: string): number {
  return Math.floor(new Date(nowIso).getTime() / 1000);
}

function result(c: Context<AppEnv>, title: string, body: Html): string {
  return page(c, title, html`<h1>${title}</h1>${body}<p><a href="/">← Home</a></p>`);
}

const EXPIRED = html`<p>This attempt is no longer valid. Please start again.</p>`;

const NOT_AVAILABLE = html`<p>${UNAVAILABLE.calendar_sync}</p>`;
const BUSY_NOT_AVAILABLE = html`<p>${GOOGLE_BUSY_UNAVAILABLE}</p>`;

/** The ticks for whose busy times count (rc41), on connecting and on changing them later. */
function busyField(
  busy: readonly BusyChoice[],
  ticked: (cal: BusyChoice) => boolean,
  disabled = false,
): Html {
  // Calendar names are whatever the account holder typed: untrusted, escaped (§13).
  return html`<fieldset${disabled ? html` disabled` : ""}><legend>Whose busy times should show while you pick a time?</legend>
  <p class="muted">Only you see them, and only when, never what. The calendars you own are ticked; ones you only follow, like holidays, aren't.</p>
  ${busy.map(
    (cal) =>
      html`<p><label><input type="checkbox" name="busy" value="${cal.id}"${ticked(cal) ? html` checked` : ""} /> ${cal.name}</label></p>`,
  )}
  </fieldset>`;
}

const UNREACHABLE = html`<p>Google didn't answer just now. Please try again in a moment.</p>`;

const EMAIL_LINK = html`<p><a href="${SIGN_IN_PATH}">Sign in with an email link</a></p>`;

/** "Email me a link" for an address Google named but can't vouch for (§13 rc20). */
function offerEmailLink(email: string): Html {
  return html`<form method="post" action="${SIGN_IN_PATH}">
  <input type="hidden" name="email" value="${email}" />
  <button type="submit">Email me a sign-in link</button>
</form>`;
}

/** The flow this browser started, or null for one that is missing, expired or forged. */
async function flowOf(c: Context<AppEnv>, deps: OAuthRouteDeps): Promise<OAuthFlow | null> {
  const cookie = readFlowCookie(c.req.header("cookie"));
  if (cookie === null) return null;
  try {
    return await unsealFlow(deps.cipher, cookie, secondsSinceEpoch(deps.now()));
  } catch {
    // Tampered, expired, or sealed under a rotated key. The reason is not shown
    // to the caller — it would be a probing oracle — and is not logged here
    // either, because the message could name fields of a hostile cookie.
    return null;
  }
}

/**
 * The signed-in person's active Google connection and an access token for this request
 * only (rc41): a token about to expire is refreshed and not saved, so a GET writes
 * nothing. Null with no active connection; throws if Google refuses or doesn't answer.
 */
async function liveConnection(
  deps: OAuthRouteDeps,
  personId: string,
): Promise<{
  readonly id: string;
  readonly calendarId: string;
  readonly madeByUs: boolean;
  readonly accessToken: string;
} | null> {
  const [row] = await deps.storage.query(
    stmt(
      `SELECT id, calendar_id, made_by_us, access_token_enc, refresh_token_enc, token_expiry
         FROM calendar_connection WHERE owner_id = ? AND provider = 'google' AND status = 'active'`,
      personId,
    ),
  );
  if (row === undefined) return null;
  const conn = z
    .object({
      id: z.string(),
      calendar_id: z.string(),
      made_by_us: z.number(),
      access_token_enc: z.string(),
      refresh_token_enc: z.string(),
      token_expiry: z.string().nullable(),
    })
    .parse(row);
  const now = deps.now();
  // A minute's margin, so the token can't expire between here and Google.
  const fresh =
    conn.token_expiry !== null &&
    new Date(conn.token_expiry).getTime() - new Date(now).getTime() > 60_000;
  const accessToken = fresh
    ? await deps.cipher.decrypt(conn.access_token_enc)
    : (
        await refreshAccessToken({
          refreshToken: await deps.cipher.decrypt(conn.refresh_token_enc),
          clientId: deps.clientId,
          clientSecret: deps.clientSecret,
          now,
          fetchImpl: deps.fetchImpl,
        })
      ).accessToken;
  return {
    id: conn.id,
    calendarId: conn.calendar_id,
    madeByUs: conn.made_by_us === 1,
    accessToken,
  };
}

/**
 * Google's busy times for the picker (rc41, rc44), for GET /busy: the ticked calendars'
 * free/busy for the days asked, times only, never stored or logged. Checks `calendar_sync`
 * before touching a token; an account without it that is connected hears so. Any failure
 * — a refused refresh, a Google error, a malformed answer — is just `failed`: the reason
 * isn't kept, since it could carry a token.
 */
export function googleBusySource(
  deps: OAuthRouteDeps,
  capabilities: CapabilityConfig | undefined,
): GoogleBusySource {
  return async (personId, query) => {
    if (!(await maySync(deps.storage, capabilities, personId))) {
      return (await googleConnectionOf(deps.storage, personId)) === null
        ? { state: "none" }
        : { state: "unavailable" };
    }
    const ids = (
      await deps.storage.query(
        stmt(
          `SELECT b.calendar_id FROM busy_calendar b
             JOIN calendar_connection c ON c.id = b.connection_id
            WHERE c.owner_id = ? AND c.provider = 'google' AND c.status = 'active'
            ORDER BY b.calendar_id`,
          personId,
        ),
      )
    ).map((r) => String(r.calendar_id));
    if (ids.length === 0) return { state: "none" };
    try {
      const conn = await liveConnection(deps, personId);
      if (conn === null) return { state: "none" };
      const range = rangeOf(query);
      const spans = await fetchFreeBusy(
        conn.accessToken,
        { timeMin: range.start, timeMax: range.end, ids },
        deps.fetchImpl,
      );
      return { state: "shown", busy: busyFromSpans(spans, query.tz) };
    } catch {
      return { state: "failed" };
    }
  };
}

export function registerOAuthRoutes(
  app: Hono<AppEnv>,
  deps: OAuthRouteDeps,
  /** People and sessions; without them there is no one to sign in, so no Google sign-in. */
  auth?: AuthDeps,
): void {
  const cookieOptions = { secure: deps.secureCookies !== false };
  const newId = deps.newId ?? (() => uuidv7());

  /** Seal a new flow into the cookie and send the browser to Google. */
  async function begin(
    c: Context<AppEnv>,
    flow: { purpose: "connect"; personId: string } | { purpose: "sign-in" },
  ) {
    const pkce = await createPkcePair();
    const state = createState();
    const sealed = await sealFlow(deps.cipher, {
      ...flow,
      state,
      verifier: pkce.verifier,
      issuedAt: secondsSinceEpoch(deps.now()),
    });
    const authorizeUrl = buildAuthorizeUrl({
      clientId: deps.clientId,
      redirectUri: deps.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      ...(flow.purpose === "sign-in" ? { scopes: GOOGLE_SIGN_IN_SCOPES, offline: false } : {}),
    });
    c.header("Set-Cookie", buildFlowSetCookie(sealed, cookieOptions));
    // 303: the response to a POST is a GET of another resource.
    return c.redirect(authorizeUrl, 303);
  }

  // POST, not GET: a GET that set state could be triggered by any page with an
  // <img> tag. CSRF-checked like every other mutation.
  app.post(CONNECT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    if (!(await verifyFormCsrf(me, await c.req.parseBody()))) {
      return c.html(result(c, "Request rejected", html`<p>Please try again.</p>`), 403);
    }
    if (!(await maySync(deps.storage, auth?.capabilities, me.personId))) {
      return c.html(result(c, "Not connected", NOT_AVAILABLE), 403);
    }
    return begin(c, { purpose: "connect", personId: me.personId });
  });

  // Sign in with Google (§13 rc20). POST like connect, but no CSRF token: signed out
  // there is no session to bind one to, as with the magic-link request. Login CSRF is
  // the callback's to stop, and `state` does.
  if (auth !== undefined) {
    app.post(GOOGLE_SIGN_IN_PATH, (c) => begin(c, { purpose: "sign-in" }));
  }

  // GET, because Google decides the method — the one mutating GET in the app, and
  // `state` + PKCE + the session check stand in for the POST it cannot be.
  app.get(CALLBACK_PATH, async (c) => {
    // Clear the flow cookie on every outcome. A cookie cannot be invalidated
    // server-side, so clearing on use is the nearest thing to single-use here.
    c.header("Set-Cookie", buildFlowClearCookie(cookieOptions));

    const query = callbackQuerySchema.safeParse({
      code: c.req.query("code"),
      state: c.req.query("state"),
      error: c.req.query("error"),
    });
    if (!query.success) {
      return c.html(
        result(c, "Couldn't finish with Google", html`<p>The callback was malformed.</p>`),
        400,
      );
    }

    // Read before the error branch only to choose its words: nothing is trusted yet.
    const flow = await flowOf(c, deps);

    // The user declined, or Google refused. Anyone can craft this value; `html`
    // escapes it.
    if (query.data.error !== undefined) {
      const reported = html`<p>Google reported: <code>${shortCode(query.data.error)}</code></p>`;
      return flow?.purpose === "sign-in"
        ? c.html(
            result(
              c,
              "Not signed in",
              html`${reported}
<p>If you cancelled, nothing happened. While WhenDoWe is being tried out, only people added as testers can sign in with Google; anyone can sign in with an email link.</p>
${EMAIL_LINK}`,
            ),
            400,
          )
        : c.html(result(c, "Connection cancelled", reported), 400);
    }

    const { code, state } = query.data;
    if (code === undefined || state === undefined) {
      return c.html(
        result(c, "Couldn't finish with Google", html`<p>The callback was incomplete.</p>`),
        400,
      );
    }
    if (flow === null) return c.html(result(c, "Attempt expired", EXPIRED), 400);

    // THE login-CSRF check (§13). Without it an attacker can feed their own
    // authorization code to a victim's callback and graft their calendar on, or sign
    // the victim in as the attacker.
    if (!timingSafeEqual(state, flow.state)) {
      return c.html(
        result(c, "Couldn't finish with Google", html`<p>Request verification failed.</p>`),
        400,
      );
    }

    switch (flow.purpose) {
      case "connect":
        return connect(c, flow, code);
      case "sign-in":
        if (auth === undefined) return c.notFound();
        return signIn(c, auth, flow, code);
      default: {
        const unreachable: never = flow;
        return unreachable;
      }
    }
  });

  async function connect(
    c: Context<AppEnv>,
    flow: Extract<OAuthFlow, { purpose: "connect" }>,
    code: string,
  ) {
    // The person who started the flow must be the person signed in now. Checked
    // AFTER state, and before anything is exchanged or stored.
    const me = c.get("signedIn");
    if (me === null || me.personId !== flow.personId) {
      return c.html(
        result(
          c,
          "Connection stopped",
          html`<p>You're no longer signed in as the person who started this. Sign in and try again.</p>`,
        ),
        403,
      );
    }
    // Revoked while at Google: refused before the code is exchanged, so no grant exists.
    if (!(await maySync(deps.storage, auth?.capabilities, me.personId))) {
      return c.html(result(c, "Not connected", NOT_AVAILABLE), 403);
    }

    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier: flow.verifier,
      clientId: deps.clientId,
      clientSecret: deps.clientSecret,
      redirectUri: deps.redirectUri,
      now: deps.now(),
      fetchImpl: deps.fetchImpl,
    });

    const primary = await fetchPrimaryCalendar(tokens.accessToken, deps.fetchImpl);
    const existing = await googleConnectionOf(deps.storage, flow.personId);

    // One Google connection per account (rc40). Connecting again — a reconnect after
    // auth_error — refreshes the grant and keeps the calendar it already writes to.
    if (existing !== null) {
      if (existing.accountEmail !== primary.id) {
        // A grant we won't use is given back, not kept.
        await revokeGoogleGrant(tokens.refreshToken, deps.fetchImpl);
        return c.html(
          result(
            c,
            "Not connected",
            html`<p>This account's calendar is connected through <strong>${existing.accountEmail}</strong>. To reconnect, choose that Google account.</p>`,
          ),
          409,
        );
      }
      await store(flow.personId, primary.id, existing.calendarId, tokens, false);
      return c.html(result(c, "Calendar reconnected", html`<p>Reconnected.</p>`));
    }

    // A first connection: the person chooses the calendar (rc40). The grant waits,
    // sealed, in this browser until they do; nothing is stored yet.
    const calendars = await listWritableCalendars(tokens.accessToken, deps.fetchImpl);
    const busy = await listBusyCalendars(tokens.accessToken, deps.fetchImpl);
    const sealed = await sealPending(deps.cipher, {
      personId: flow.personId,
      accountEmail: primary.id,
      timeZone: primary.timeZone,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      issuedAt: secondsSinceEpoch(deps.now()),
    });
    c.header("Set-Cookie", buildPendingSetCookie(sealed, cookieOptions), { append: true });
    // Calendar names are whatever the account holder typed: untrusted, escaped (§13).
    const option = (cal: CalendarChoice) =>
      html`<p><label><input type="radio" name="calendar" value="${cal.id}" /> ${cal.name}${
        cal.primary ? html` <span class="muted">(your main calendar)</span>` : ""
      }</label></p>`;
    return c.html(
      result(
        c,
        "Choose a calendar",
        html`<p>Which calendar of <strong>${primary.id}</strong> should your WhenDoWe events go into?</p>
<form method="post" action="${CHOOSE_PATH}">
  <input type="hidden" name="csrf" value="${me.csrfToken}" />
  <p><label><input type="radio" name="calendar" value="${NEW_CALENDAR}" checked /> A new calendar called <strong>${NEW_CALENDAR_NAME}</strong></label><br /><span class="muted">Its own colour in Google, and easy to hide or remove.</span></p>
  ${calendars.map(option)}
  ${busyField(busy, (cal) => cal.owned)}
  <p><button type="submit">Use this calendar</button></p>
</form>`,
      ),
    );
  }

  // The choice (rc40). POST, CSRF-checked, by the person who granted it.
  app.post(CHOOSE_PATH, async (c) => {
    c.header("Set-Cookie", buildPendingClearCookie(cookieOptions));
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const body = await c.req.parseBody({ all: true });
    if (!(await verifyFormCsrf(me, body))) {
      return c.html(result(c, "Request rejected", html`<p>Please try again.</p>`), 403);
    }
    const cookie = readPendingCookie(c.req.header("cookie"));
    let pending: PendingConnection | null = null;
    if (cookie !== null) {
      try {
        pending = await unsealPending(deps.cipher, cookie, secondsSinceEpoch(deps.now()));
      } catch {
        pending = null;
      }
    }
    if (pending === null) return c.html(result(c, "Attempt expired", EXPIRED), 400);
    if (pending.personId !== me.personId) {
      return c.html(
        result(
          c,
          "Connection stopped",
          html`<p>You're no longer signed in as the person who started this. Sign in and try again.</p>`,
        ),
        403,
      );
    }
    // Revoked while choosing: the grant waiting in the cookie is given back, not kept.
    if (!(await maySync(deps.storage, auth?.capabilities, me.personId))) {
      await revokeGoogleGrant(pending.refreshToken, deps.fetchImpl);
      return c.html(result(c, "Not connected", NOT_AVAILABLE), 403);
    }
    const choice = choiceSchema.safeParse(body.calendar);
    if (!choice.success) {
      return c.html(result(c, "Choose a calendar", html`<p>Please choose one.</p>`), 400);
    }
    const ticked = busySchema.safeParse(body.busy);
    if (!ticked.success || ticked.data.length > MAX_BUSY) {
      return c.html(
        result(c, "Choose a calendar", html`<p>Tick at most ${MAX_BUSY} calendars.</p>`),
        400,
      );
    }
    if ((await googleConnectionOf(deps.storage, me.personId)) !== null) {
      return c.html(
        result(c, "Already connected", html`<p>This account already has a calendar connected.</p>`),
        409,
      );
    }
    const tokens = {
      accessToken: pending.accessToken,
      refreshToken: pending.refreshToken,
      expiresAt: pending.expiresAt,
    };
    // The ticks came back from a form: only calendars in the account's list are kept.
    // Asked before anything is made, so a failure here leaves nothing behind in Google.
    const known = new Set(
      (await listBusyCalendars(tokens.accessToken, deps.fetchImpl)).map((cal) => cal.id),
    );
    let calendar: { id: string; name: string };
    const madeByUs = choice.data === NEW_CALENDAR;
    if (madeByUs) {
      const id = await createCalendar(
        tokens.accessToken,
        { summary: NEW_CALENDAR_NAME, timeZone: pending.timeZone },
        deps.fetchImpl,
      );
      calendar = { id, name: NEW_CALENDAR_NAME };
    } else {
      // The id came back from a form: Google says whether it may still take events.
      const found = await findWritableCalendar(tokens.accessToken, choice.data, deps.fetchImpl);
      if (found === null) {
        return c.html(
          result(
            c,
            "Not connected",
            html`<p>That calendar can't take events. Please start again.</p>`,
          ),
          400,
        );
      }
      calendar = found;
    }
    await store(me.personId, pending.accountEmail, calendar.id, tokens, madeByUs, {
      busy: ticked.data.filter((id) => known.has(id) && !(madeByUs && id === calendar.id)),
    });
    return c.html(
      result(c, "Calendar connected", html`<p>Connected <strong>${calendar.name}</strong>.</p>`),
    );
  });

  /** The calendars that may count: Google's list, never the one WhenDoWe made (rc41). */
  async function busyChoices(conn: {
    readonly calendarId: string;
    readonly madeByUs: boolean;
    readonly accessToken: string;
  }) {
    return (await listBusyCalendars(conn.accessToken, deps.fetchImpl)).filter(
      (cal) => !(conn.madeByUs && cal.id === conn.calendarId),
    );
  }

  const NOT_CONNECTED = html`<p>Connect Google Calendar first, or reconnect it if Google stopped accepting WhenDoWe's access.</p>`;

  // Changing whose busy times count (rc41). A GET: it reads Google's list and writes nothing.
  app.get(BUSY_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    let conn: Awaited<ReturnType<typeof liveConnection>>;
    let busy: BusyChoice[];
    try {
      conn = await liveConnection(deps, me.personId);
      busy = conn === null ? [] : await busyChoices(conn);
    } catch {
      // Neither Google's answer nor the reason is shown or logged: either could carry a token.
      return c.html(result(c, "Busy times", UNREACHABLE), 502);
    }
    if (conn === null) return c.html(result(c, "Busy times", NOT_CONNECTED), 404);
    // Without calendar_sync (rc44) the ticks show, disabled, and stay kept for a regrant.
    const allowed = await maySync(deps.storage, auth?.capabilities, me.personId);
    const counting = new Set(
      (
        await deps.storage.query(
          stmt("SELECT calendar_id FROM busy_calendar WHERE connection_id = ?", conn.id),
        )
      ).map((r) => String(r.calendar_id)),
    );
    return c.html(
      result(
        c,
        "Busy times",
        html`<form method="post" action="${BUSY_PATH}">
  <input type="hidden" name="csrf" value="${me.csrfToken}" />
  ${busyField(busy, (cal) => counting.has(cal.id), !allowed)}
  <p class="muted">The calendar WhenDoWe puts your events in isn't listed: everything in it is already counted.</p>
  ${allowed ? html`<p><button type="submit">Save</button></p>` : BUSY_NOT_AVAILABLE}
</form>`,
      ),
    );
  });

  // POST, CSRF-checked. The ticks replace the old ones; only calendars Google lists are kept.
  app.post(BUSY_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const body = await c.req.parseBody({ all: true });
    if (!(await verifyFormCsrf(me, body))) {
      return c.html(result(c, "Request rejected", html`<p>Please try again.</p>`), 403);
    }
    if (!(await maySync(deps.storage, auth?.capabilities, me.personId))) {
      return c.html(result(c, "Busy times", BUSY_NOT_AVAILABLE), 403);
    }
    const ticked = busySchema.safeParse(body.busy);
    if (!ticked.success || ticked.data.length > MAX_BUSY) {
      return c.html(result(c, "Busy times", html`<p>Tick at most ${MAX_BUSY} calendars.</p>`), 400);
    }
    let conn: Awaited<ReturnType<typeof liveConnection>>;
    let known: Set<string>;
    try {
      conn = await liveConnection(deps, me.personId);
      known = new Set(conn === null ? [] : (await busyChoices(conn)).map((cal) => cal.id));
    } catch {
      return c.html(result(c, "Busy times", UNREACHABLE), 502);
    }
    if (conn === null) return c.html(result(c, "Busy times", NOT_CONNECTED), 404);
    const id = conn.id;
    await deps.storage.batch([
      stmt("DELETE FROM busy_calendar WHERE connection_id = ?", id),
      ...ticked.data
        .filter((cal) => known.has(cal))
        .map((cal) =>
          stmt("INSERT INTO busy_calendar (connection_id, calendar_id) VALUES (?, ?)", id, cal),
        ),
    ]);
    return c.redirect("/", 303);
  });

  /** The person's Google connection, whatever its status, for disconnecting it (rc40). */
  async function connectionToLeave(personId: string) {
    const [row] = await deps.storage.query(
      stmt(
        `SELECT id, status, made_by_us, refresh_token_enc
           FROM calendar_connection WHERE owner_id = ? AND provider = 'google'`,
        personId,
      ),
    );
    if (row === undefined) return null;
    const conn = z
      .object({
        id: z.string(),
        status: z.string(),
        made_by_us: z.number(),
        refresh_token_enc: z.string(),
      })
      .parse(row);
    return {
      id: conn.id,
      status: conn.status,
      madeByUs: conn.made_by_us === 1,
      refreshTokenEnc: conn.refresh_token_enc,
      copies: await copiesOn(deps.storage, conn.id),
    };
  }

  const events = (n: number) => (n === 1 ? "1 WhenDoWe event" : `${n} WhenDoWe events`);
  const REMOVING = html`<p>WhenDoWe is removing its events from your Google calendar, then giving its access back to Google. It takes a minute or two.</p>`;

  // Disconnecting asks what to do with the copies (rc40). A GET: it counts and writes nothing.
  app.get(DISCONNECT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const conn = await connectionToLeave(me.personId);
    if (conn === null) {
      return c.html(result(c, "Disconnect", html`<p>No Google Calendar is connected.</p>`), 404);
    }
    if (conn.status === "disconnected") return c.html(result(c, "Disconnecting", REMOVING));
    const choice = (copies: string, label: string) =>
      html`<button type="submit" name="copies" value="${copies}">${label}</button> `;
    const calendar = conn.madeByUs ? choice("calendar", "Delete the WhenDoWe calendar") : "";
    // Google no longer answers for this grant: nothing can be removed from here.
    const question =
      conn.status === "auth_error"
        ? html`<p>Google stopped accepting WhenDoWe's access, so ${conn.copies === 0 ? "nothing can be removed from here" : html`the ${events(conn.copies)} in your Google calendar can't be removed from here; remove them in Google Calendar yourself`}.</p>
  <p>${choice("keep", "Disconnect")}</p>`
        : conn.copies === 0
          ? html`<p>None of your WhenDoWe events are in your Google calendar.</p>
  <p>${calendar}${choice("keep", "Disconnect")}</p>`
          : html`<p>Also remove the ${events(conn.copies)} from your Google calendar?</p>
  <p>${choice("remove", "Remove them")}${choice("keep", "Keep them")}${calendar}</p>`;
    return c.html(
      result(
        c,
        "Disconnect Google Calendar",
        html`<form method="post" action="${DISCONNECT_PATH}">
  <input type="hidden" name="csrf" value="${me.csrfToken}" />
  ${question}
  <p class="muted">Either way, WhenDoWe gives its access back to Google and forgets it. Events you keep can be taken over again if you connect again.</p>
</form>`,
      ),
    );
  });

  // POST, CSRF-checked. Keep, or delete the calendar WhenDoWe made, here and now; removing the
  // copies one by one is the push tick's (§11: one path to Google), which then finishes.
  app.post(DISCONNECT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const body = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, body))) {
      return c.html(result(c, "Request rejected", html`<p>Please try again.</p>`), 403);
    }
    const copies = copiesSchema.safeParse(body.copies);
    if (!copies.success) {
      return c.html(result(c, "Disconnect", html`<p>Choose one.</p>`), 400);
    }
    const conn = await connectionToLeave(me.personId);
    if (conn === null) {
      return c.html(result(c, "Disconnect", html`<p>No Google Calendar is connected.</p>`), 404);
    }
    if (conn.status === "disconnected") return c.html(result(c, "Disconnecting", REMOVING));
    const stillAnswers = conn.status === "active";
    const chosen = copies.data;
    switch (chosen) {
      case "keep":
        await revokeGoogleGrant(await deps.cipher.decrypt(conn.refreshTokenEnc), deps.fetchImpl);
        await deps.storage.batch(forgetConnection(conn.id));
        return c.html(
          result(
            c,
            "Disconnected",
            html`<p>Google Calendar is disconnected.${conn.copies === 0 ? "" : html` The ${events(conn.copies)} there stay, and are no longer updated.`}</p>`,
          ),
        );
      case "remove":
        if (!stillAnswers) break;
        // Busy times stop now; the copies go on the next ticks, and then the connection.
        await deps.storage.batch([
          stmt(
            `UPDATE calendar_connection SET status = 'disconnected', updated_at = ?
              WHERE id = ? AND status = 'active'`,
            deps.now(),
            conn.id,
          ),
          stmt("DELETE FROM busy_calendar WHERE connection_id = ?", conn.id),
        ]);
        return c.html(result(c, "Disconnecting", REMOVING));
      case "calendar": {
        if (!stillAnswers || !conn.madeByUs) break;
        try {
          const live = await liveConnection(deps, me.personId);
          if (live === null) break;
          await deleteCalendar(live.accessToken, live.calendarId, deps.fetchImpl);
        } catch {
          // Neither Google's answer nor the reason is shown or logged: either could carry a token.
          return c.html(result(c, "Disconnect", UNREACHABLE), 502);
        }
        await revokeGoogleGrant(await deps.cipher.decrypt(conn.refreshTokenEnc), deps.fetchImpl);
        await deps.storage.batch(forgetConnection(conn.id));
        return c.html(
          result(
            c,
            "Disconnected",
            html`<p>Google Calendar is disconnected, and the WhenDoWe calendar deleted.</p>`,
          ),
        );
      }
      default: {
        const unreachable: never = chosen;
        return unreachable;
      }
    }
    return c.html(
      result(c, "Disconnect", html`<p>That isn't one of the choices. Please start again.</p>`),
      409,
    );
  });

  async function store(
    personId: string,
    accountEmail: string,
    calendarId: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: string },
    madeByUs: boolean,
    /** A first connection's busy calendars (rc41); a reconnect keeps the ones it had. */
    first?: { readonly busy: readonly string[] },
  ): Promise<void> {
    const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
      deps.cipher.encrypt(tokens.accessToken),
      deps.cipher.encrypt(tokens.refreshToken),
    ]);
    const timestamp = deps.now();
    // Upsert, not insert: (owner_id, provider, calendar_id) is UNIQUE (§10), and
    // reconnecting after an auth_error must refresh the grant rather than collide.
    // sync_token and made_by_us are deliberately left alone — an existing cursor stays
    // valid, a dead one is recovered by the 410 GONE full-resync path (§12), and who
    // made the calendar doesn't change by reconnecting.
    await deps.storage.batch([
      stmt(
        `INSERT INTO calendar_connection
           (id, owner_id, provider, account_email, calendar_id,
            access_token_enc, refresh_token_enc, token_expiry,
            status, made_by_us, created_at, updated_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(owner_id, provider, calendar_id) DO UPDATE SET
           account_email = excluded.account_email,
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           token_expiry = excluded.token_expiry,
           status = 'active',
           updated_at = excluded.updated_at`,
        newId(),
        personId,
        accountEmail,
        calendarId,
        accessTokenEnc,
        refreshTokenEnc,
        tokens.expiresAt,
        madeByUs ? 1 : 0,
        timestamp,
        timestamp,
      ),
      ...(first?.busy ?? []).map((id) =>
        stmt(
          `INSERT INTO busy_calendar (connection_id, calendar_id)
           SELECT id, ? FROM calendar_connection
            WHERE owner_id = ? AND provider = 'google' AND calendar_id = ?`,
          id,
          personId,
          calendarId,
        ),
      ),
    ]);
  }

  /** Sign in as the address Google vouches for: the person a magic link to it gives. */
  async function signIn(
    c: Context<AppEnv>,
    auth: AuthDeps,
    flow: Extract<OAuthFlow, { purpose: "sign-in" }>,
    code: string,
  ) {
    let identity: GoogleIdentity;
    try {
      const idToken = await exchangeForIdToken({
        code,
        codeVerifier: flow.verifier,
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
        redirectUri: deps.redirectUri,
        fetchImpl: deps.fetchImpl,
      });
      identity = readGoogleIdToken(idToken, {
        clientId: deps.clientId,
        nowEpochSeconds: secondsSinceEpoch(deps.now()),
      });
    } catch {
      // Neither the response nor the reason is shown: either could carry the token.
      return c.html(
        result(
          c,
          "Not signed in",
          html`<p>Google's answer couldn't be checked. Please try again.</p>${EMAIL_LINK}`,
        ),
        502,
      );
    }

    let email: string | null = null;
    if (identity.kind !== "unverified") {
      try {
        email = normalizeEmail(identity.email);
      } catch {
        email = null;
      }
    }
    if (email === null) {
      return c.html(
        result(
          c,
          "Not signed in",
          html`<p>Google hasn't verified an email address for that account.</p>${EMAIL_LINK}`,
        ),
        400,
      );
    }
    if (identity.kind === "not-authoritative") {
      return c.html(
        result(
          c,
          "Use the email link",
          html`<p>Google doesn't look after the mailbox for <strong>${email}</strong>, so it can't vouch that it's still yours. We can email you a sign-in link instead.</p>
${offerEmailLink(email)}`,
        ),
        400,
      );
    }

    // As confirming a magic link does (auth.ts): a full browser is refused before
    // anyone is created.
    const known = await findPersonByEmail(auth.storage, email);
    if (!roomFor(c, known?.id ?? null)) return tooManyAccounts(c);
    const person = await findOrCreatePerson(auth.storage, email, { now: auth.now() });
    if (!(await signInAs(c, auth, person.id, "google"))) return tooManyAccounts(c);
    return c.redirect("/", 303);
  }
}
