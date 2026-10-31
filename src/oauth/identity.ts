// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { base64UrlToBytes } from "../crypto/base64.js";

// Who signed in with Google (DESIGN.md §13 rc20): the ID token's claims, read into an
// address — or into the reason it can't be trusted to name one. Pure; no fetch.
//
// The signature is NOT checked, deliberately. The token is read only from the
// token-endpoint response, which came over TLS straight from Google in exchange for
// our client secret and the PKCE verifier; OpenID Connect Core §3.1.3.7 lets the TLS
// server check stand in for the signature in exactly that case. Never call this on an
// ID token that arrived any other way (a form field, a query string, a cookie).

export const GOOGLE_SIGN_IN_SCOPES: readonly string[] = ["openid", "email"];

/** Google documents both spellings of its issuer. */
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

/** Tolerance for a server clock running slightly behind Google's. */
const CLOCK_SKEW_SECONDS = 60;

const claimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  email: z.string().min(1).optional(),
  // Google sends a boolean; older tokens carried the string. Either is accepted,
  // and anything else is "not verified".
  email_verified: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  /** Present only for a Google Workspace account: its primary domain. */
  hd: z.string().min(1).optional(),
});

export type GoogleIdentity =
  /** An address Google hosts and has verified: sign this person in. */
  | { readonly kind: "authoritative"; readonly email: string }
  /** Verified once, at sign-up, for a mailbox Google doesn't host: use the email link. */
  | { readonly kind: "not-authoritative"; readonly email: string }
  /** No address, or Google says it is unverified. */
  | { readonly kind: "unverified" };

export interface IdTokenContext {
  /** Our OAuth client id: the only audience accepted. */
  readonly clientId: string;
  readonly nowEpochSeconds: number;
}

function payloadOf(idToken: string): unknown {
  const parts = idToken.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload === "") {
    throw new Error("id token is not a JWT");
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      base64UrlToBytes(payload),
    );
  } catch {
    throw new Error("id token payload is not base64url UTF-8");
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("id token payload is not JSON");
  }
}

/**
 * Read a Google ID token. Throws on a token that is malformed, from another issuer,
 * for another client or expired: those are failures, not answers. Messages never
 * carry the token or its claims (§13/§14).
 */
export function readGoogleIdToken(idToken: string, context: IdTokenContext): GoogleIdentity {
  const parsed = claimsSchema.safeParse(payloadOf(idToken));
  if (!parsed.success) throw new Error("id token claims do not match the schema");
  const claims = parsed.data;

  if (!GOOGLE_ISSUERS.has(claims.iss)) throw new Error("id token is not from Google");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!audiences.includes(context.clientId)) throw new Error("id token is for another client");
  if (claims.exp + CLOCK_SKEW_SECONDS < context.nowEpochSeconds) {
    throw new Error("id token has expired");
  }

  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (claims.email === undefined || !verified) return { kind: "unverified" };
  return isAuthoritative(claims.email, claims.hd)
    ? { kind: "authoritative", email: claims.email }
    : { kind: "not-authoritative", email: claims.email };
}

/**
 * Google answers for the mailboxes it hosts: Gmail, and a Workspace account (which
 * `hd` marks). For any other address it verified the mailbox once, when the account
 * was made, and whoever made it keeps the account after losing the mailbox (§13).
 */
function isAuthoritative(email: string, hd: string | undefined): boolean {
  if (hd !== undefined) return true;
  return email.toLowerCase().endsWith("@gmail.com");
}
