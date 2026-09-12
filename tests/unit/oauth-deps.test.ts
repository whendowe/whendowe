// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { anyGoogleOAuthConfigured, loadConfig } from "../../src/config.js";
import type { StoragePort } from "../../src/db/port.js";
import { buildOAuthDeps, SINGLE_USER_OWNER_ID } from "../../src/web/oauth-deps.js";

// buildOAuthDeps is the config → dependencies mapping both deploy adapters go
// through. A swap here (client id for client secret, say) would typecheck fine and
// fail only against the live Google endpoint, so it is worth asserting directly.

const KEY = `${"A".repeat(43)}=`;

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_REDIRECT_URI: "https://whendowe.example/oauth/google/callback",
  TOKEN_ENCRYPTION_KEY: KEY,
};

const noopStorage: StoragePort = {
  query: () => Promise.resolve([]),
  batch: () => Promise.resolve(),
};

it("maps each credential to the right field", () => {
  return buildOAuthDeps(loadConfig(GOOGLE_ENV), noopStorage).then((deps) => {
    expect(deps.clientId).toBe(GOOGLE_ENV.GOOGLE_CLIENT_ID);
    expect(deps.clientSecret).toBe(GOOGLE_ENV.GOOGLE_CLIENT_SECRET);
    expect(deps.redirectUri).toBe(GOOGLE_ENV.GOOGLE_REDIRECT_URI);
    expect(deps.ownerId).toBe(SINGLE_USER_OWNER_ID);
    expect(deps.storage).toBe(noopStorage);
  });
});

it("builds a working cipher from the configured key", async () => {
  const deps = await buildOAuthDeps(loadConfig(GOOGLE_ENV), noopStorage);
  const sealed = await deps.cipher.encrypt("a-refresh-token");
  expect(sealed).not.toContain("a-refresh-token");
  expect(await deps.cipher.decrypt(sealed)).toBe("a-refresh-token");
});

it("derives Secure cookies from the redirect URI scheme", async () => {
  const https = await buildOAuthDeps(loadConfig(GOOGLE_ENV), noopStorage);
  expect(https.secureCookies).toBe(true);

  const http = await buildOAuthDeps(
    loadConfig({
      ...GOOGLE_ENV,
      GOOGLE_REDIRECT_URI: "http://localhost:8080/oauth/google/callback",
    }),
    noopStorage,
  );
  expect(http.secureCookies).toBe(false);
});

it("provides an ISO clock and distinct ids", async () => {
  const deps = await buildOAuthDeps(loadConfig(GOOGLE_ENV), noopStorage);
  expect(deps.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(deps.newId()).not.toBe(deps.newId());
});

it("refuses a half-configured instance", async () => {
  // A deployment missing one of four secrets is a mistake, not a mode.
  const partial = loadConfig({ ...GOOGLE_ENV, GOOGLE_CLIENT_SECRET: undefined });
  await expect(buildOAuthDeps(partial, noopStorage)).rejects.toThrow(/GOOGLE_CLIENT_SECRET/);
});

// --- the presence predicate the adapters branch on ---

it("reports no Google configuration for a bare environment", () => {
  expect(anyGoogleOAuthConfigured(loadConfig({}))).toBe(false);
});

it("reports configuration when any single key is present", () => {
  // Each arm matters: the adapters use this to choose between "run without the
  // connect flow" and "fail loudly", so a missed arm would silently disable OAuth.
  expect(anyGoogleOAuthConfigured(loadConfig({ GOOGLE_CLIENT_ID: "x" }))).toBe(true);
  expect(anyGoogleOAuthConfigured(loadConfig({ GOOGLE_CLIENT_SECRET: "x" }))).toBe(true);
  expect(
    anyGoogleOAuthConfigured(loadConfig({ GOOGLE_REDIRECT_URI: "https://example.com/cb" })),
  ).toBe(true);
  expect(anyGoogleOAuthConfigured(loadConfig({ TOKEN_ENCRYPTION_KEY: KEY }))).toBe(true);
  expect(anyGoogleOAuthConfigured(loadConfig(GOOGLE_ENV))).toBe(true);
});
