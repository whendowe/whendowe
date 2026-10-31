// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { defaultFetch, type FetchLike, formEncode, requestJson } from "./http.js";

// Authorization code → tokens (DESIGN.md §12) for the calendar connect, or → an ID
// token for sign-in (§13 rc20). Plain REST, no SDK.

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  // REQUIRED, deliberately. Google only returns a refresh token when the
  // authorize request asked for offline access AND consent was granted afresh
  // (see src/oauth/authorize.ts). Without one the connection cannot survive the
  // hour, so accepting the response would mean storing a row that is already
  // broken and discovering it later, mid-reconcile. Better to fail the connect.
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().min(1),
  /** Space-delimited. Google may return fewer scopes than were requested. */
  scope: z.string().optional(),
});

// Sign-in asks for no offline access, so there is no refresh token to require; the
// ID token is the whole point, and the access token is never used.
const idTokenResponseSchema = z.object({
  id_token: z.string().min(1),
});

export interface GoogleTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Absolute expiry, ISO-8601 UTC. Stored as-is; refresh margin is the caller's. */
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

export interface ExchangeRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must match the authorize request's redirect_uri exactly — Google compares strings. */
  readonly redirectUri: string;
  /** Injected clock (ISO-8601 UTC), per the §9 simulator-friendly convention. */
  readonly now: string;
  readonly fetchImpl?: FetchLike;
}

function expiryFrom(nowIso: string, expiresInSeconds: number): string {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error("token exchange received an invalid `now`");
  }
  return new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
}

/**
 * POST a code to the token endpoint.
 *
 * Everything secret travels in the POST body, never the query string — §13
 * forbids logging URL query strings precisely because they leak into access logs,
 * and the body keeps the code and client secret out of them by construction.
 */
function redeem<T>(
  request: Omit<ExchangeRequest, "now">,
  schema: z.ZodType<T>,
  what: string,
): Promise<T> {
  const body = formEncode({
    code: request.code,
    client_id: request.clientId,
    client_secret: request.clientSecret,
    redirect_uri: request.redirectUri,
    grant_type: "authorization_code",
    code_verifier: request.codeVerifier,
  });

  return requestJson(
    request.fetchImpl ?? defaultFetch,
    GOOGLE_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    schema,
    what,
  );
}

/** Redeem a calendar-connect authorization code. */
export async function exchangeAuthorizationCode(request: ExchangeRequest): Promise<GoogleTokens> {
  const response = await redeem(request, tokenResponseSchema, "token exchange");

  if (response.token_type.toLowerCase() !== "bearer") {
    // We go on to send `Authorization: Bearer <token>`; anything else would be a
    // silent auth failure later rather than a clear one now.
    throw new Error(`token exchange returned unsupported token_type: ${response.token_type}`);
  }

  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: expiryFrom(request.now, response.expires_in),
    scopes: response.scope === undefined ? [] : response.scope.split(" ").filter((s) => s !== ""),
  };
}

/**
 * Redeem a sign-in authorization code for its ID token. Read it with
 * readGoogleIdToken (identity.ts), which may trust it unsigned only because it came
 * from here.
 */
export async function exchangeForIdToken(request: Omit<ExchangeRequest, "now">): Promise<string> {
  return (await redeem(request, idTokenResponseSchema, "sign-in token exchange")).id_token;
}

export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * Revoke a grant at Google (DESIGN §10 rc21: deleting an account revokes its calendar
 * connections before their tokens are deleted). Revoking the refresh token ends the whole
 * grant. Best effort by design: a token Google already forgot answers 400, and an
 * account is deleted whatever Google says — so this reports, and never throws.
 */
export async function revokeGoogleGrant(
  token: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formEncode({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
