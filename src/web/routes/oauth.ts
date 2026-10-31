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
  type OAuthFlow,
  readFlowCookie,
  sealFlow,
  unsealFlow,
} from "../../oauth/flow-cookie.js";
import type { FetchLike } from "../../oauth/http.js";
import {
  GOOGLE_SIGN_IN_SCOPES,
  type GoogleIdentity,
  readGoogleIdToken,
} from "../../oauth/identity.js";
import { createPkcePair, createState, timingSafeEqual } from "../../oauth/pkce.js";
import { fetchPrimaryCalendar } from "../../oauth/primary-calendar.js";
import { exchangeAuthorizationCode, exchangeForIdToken } from "../../oauth/token-exchange.js";
import { findOrCreatePerson, findPersonByEmail, normalizeEmail } from "../../people/person.js";
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
    if (!(await signInAs(c, auth, person.id))) return tooManyAccounts(c);
    return c.redirect("/", 303);
  }
}
