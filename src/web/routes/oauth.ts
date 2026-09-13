// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Hono } from "hono";
import { z } from "zod";
import type { TokenCipher } from "../../crypto/tokens.js";
import type { StoragePort } from "../../db/port.js";
import { stmt } from "../../db/port.js";
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
import { escapeHtml } from "../escape.js";

// The Google connect flow (DESIGN.md §12/§13). Platform-blind: everything that
// touches a platform — storage driver, clock, id generation, fetch — arrives as a
// dependency, so the same routes run under Node and workerd and are testable
// against an in-memory database with no network.

export const CONNECT_PATH = "/oauth/google/connect";
export const CALLBACK_PATH = "/oauth/google/callback";

export interface OAuthRouteDeps {
  readonly storage: StoragePort;
  readonly cipher: TokenCipher;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must equal a redirect URI registered on the OAuth client, character for character. */
  readonly redirectUri: string;
  /** Single-user MVP (§17 leaves multi-account open); the row still carries owner_id. */
  readonly ownerId: string;
  /** Injected clock, ISO-8601 UTC (§9). */
  readonly now: () => string;
  /** Injected id generator, so tests are deterministic. */
  readonly newId: () => string;
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

function page(title: string, bodyHtml: string): string {
  // Static markup with pre-escaped interpolations only; callers escape.
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    `<h1>${escapeHtml(title)}</h1>`,
    bodyHtml,
    "</body>",
    "</html>",
  ].join("\n");
}

/** Truncated so a hostile `?error=` cannot flood the response. Escaped on render. */
function shortCode(value: string): string {
  return value.slice(0, 64);
}

function secondsSinceEpoch(nowIso: string): number {
  return Math.floor(new Date(nowIso).getTime() / 1000);
}

export function registerOAuthRoutes(app: Hono, deps: OAuthRouteDeps): void {
  const cookieOptions = { secure: deps.secureCookies !== false };

  // POST, not GET. §13's "GET never mutates" is written about token links, but the
  // same reasoning applies to anything that sets state: a GET here would let any
  // page start a connect flow with an <img> tag.
  //
  // KNOWN GAP: no CSRF token. §13 requires them "on all HTMX mutations", and there
  // is no session layer yet to hang one on (§17 has not settled single-user vs
  // multi-account, so there is nothing to bind a token to). The exposure is
  // bounded: a forged POST can only push the user to Google's consent screen,
  // which they can decline, and an attacker cannot complete the flow — the flow
  // cookie is HttpOnly so they cannot read the `state` they would have to echo.
  // This must gain a CSRF token when the session layer lands in M3.
  app.post(CONNECT_PATH, async (c) => {
    const pkce = await createPkcePair();
    const state = createState();
    const sealed = await sealFlow(deps.cipher, {
      state,
      verifier: pkce.verifier,
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

  // GET, because Google decides the method — this is the one mutating GET in the
  // app, and `state` + PKCE are what stand in for the POST it cannot be.
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
      return c.html(page("Connection failed", "<p>The callback was malformed.</p>"), 400);
    }

    // The user declined, or Google refused. Escaped: anyone can craft this value.
    if (query.data.error !== undefined) {
      return c.html(
        page(
          "Connection cancelled",
          `<p>Google reported: <code>${escapeHtml(shortCode(query.data.error))}</code></p>`,
        ),
        400,
      );
    }

    const { code, state } = query.data;
    if (code === undefined || state === undefined) {
      return c.html(page("Connection failed", "<p>The callback was incomplete.</p>"), 400);
    }

    const cookie = readFlowCookie(c.req.header("cookie"));
    if (cookie === null) {
      return c.html(
        page(
          "Connection expired",
          "<p>This connection attempt is no longer valid. Please start again.</p>",
        ),
        400,
      );
    }

    let flow: Awaited<ReturnType<typeof unsealFlow>>;
    try {
      flow = await unsealFlow(deps.cipher, cookie, secondsSinceEpoch(deps.now()));
    } catch {
      // Tampered, expired, or sealed under a rotated key. The reason is not shown
      // to the caller — it would be a probing oracle — and is not logged here
      // either, because the message could name fields of a hostile cookie.
      return c.html(
        page(
          "Connection expired",
          "<p>This connection attempt is no longer valid. Please start again.</p>",
        ),
        400,
      );
    }

    // THE login-CSRF check (§13). Without it an attacker can feed their own
    // authorization code to a victim's callback and graft their calendar on.
    if (!timingSafeEqual(state, flow.state)) {
      return c.html(page("Connection failed", "<p>Request verification failed.</p>"), 400);
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
        deps.newId(),
        deps.ownerId,
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
    // untrusted, so escaped (§13).
    const label = calendar.summary ?? calendar.id;
    return c.html(
      page("Calendar connected", `<p>Connected <strong>${escapeHtml(label)}</strong>.</p>`),
    );
  });
}
