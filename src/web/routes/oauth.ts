// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { TokenCipher } from "../../crypto/tokens.js";
import type { StoragePort } from "../../db/port.js";
import { stmt } from "../../db/port.js";
import { uuidv7 } from "../../ids.js";
import { buildAuthorizeUrl } from "../../oauth/authorize.js";
import {
  buildFlowClearCookie,
  buildFlowSetCookie,
  readFlowCookie,
  sealFlow,
  unsealFlow,
} from "../../oauth/flow-cookie.js";
import type { FetchLike } from "../../oauth/http.js";
import { createPkcePair, createState, timingSafeEqual } from "../../oauth/pkce.js";
import { fetchPrimaryCalendar } from "../../oauth/primary-calendar.js";
import { exchangeAuthorizationCode } from "../../oauth/token-exchange.js";
import { type Html, html } from "../layout.js";
import { type AppEnv, page, requireSignedIn, verifyFormCsrf } from "../session.js";

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

export const CONNECT_PATH = "/oauth/google/connect";
export const CALLBACK_PATH = "/oauth/google/callback";

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

const EXPIRED = html`<p>This connection attempt is no longer valid. Please start again.</p>`;

export function registerOAuthRoutes(app: Hono<AppEnv>, deps: OAuthRouteDeps): void {
  const cookieOptions = { secure: deps.secureCookies !== false };
  const newId = deps.newId ?? (() => uuidv7());

  // POST, not GET: a GET that set state could be triggered by any page with an
  // <img> tag. CSRF-checked like every other mutation.
  app.post(CONNECT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    if (!(await verifyFormCsrf(me, await c.req.parseBody()))) {
      return c.html(result(c, "Request rejected", html`<p>Please try again.</p>`), 403);
    }

    const pkce = await createPkcePair();
    const state = createState();
    const sealed = await sealFlow(deps.cipher, {
      state,
      verifier: pkce.verifier,
      personId: me.personId,
      issuedAt: secondsSinceEpoch(deps.now()),
    });

    const authorizeUrl = buildAuthorizeUrl({
      clientId: deps.clientId,
      redirectUri: deps.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    });

    c.header("Set-Cookie", buildFlowSetCookie(sealed, cookieOptions));
    // 303: the response to a POST is a GET of another resource.
    return c.redirect(authorizeUrl, 303);
  });

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
      return c.html(result(c, "Connection failed", html`<p>The callback was malformed.</p>`), 400);
    }

    // The user declined, or Google refused. Anyone can craft this value; `html`
    // escapes it.
    if (query.data.error !== undefined) {
      return c.html(
        result(
          c,
          "Connection cancelled",
          html`<p>Google reported: <code>${shortCode(query.data.error)}</code></p>`,
        ),
        400,
      );
    }

    const { code, state } = query.data;
    if (code === undefined || state === undefined) {
      return c.html(result(c, "Connection failed", html`<p>The callback was incomplete.</p>`), 400);
    }

    const cookie = readFlowCookie(c.req.header("cookie"));
    if (cookie === null) return c.html(result(c, "Connection expired", EXPIRED), 400);

    let flow: Awaited<ReturnType<typeof unsealFlow>>;
    try {
      flow = await unsealFlow(deps.cipher, cookie, secondsSinceEpoch(deps.now()));
    } catch {
      // Tampered, expired, or sealed under a rotated key. The reason is not shown
      // to the caller — it would be a probing oracle — and is not logged here
      // either, because the message could name fields of a hostile cookie.
      return c.html(result(c, "Connection expired", EXPIRED), 400);
    }

    // THE login-CSRF check (§13). Without it an attacker can feed their own
    // authorization code to a victim's callback and graft their calendar on.
    if (!timingSafeEqual(state, flow.state)) {
      return c.html(result(c, "Connection failed", html`<p>Request verification failed.</p>`), 400);
    }

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

    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier: flow.verifier,
      clientId: deps.clientId,
      clientSecret: deps.clientSecret,
      redirectUri: deps.redirectUri,
      now: deps.now(),
      fetchImpl: deps.fetchImpl,
    });

    const calendar = await fetchPrimaryCalendar(tokens.accessToken, deps.fetchImpl);

    const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
      deps.cipher.encrypt(tokens.accessToken),
      deps.cipher.encrypt(tokens.refreshToken),
    ]);

    const timestamp = deps.now();
    // Upsert, not insert: (owner_id, provider, calendar_id) is UNIQUE (§10), and
    // reconnecting after an auth_error must refresh the grant rather than collide.
    // sync_token is deliberately left alone — an existing cursor stays valid, and a
    // dead one is recovered by the 410 GONE full-resync path (§12), not by
    // discarding it here.
    await deps.storage.batch([
      stmt(
        `INSERT INTO calendar_connection
           (id, owner_id, provider, account_email, calendar_id,
            access_token_enc, refresh_token_enc, token_expiry,
            status, created_at, updated_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(owner_id, provider, calendar_id) DO UPDATE SET
           account_email = excluded.account_email,
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           token_expiry = excluded.token_expiry,
           status = 'active',
           updated_at = excluded.updated_at`,
        newId(),
        flow.personId,
        calendar.id,
        calendar.id,
        accessTokenEnc,
        refreshTokenEnc,
        tokens.expiresAt,
        timestamp,
        timestamp,
      ),
    ]);

    // calendar.summary and calendar.id are whatever the account holder typed —
    // untrusted, escaped by `html` (§13).
    return c.html(
      result(
        c,
        "Calendar connected",
        html`<p>Connected <strong>${calendar.summary ?? calendar.id}</strong>.</p>`,
      ),
    );
  });
}
