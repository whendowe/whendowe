// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  GOOGLE_AUTHORIZE_ENDPOINT,
  GOOGLE_CALENDAR_SCOPES,
} from "../../src/oauth/authorize.js";
import {
  assertValidVerifier,
  createCodeVerifier,
  createState,
  timingSafeEqual,
} from "../../src/oauth/pkce.js";

// Cross-runtime PKCE behaviour (the RFC 7636 vector, challenge derivation) lives in
// tests/contract/pkce.suite.ts and runs on both Node and workerd. What stays here is
// runtime-independent: verifier validation, nonce properties, and URL building.

const REDIRECT_URI = "http://localhost:8080/oauth/google/callback";

function authorizeParams(overrides: Record<string, string> = {}): URLSearchParams {
  const url = buildAuthorizeUrl({
    clientId: "test-client-id.apps.googleusercontent.com",
    redirectUri: REDIRECT_URI,
    state: "test-state",
    codeChallenge: "test-challenge",
    ...overrides,
  });
  return new URL(url).searchParams;
}

// --- verifier validation (RFC 7636 §4.1) ---

it("accepts a generated verifier", () => {
  expect(() => assertValidVerifier(createCodeVerifier())).not.toThrow();
});

it("rejects a verifier shorter than 43 or longer than 128 characters", () => {
  expect(() => assertValidVerifier("a".repeat(42))).toThrow(/43–128 characters, got 42/);
  expect(() => assertValidVerifier("a".repeat(129))).toThrow(/43–128 characters, got 129/);
  expect(() => assertValidVerifier("a".repeat(43))).not.toThrow();
  expect(() => assertValidVerifier("a".repeat(128))).not.toThrow();
});

it("rejects characters outside the unreserved set", () => {
  // Standard base64 output would smuggle "+" and "/" in here — a common bug, and
  // Google rejects the resulting exchange rather than failing loudly up front.
  expect(() => assertValidVerifier(`${"a".repeat(42)}+`)).toThrow(/unreserved set/);
  expect(() => assertValidVerifier(`${"a".repeat(42)}/`)).toThrow(/unreserved set/);
  expect(() => assertValidVerifier(`${"a".repeat(42)}=`)).toThrow(/unreserved set/);
  expect(() => assertValidVerifier(`${"a".repeat(42)} `)).toThrow(/unreserved set/);
});

it("never puts the verifier into a validation error message (§13)", () => {
  const secret = `${"z".repeat(42)}+`;
  let message = "";
  try {
    assertValidVerifier(secret);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toBe("");
  expect(message).not.toContain(secret);
});

// --- nonces ---

it("generates distinct unguessable state values", () => {
  const values = new Set(Array.from({ length: 50 }, () => createState()));
  expect(values.size).toBe(50);
  for (const value of values) {
    expect(value).toHaveLength(43);
    expect(value).toMatch(/^[A-Za-z0-9\-_]+$/);
  }
});

it("generates distinct verifiers", () => {
  const values = new Set(Array.from({ length: 50 }, () => createCodeVerifier()));
  expect(values.size).toBe(50);
});

// --- state comparison ---

it("compares nonces without an early exit", () => {
  expect(timingSafeEqual("abc", "abc")).toBe(true);
  expect(timingSafeEqual("abc", "abd")).toBe(false);
  expect(timingSafeEqual("abc", "abcd")).toBe(false);
  expect(timingSafeEqual("", "")).toBe(true);
  expect(timingSafeEqual("abc", "")).toBe(false);
  // Differing in the FIRST character must be as false as differing in the last —
  // the whole point of not short-circuiting.
  expect(timingSafeEqual("xbc", "abc")).toBe(false);
});

// --- authorize URL (§12) ---

it("targets the documented Google authorization endpoint", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "cid",
      redirectUri: REDIRECT_URI,
      state: "s",
      codeChallenge: "c",
    }),
  );
  expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_ENDPOINT);
});

it("requests an authorization code with S256 PKCE", () => {
  const params = authorizeParams();
  expect(params.get("response_type")).toBe("code");
  expect(params.get("code_challenge")).toBe("test-challenge");
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("state")).toBe("test-state");
});

// These two are the difference between a sync that keeps working and one that
// dies within the hour, so they are asserted rather than assumed (§12).
it("requests offline access so a refresh token is issued", () => {
  expect(authorizeParams().get("access_type")).toBe("offline");
});

it("forces consent so reconnects re-issue a refresh token", () => {
  // Google returns a refresh token only on the FIRST authorization unless consent
  // is forced; without this, §12's auth_error → reconnect path yields an access
  // token only and the connection dies again.
  expect(authorizeParams().get("prompt")).toBe("consent");
});

it("requests exactly the two calendar scopes, space-delimited", () => {
  const scope = authorizeParams().get("scope");
  expect(scope).toBe(GOOGLE_CALENDAR_SCOPES.join(" "));
  expect(GOOGLE_CALENDAR_SCOPES).toHaveLength(2);
  // §13 least scope: no Gmail, Drive, or full-account scopes creeping in.
  expect(scope).not.toMatch(/gmail|drive|userinfo/);
});

it("round-trips the redirect URI exactly", () => {
  // redirect_uri_mismatch is the most common failure in this flow and it compares
  // strings, not URL semantics — so encoding must survive the round trip intact.
  expect(authorizeParams().get("redirect_uri")).toBe(REDIRECT_URI);
});

it("omits login_hint unless asked", () => {
  expect(authorizeParams().has("login_hint")).toBe(false);
  expect(authorizeParams({ loginHint: "someone@example.com" }).get("login_hint")).toBe(
    "someone@example.com",
  );
});

it("rejects empty required fields", () => {
  expect(() => authorizeParams({ clientId: "" })).toThrow(/clientId must not be empty/);
  expect(() => authorizeParams({ redirectUri: "" })).toThrow(/redirectUri must not be empty/);
  expect(() => authorizeParams({ state: "" })).toThrow(/state must not be empty/);
  expect(() => authorizeParams({ codeChallenge: "" })).toThrow(/codeChallenge must not be empty/);
});

it("rejects an empty scope list", () => {
  expect(() =>
    buildAuthorizeUrl({
      clientId: "cid",
      redirectUri: REDIRECT_URI,
      state: "s",
      codeChallenge: "c",
      scopes: [],
    }),
  ).toThrow(/at least one scope/);
});
