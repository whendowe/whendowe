// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import type { FetchLike, HttpRequestInit } from "../../src/oauth/http.js";
import {
  exchangeAuthorizationCode,
  exchangeForIdToken,
  GOOGLE_TOKEN_ENDPOINT,
} from "../../src/oauth/token-exchange.js";

const NOW = "2026-09-12T10:00:00.000Z";
const CLIENT_SECRET = "super-secret-client-secret";
const CODE = "4/0AY0e-authorization-code";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

interface Recorded {
  url: string;
  init: HttpRequestInit;
}

function fakeFetch(status: number, body: string): { impl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    });
  };
  return { impl, calls };
}

function okBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: "ya29.access-token",
    refresh_token: "1//refresh-token",
    expires_in: 3599,
    token_type: "Bearer",
    scope:
      "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
    ...overrides,
  });
}

function exchange(fetchImpl: FetchLike) {
  return exchangeAuthorizationCode({
    code: CODE,
    codeVerifier: VERIFIER,
    clientId: "cid.apps.googleusercontent.com",
    clientSecret: CLIENT_SECRET,
    redirectUri: "http://localhost:8080/oauth/google/callback",
    now: NOW,
    fetchImpl,
  });
}

// --- happy path ---

it("posts the documented form fields to the token endpoint", async () => {
  const { impl, calls } = fakeFetch(200, okBody());
  await exchange(impl);

  expect(calls).toHaveLength(1);
  const call = calls[0];
  expect(call?.url).toBe(GOOGLE_TOKEN_ENDPOINT);
  expect(call?.init.method).toBe("POST");
  expect(call?.init.headers["content-type"]).toBe("application/x-www-form-urlencoded");

  const sent = new URLSearchParams(call?.init.body ?? "");
  expect(sent.get("grant_type")).toBe("authorization_code");
  expect(sent.get("code")).toBe(CODE);
  expect(sent.get("code_verifier")).toBe(VERIFIER);
  expect(sent.get("redirect_uri")).toBe("http://localhost:8080/oauth/google/callback");
  expect(sent.get("client_secret")).toBe(CLIENT_SECRET);
});

it("keeps the secret out of the URL", async () => {
  const { impl, calls } = fakeFetch(200, okBody());
  await exchange(impl);
  // §13 forbids logging URL query strings because they reach access logs; putting
  // credentials in the body instead means there is nothing there to leak.
  expect(calls[0]?.url).not.toContain("?");
  expect(calls[0]?.url).not.toContain(CLIENT_SECRET);
  expect(calls[0]?.url).not.toContain(CODE);
});

it("computes an absolute expiry from the injected clock", async () => {
  const { impl } = fakeFetch(200, okBody({ expires_in: 3600 }));
  const tokens = await exchange(impl);
  expect(tokens.expiresAt).toBe("2026-09-12T11:00:00.000Z");
});

it("returns the tokens and splits scopes", async () => {
  const { impl } = fakeFetch(200, okBody());
  const tokens = await exchange(impl);
  expect(tokens.accessToken).toBe("ya29.access-token");
  expect(tokens.refreshToken).toBe("1//refresh-token");
  expect(tokens.scopes).toEqual([
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
  ]);
});

it("tolerates an absent scope field", async () => {
  const { impl } = fakeFetch(200, okBody({ scope: undefined }));
  expect((await exchange(impl)).scopes).toEqual([]);
});

// --- the failure that matters most ---

it("refuses a response with no refresh token", async () => {
  // Google omits the refresh token unless offline access was requested AND consent
  // was granted afresh. Accepting this would store a connection that dies within
  // the hour and fails later, mid-reconcile, instead of here.
  const { impl } = fakeFetch(200, okBody({ refresh_token: undefined }));
  await expect(exchange(impl)).rejects.toThrow(/unexpected shape.*refresh_token/s);
});

it("refuses a token_type other than Bearer", async () => {
  const { impl } = fakeFetch(200, okBody({ token_type: "mac" }));
  await expect(exchange(impl)).rejects.toThrow(/unsupported token_type: mac/);
});

it("accepts Bearer case-insensitively", async () => {
  const { impl } = fakeFetch(200, okBody({ token_type: "bearer" }));
  await expect(exchange(impl)).resolves.toBeDefined();
});

