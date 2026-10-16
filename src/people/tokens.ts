// SPDX-License-Identifier: AGPL-3.0-or-later
import { bytesToBase64Url } from "../crypto/base64.js";
import type { RandomBytes } from "../ids.js";

// Opaque bearer tokens for magic links and sessions (DESIGN §13 token-link rules).
//
// The raw token leaves the server exactly once — in the emailed link or the
// Set-Cookie header — and is never stored. The database holds only its SHA-256,
// so a leaked database or backup yields no usable login link and no live session.
// That matters doubly here because D1 Time Travel keeps 30 days of history (§13):
// a plaintext token deleted on use would still sit in the backup tail.
//
// SHA-256 without a salt or KDF is deliberate and correct for this input: the token
// is 256 bits of CSPRNG output, not a human password, so there is nothing to
// brute-force and slow hashing would buy nothing but latency on every request.

/** 32 bytes = 256 bits of entropy; base64url-encoded to 43 characters. */
const TOKEN_BYTES = 32;

const defaultRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

export interface IssuedToken {
  /** Give this to the user (link or cookie). Never store it. */
  readonly token: string;
  /** Store this. Look tokens up by hashing what the user presents. */
  readonly hash: string;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function issueToken(
  randomBytes: RandomBytes = defaultRandomBytes,
): Promise<IssuedToken> {
  const token = bytesToBase64Url(randomBytes(TOKEN_BYTES));
  return { token, hash: await hashToken(token) };
}

/**
 * The CSRF token for a session, derived rather than stored: it is a function of the
 * session token the request already carries in its cookie, so it needs no column and
 * cannot drift from the session. A different domain-separation prefix keeps it from
 * ever equalling the session hash that IS stored.
 */
export async function csrfTokenFor(sessionToken: string): Promise<string> {
  return hashToken(`csrf:v1:${sessionToken}`);
}
