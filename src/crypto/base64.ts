// SPDX-License-Identifier: AGPL-3.0-or-later

// Byte/base64 conversion, shared by the token cipher (standard base64, for the
// *_enc columns) and PKCE (base64url, per RFC 7636). Uses the btoa/atob globals
// rather than node:Buffer so domain code stays platform-blind (DESIGN.md §16).
//
// One implementation on purpose: two hand-rolled base64 encoders in two security
// modules is exactly the pair that drifts.

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * base64url without padding — the encoding RFC 7636 requires for the PKCE
 * verifier and challenge, and RFC 4648 §5 generally.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
