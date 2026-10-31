// SPDX-License-Identifier: AGPL-3.0-or-later

// The Google authorization request (DESIGN.md §12). Pure string building — no
// fetch, no platform APIs; `URL`/`URLSearchParams` are globals on both runtimes.

export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

// §12 + §13 least-scope: exactly the two scopes the reconcile loop uses, nothing
// more. Both are "sensitive" — public use needs OAuth/brand verification but not
// the CASA security assessment.
export const GOOGLE_CALENDAR_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

export interface AuthorizeRequest {
  readonly clientId: string;
  /** Must match a redirect URI registered on the OAuth client, character for character. */
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes?: readonly string[];
  /** Optional: pre-fills the account chooser. Not a security control. */
  readonly loginHint?: string;
  /**
   * False for sign-in (§13 rc20): no refresh token is wanted, so neither
   * `access_type=offline` nor forced consent; the account chooser instead, so someone
   * with several Google accounts picks one. Defaults to true, the calendar connect.
   */
  readonly offline?: boolean;
}

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) {
    throw new Error(`authorize request ${field} must not be empty`);
  }
  return value;
}

/**
 * Build the URL to redirect the user to.
 *
 * Two parameter choices are load-bearing and easy to get wrong:
 *
 * `access_type=offline` — without it Google returns an access token only, so the
 * reconcile loop would stop working after roughly an hour and could never resume
 * unattended. The whole desired-state model depends on holding a refresh token.
 *
 * `prompt=consent` — Google returns a refresh token *only on the first
 * authorization* for a given client/user pair. Without forcing consent, a user
 * reconnecting after revocation or after testing-mode's 7-day expiry (§12) gets an
 * access token and no refresh token, so the connection dies again within the hour.
 * Since §12 makes `status='auth_error'` → reconnect a first-class flow, re-consent
 * has to actually re-issue the refresh token. The cost is that returning users see
 * the consent screen every time, which is the right trade for a sync that works.
 *
 * Both apply to the calendar connect only; sign-in passes `offline: false`.
 */
export function buildAuthorizeUrl(request: AuthorizeRequest): string {
  const scopes = request.scopes ?? GOOGLE_CALENDAR_SCOPES;
  if (scopes.length === 0) {
    throw new Error("authorize request needs at least one scope");
  }

  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  const params = url.searchParams;
  params.set("client_id", requireNonEmpty(request.clientId, "clientId"));
  params.set("redirect_uri", requireNonEmpty(request.redirectUri, "redirectUri"));
  params.set("response_type", "code");
  params.set("scope", scopes.join(" "));
  params.set("state", requireNonEmpty(request.state, "state"));
  params.set("code_challenge", requireNonEmpty(request.codeChallenge, "codeChallenge"));
  params.set("code_challenge_method", "S256");
  if (request.offline === false) {
    params.set("prompt", "select_account");
  } else {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  if (request.loginHint !== undefined) {
    params.set("login_hint", request.loginHint);
  }
  return url.toString();
}
