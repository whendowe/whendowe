// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { bytesToBase64Url } from "../../src/crypto/base64.js";
import { readGoogleIdToken } from "../../src/oauth/identity.js";

// Who signed in with Google (DESIGN §13 rc20). The token is never signed here: the
// reader doesn't check signatures, because it only ever sees tokens that came straight
// from Google's token endpoint over TLS (OIDC Core §3.1.3.7).

const CLIENT_ID = "cid.apps.googleusercontent.com";
const NOW = 1_800_000_000;
const context = { clientId: CLIENT_ID, nowEpochSeconds: NOW };

const encode = (value: unknown) =>
  bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

function idToken(claims: Record<string, unknown> = {}): string {
  return [
    encode({ alg: "RS256", kid: "k" }),
    encode({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "1234567890",
      exp: NOW + 3600,
      email: "ann@gmail.com",
      email_verified: true,
      ...claims,
    }),
    "signature",
  ].join(".");
}

it("names a verified Gmail address", () => {
  expect(readGoogleIdToken(idToken(), context)).toEqual({
    kind: "authoritative",
    email: "ann@gmail.com",
  });
  // Older tokens spelled the flag as a string; the other issuer spelling is Google's too.
  expect(
    readGoogleIdToken(idToken({ email_verified: "true", iss: "accounts.google.com" }), context)
      .kind,
  ).toBe("authoritative");
});

it("vouches for a Workspace account, whose domain `hd` names", () => {
  expect(
    readGoogleIdToken(idToken({ email: "lea@example.org", hd: "example.org" }), context),
  ).toEqual({ kind: "authoritative", email: "lea@example.org" });
});

it("can't vouch for a mailbox Google doesn't host, however verified", () => {
  // A Google account made with an address elsewhere: verified once, at sign-up.
  expect(readGoogleIdToken(idToken({ email: "ann@old-job.example" }), context)).toEqual({
    kind: "not-authoritative",
    email: "ann@old-job.example",
  });
  // A look-alike domain is not Gmail.
  expect(readGoogleIdToken(idToken({ email: "ann@notgmail.com" }), context).kind).toBe(
    "not-authoritative",
  );
});

it("an address Google calls unverified, or none at all, names no one", () => {
  for (const claims of [
    { email_verified: false },
    { email_verified: "false" },
    { email_verified: undefined },
    { email: undefined },
  ]) {
    expect(readGoogleIdToken(idToken(claims), context)).toEqual({ kind: "unverified" });
  }
});

it("refuses a token from another issuer, for another client, or expired", () => {
  expect(() => readGoogleIdToken(idToken({ iss: "https://evil.example" }), context)).toThrow(
    /not from Google/,
  );
  expect(() => readGoogleIdToken(idToken({ aud: "someone-else" }), context)).toThrow(
    /another client/,
  );
  expect(readGoogleIdToken(idToken({ aud: ["x", CLIENT_ID] }), context).kind).toBe("authoritative");
  expect(() => readGoogleIdToken(idToken({ exp: NOW - 61 }), context)).toThrow(/expired/);
  // A minute of skew is tolerated.
  expect(readGoogleIdToken(idToken({ exp: NOW - 59 }), context).kind).toBe("authoritative");
});

it("refuses what isn't a JWT, and never repeats the token in its message", () => {
  const secret = "eyJhbGciOi.secret-looking-payload";
  for (const bad of ["", "a.b", "a..c", `a.${"%%%"}.c`, `a.${encode("not an object")}.c`, secret]) {
    expect(() => readGoogleIdToken(bad, context)).toThrow();
  }
  try {
    readGoogleIdToken(secret, context);
  } catch (error) {
    expect(String(error)).not.toContain("secret-looking-payload");
  }
});
