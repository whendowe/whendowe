// SPDX-License-Identifier: AGPL-3.0-or-later
import { bytesToBase64Url } from "../crypto/base64.js";

// PKCE (RFC 7636) and the OAuth `state` nonce (DESIGN.md §13: "validate `state` on
// the callback (login-CSRF) and use PKCE. Agents reliably forget `state`; it is
// gate-worthy.").
//
// The two defend different things and neither substitutes for the other:
//   state — binds the callback to the browser that started the flow. Without it,
//           an attacker can feed you *their* authorization code and graft their
//           calendar onto your session (login CSRF).
//   PKCE  — binds the code to the client that requested it. Without it, a code
//           intercepted in transit or in a log can be redeemed by anyone holding
//           the client secret.
//
// Both live here as pure-ish functions with an injectable random source, so the
// tests can pin RFC 7636's own vector rather than merely agreeing with themselves.

// 32 random bytes → 43 base64url chars, which is exactly RFC 7636's minimum
// verifier length. The RFC permits 43–128; there is no benefit above 32 bytes of
// entropy, and shorter is not permitted.
const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;
const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;

// RFC 7636 §4.1: verifier = 43*128 unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"
const VERIFIER_CHARSET = /^[A-Za-z0-9\-._~]+$/;

/** Injectable entropy source; defaults to the WebCrypto CSPRNG. */
export type RandomBytes = (length: number) => Uint8Array;

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export interface PkcePair {
  /** Secret. Kept by the client across the redirect, sent only on token exchange. */
  readonly verifier: string;
  /** Public. Sent on the authorize request. */
  readonly challenge: string;
  readonly method: "S256";
}

/** A fresh PKCE verifier. Secret — never logged, never put in a URL (§14). */
export function createCodeVerifier(randomBytes: RandomBytes = defaultRandomBytes): string {
  return bytesToBase64Url(randomBytes(VERIFIER_BYTES));
}

/** A fresh `state` nonce. Public, but must be unguessable. */
export function createState(randomBytes: RandomBytes = defaultRandomBytes): string {
  return bytesToBase64Url(randomBytes(STATE_BYTES));
}

/**
 * S256 challenge for a verifier: BASE64URL(SHA256(ASCII(verifier))), RFC 7636 §4.2.
 *
 * Only S256 is supported. The RFC also allows `plain`, which offers no protection
 * at all against interception — the thing PKCE exists to prevent — so it is not
 * implemented rather than being offered and discouraged.
 */
export async function codeChallengeFor(verifier: string): Promise<string> {
  assertValidVerifier(verifier);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function createPkcePair(
  randomBytes: RandomBytes = defaultRandomBytes,
): Promise<PkcePair> {
  const verifier = createCodeVerifier(randomBytes);
  return { verifier, challenge: await codeChallengeFor(verifier), method: "S256" };
}

/**
 * Reject a verifier that violates RFC 7636 §4.1. Errors carry the length or a
 * charset complaint, never the verifier itself — it is a secret (§13/§14).
 */
export function assertValidVerifier(verifier: string): void {
  if (verifier.length < MIN_VERIFIER_LENGTH || verifier.length > MAX_VERIFIER_LENGTH) {
    throw new Error(
      `PKCE verifier must be ${MIN_VERIFIER_LENGTH}–${MAX_VERIFIER_LENGTH} characters, got ${verifier.length}`,
    );
  }
  if (!VERIFIER_CHARSET.test(verifier)) {
    throw new Error("PKCE verifier contains characters outside the RFC 7636 unreserved set");
  }
}

/**
 * Compare two nonces without an early-exit on the first differing byte.
 *
 * Used for `state` on the callback. The timing signal here is faint — `state` is
 * single-use and short-lived — but a fast-path `===` on a security comparison is
 * a habit worth not forming, and this is the only place the comparison happens.
 *
 * Length inequality does return early: that leaks only the length, which is a
 * fixed constant for values this module generates.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  }
  return diff === 0;
}
