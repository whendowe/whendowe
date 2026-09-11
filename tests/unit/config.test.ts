// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { loadConfig, requireGoogleOAuth } from "../../src/config.js";

// Base64 of 32 zero bytes: the shape TOKEN_ENCRYPTION_KEY demands. Obviously not
// a real key — if this fixture were the wrong length the "accepts" test below fails.
const VALID_KEY = `${"A".repeat(43)}=`;

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_REDIRECT_URI: "http://localhost:8080/oauth/google/callback",
  TOKEN_ENCRYPTION_KEY: VALID_KEY,
};

it("applies defaults for an empty environment", () => {
  const config = loadConfig({});
  expect(config.PORT).toBe(8080);
  expect(config.DATABASE_URL).toBe("file:data/whendowe.db");
  expect(config.LOG_LEVEL).toBe("info");
});

it("coerces PORT from string", () => {
  expect(loadConfig({ PORT: "3000" }).PORT).toBe(3000);
});

it("rejects an invalid PORT loudly", () => {
  expect(() => loadConfig({ PORT: "not-a-port" })).toThrow();
  expect(() => loadConfig({ PORT: "70000" })).toThrow();
});

it("rejects an invalid LOG_LEVEL loudly", () => {
  expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow();
});

// --- Google OAuth (DESIGN.md §12) + token encryption key (§13) ---

it("boots with no Google credentials at all", () => {
  // The M0 hello-page targets and an instance with nothing connected yet are
  // both legitimate states; absent credentials must not fail the parse.
  const config = loadConfig({});
  expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
  expect(config.TOKEN_ENCRYPTION_KEY).toBeUndefined();
});

it("accepts a fully configured Google environment", () => {
  const config = loadConfig(GOOGLE_ENV);
  expect(requireGoogleOAuth(config)).toEqual(GOOGLE_ENV);
});

it("requireGoogleOAuth names every missing key at once", () => {
  const config = loadConfig({});
  expect(() => requireGoogleOAuth(config)).toThrow(
    /GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET.*GOOGLE_REDIRECT_URI.*TOKEN_ENCRYPTION_KEY/,
  );
});

it("requireGoogleOAuth reports only the keys actually missing", () => {
  const config = loadConfig({ ...GOOGLE_ENV, GOOGLE_CLIENT_SECRET: undefined });
  expect(() => requireGoogleOAuth(config)).toThrow(/GOOGLE_CLIENT_SECRET/);
  expect(() => requireGoogleOAuth(config)).not.toThrow(/GOOGLE_CLIENT_ID/);
});

it("rejects a redirect URI with a missing or non-http scheme", () => {
  // "localhost:8080/cb" parses — as protocol "localhost:". Bare z.url() takes it.
  expect(() => loadConfig({ ...GOOGLE_ENV, GOOGLE_REDIRECT_URI: "localhost:8080/cb" })).toThrow();
  expect(() => loadConfig({ ...GOOGLE_ENV, GOOGLE_REDIRECT_URI: "javascript:alert(1)" })).toThrow();
});

it("rejects a redirect URI that does not parse as a URL at all", () => {
  expect(() => loadConfig({ ...GOOGLE_ENV, GOOGLE_REDIRECT_URI: "" })).toThrow();
  expect(() => loadConfig({ ...GOOGLE_ENV, GOOGLE_REDIRECT_URI: "://nope" })).toThrow();
});

it("rejects a token key that is valid base64 but not 32 bytes", () => {
  expect(() => loadConfig({ ...GOOGLE_ENV, TOKEN_ENCRYPTION_KEY: "AAAA" })).toThrow();
});

it("rejects a token key that is not base64 at all", () => {
  expect(() => loadConfig({ ...GOOGLE_ENV, TOKEN_ENCRYPTION_KEY: "not base64 !!!" })).toThrow();
});

it("never puts a secret value into a config error message (§13)", () => {
  // Boot-time config errors get logged. A zod error that echoes the rejected
  // input would put the client secret / token key straight into the log.
  const secret = "SUPERSECRET-client-secret-value";
  const key = "SUPERSECRET-token-key-value";
  let message = "";
  try {
    loadConfig({ ...GOOGLE_ENV, GOOGLE_CLIENT_SECRET: secret, TOKEN_ENCRYPTION_KEY: key });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toBe("");
  expect(message).not.toContain(secret);
  expect(message).not.toContain(key);
});