// --- upstream errors ---

it("surfaces Google's error code and description", async () => {
  const { impl } = fakeFetch(
    400,
    JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }),
  );
  await expect(exchange(impl)).rejects.toThrow(/HTTP 400.*invalid_grant: Bad Request/);
});

it("never surfaces fields other than error and error_description", async () => {
  // If an upstream error body ever echoed part of our request, only the two
  // documented fields are read — the raw body is never interpolated (§13/§14).
  const { impl } = fakeFetch(
    400,
    JSON.stringify({
      error: "invalid_client",
      error_description: "Unauthorized",
      client_secret: CLIENT_SECRET,
      code: CODE,
    }),
  );
  let message = "";
  try {
    await exchange(impl);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("invalid_client");
  expect(message).not.toContain(CLIENT_SECRET);
  expect(message).not.toContain(CODE);
});

it("handles an API-style nested error body", async () => {
  const { impl } = fakeFetch(403, JSON.stringify({ error: { message: "Access Not Configured" } }));
  await expect(exchange(impl)).rejects.toThrow(/Access Not Configured/);
});

it("handles a JSON error body that is not an object", async () => {
  const { impl } = fakeFetch(500, "42");
  await expect(exchange(impl)).rejects.toThrow(/HTTP 500.*unrecognized error body/);
});

it("handles a nested error object with no message", async () => {
  const { impl } = fakeFetch(500, JSON.stringify({ error: { code: 500 } }));
  await expect(exchange(impl)).rejects.toThrow(/HTTP 500.*unrecognized error body/);
});

it("handles an unparseable error body", async () => {
  const { impl } = fakeFetch(502, "<html>bad gateway</html>");
  await expect(exchange(impl)).rejects.toThrow(/HTTP 502.*unparseable error body/);
});

it("rejects a non-JSON success body", async () => {
  const { impl } = fakeFetch(200, "not json");
  await expect(exchange(impl)).rejects.toThrow(/non-JSON body/);
});

it("names offending fields without echoing token values", async () => {
  const { impl } = fakeFetch(200, JSON.stringify({ access_token: "ya29.leaky", expires_in: -1 }));
  let message = "";
  try {
    await exchange(impl);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/unexpected shape/);
  expect(message).toContain("refresh_token");
  // A zod error message can echo received values; this one must not.
  expect(message).not.toContain("ya29.leaky");
});

it("rejects an invalid injected clock", async () => {
  const { impl } = fakeFetch(200, okBody());
  await expect(
    exchangeAuthorizationCode({
      code: CODE,
      codeVerifier: VERIFIER,
      clientId: "cid",
      clientSecret: CLIENT_SECRET,
      redirectUri: "http://localhost:8080/oauth/google/callback",
      now: "not-a-date",
      fetchImpl: impl,
    }),
  ).rejects.toThrow(/invalid `now`/);
});

// --- sign-in (§13 rc20) ---

function exchangeForSignIn(fetchImpl: FetchLike) {
  return exchangeForIdToken({
    code: CODE,
    codeVerifier: VERIFIER,
    clientId: "cid.apps.googleusercontent.com",
    clientSecret: CLIENT_SECRET,
    redirectUri: "http://localhost:8080/oauth/google/callback",
    fetchImpl,
  });
}

it("redeems a sign-in code for its ID token, with no refresh token needed", async () => {
  const { impl, calls } = fakeFetch(
    200,
    JSON.stringify({
      access_token: "ya29.a",
      id_token: "h.p.s",
      expires_in: 3599,
      token_type: "Bearer",
    }),
  );
  expect(await exchangeForSignIn(impl)).toBe("h.p.s");
  const sent = new URLSearchParams(calls[0]?.init.body ?? "");
  expect(sent.get("code_verifier")).toBe(VERIFIER);
  expect(sent.get("grant_type")).toBe("authorization_code");
  expect(calls[0]?.url).toBe(GOOGLE_TOKEN_ENDPOINT);
});

it("refuses a sign-in response with no ID token", async () => {
  const { impl } = fakeFetch(200, JSON.stringify({ access_token: "ya29.a", token_type: "Bearer" }));
  await expect(exchangeForSignIn(impl)).rejects.toThrow();
});
