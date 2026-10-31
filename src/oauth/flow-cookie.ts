// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { TokenCipher } from "../crypto/tokens.js";
import { assertValidVerifier } from "./pkce.js";

// Where the in-flight OAuth flow lives between the authorize redirect and the
// callback (DESIGN.md §13).
//
// Decision: an ENCRYPTED COOKIE, not an `oauth_state` table. `state` exists to
// bind the callback to the browser that began the flow, and that binding requires
// something in the browser no matter what — a server-side row keyed by `state`
// alone can be completed by anyone who learns the value, which is the login-CSRF
// §13 guards against. A table would therefore sit on top of a cookie rather than
// replace one, so it only earns its place if atomic single-use consumption or an
// audit trail of attempts is wanted. Neither is load-bearing yet, and adding the
// table later turns this cookie into a flow-id pointer without changing the
// browser-facing mechanism. (Durable Objects are not an option: §16 forbids them
// holding domain data.)
//
// The cookie is ENCRYPTED, not merely signed: it carries the PKCE verifier, which
// is a secret. Signing would make it tamper-evident but still readable.
//
// The cookie is also the attacker-influenced input on the callback path, so the
// decrypted payload is validated with zod before anything trusts a field of it.
//
// It names the flow's PURPOSE (§13 rc20): calendar connect and Google sign-in share
// one callback, and the sealed purpose is what tells them apart. It can't be changed
// without the key, so neither flow's callback can be replayed as the other's.

export const FLOW_COOKIE_NAME = "wdw_oauth_flow";

/** Ten minutes: long enough to read a consent screen, short enough to matter. */
export const FLOW_TTL_SECONDS = 600;

/** Scoped to the OAuth routes — the cookie has no business on any other path. */
const COOKIE_PATH = "/oauth";

/** Tolerance for a client whose clock runs slightly ahead of the server's. */
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

const flowFields = {
  state: z.string().min(1),
  verifier: z.string().min(1),
  /** Seconds since the epoch, for a server-side expiry check. */
  issuedAt: z.number().int().nonnegative(),
};

const flowPayloadSchema = z.discriminatedUnion("purpose", [
  z.object({
    ...flowFields,
    purpose: z.literal("connect"),
    /** The signed-in person who started the flow; the callback requires the same one. */
    personId: z.string().min(1),
  }),
  // Nobody need be signed in to start: the person is whoever Google says, at the end.
  z.object({ ...flowFields, purpose: z.literal("sign-in") }),
]);

export type OAuthFlow = z.infer<typeof flowPayloadSchema>;

export interface CookieOptions {
  /**
   * Emit `Secure`. Defaults to true and should stay true anywhere real.
   *
   * Browsers do treat `http://localhost` as a trustworthy origin and accept
   * `Secure` cookies there, so local development normally needs no exception —
   * this exists for the environments that disagree, not as a convenience.
   */
  readonly secure?: boolean;
}

function attributes(maxAgeSeconds: number, options: CookieOptions): string {
  const parts = [
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    // Lax, not Strict: Google returns the user via a top-level GET navigation,
    // which Lax permits and Strict would drop — breaking every callback. Lax
    // still refuses the cookie on cross-site subrequests, which is the threat.
    "SameSite=Lax",
  ];
  if (options.secure !== false) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/** Encrypt a flow for transport in a cookie. */
export async function sealFlow(cipher: TokenCipher, flow: OAuthFlow): Promise<string> {
  assertValidVerifier(flow.verifier);
  const sealed = await cipher.encrypt(JSON.stringify(flowPayloadSchema.parse(flow)));
  // The cipher emits standard base64, which contains `+` and `/`. Percent-encoding
  // the whole value sidesteps both those and any cookie-octet question outright.
  return encodeURIComponent(sealed);
}

/**
 * Decrypt and validate a flow cookie.
 *
 * Throws — never returns a partially-trusted value — on: a malformed cookie, a
 * failed decryption (wrong key or tampering), a payload that does not match the
 * schema, a verifier that violates RFC 7636, or an expired/future-dated flow.
 * Messages never carry the verifier or the cookie contents (§13/§14).
 */
export async function unsealFlow(
  cipher: TokenCipher,
  cookieValue: string,
  nowEpochSeconds: number,
): Promise<OAuthFlow> {
  let sealed: string;
  try {
    sealed = decodeURIComponent(cookieValue);
  } catch {
    throw new Error("oauth flow cookie is not a valid encoded value");
  }

  // Decryption failure is already opaque by construction (see tokens.ts) and is
  // the case that covers tampering.
  const json = await cipher.decrypt(sealed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("oauth flow cookie payload is not valid JSON");
  }

  const flow = flowPayloadSchema.parse(parsed);
  assertValidVerifier(flow.verifier);

  const age = nowEpochSeconds - flow.issuedAt;
  if (age > FLOW_TTL_SECONDS) {
    throw new Error(`oauth flow expired ${age - FLOW_TTL_SECONDS}s ago`);
  }
  if (age < -CLOCK_SKEW_TOLERANCE_SECONDS) {
    // A future-dated flow would otherwise live longer than the TTL allows.
    throw new Error("oauth flow is dated in the future");
  }

  return flow;
}

/** `Set-Cookie` value that installs the flow cookie. */
export function buildFlowSetCookie(sealedValue: string, options: CookieOptions = {}): string {
  return `${FLOW_COOKIE_NAME}=${sealedValue}; ${attributes(FLOW_TTL_SECONDS, options)}`;
}

/**
 * `Set-Cookie` value that clears the flow cookie.
 *
 * The callback must send this whether it succeeded or failed: a cookie cannot be
 * invalidated server-side, so clearing it on use is the closest approximation of
 * single-use available to this design. (Replay is additionally bounded by Google's
 * authorization code itself being single-use.)
 */
export function buildFlowClearCookie(options: CookieOptions = {}): string {
  return `${FLOW_COOKIE_NAME}=; ${attributes(0, options)}`;
}

/** Extract the raw flow cookie from a `Cookie` request header, if present. */
export function readFlowCookie(cookieHeader: string | null | undefined): string | null {
  if (cookieHeader === undefined || cookieHeader === null || cookieHeader.length === 0) {
    return null;
  }
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (pair.slice(0, separator).trim() === FLOW_COOKIE_NAME) {
      const value = pair.slice(separator + 1).trim();
      return value.length === 0 ? null : value;
    }
  }
  return null;
}
