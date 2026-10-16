// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import type { RandomBytes } from "../../src/ids.js";
import { csrfTokenFor, hashToken, issueToken } from "../../src/people/tokens.js";

const fill =
  (b: number): RandomBytes =>
  (n) =>
    new Uint8Array(n).fill(b);

it("hashes with SHA-256, base64url-encoded (FIPS 180-2 'abc' vector)", async () => {
  // SHA-256("abc") = ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad
  expect(await hashToken("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
});

it("issues a 256-bit token and the hash that will be stored instead of it", async () => {
  const issued = await issueToken();
  expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(issued.hash).toBe(await hashToken(issued.token));
  // The stored value must not reveal the token it came from.
  expect(issued.hash).not.toContain(issued.token);
});

it("is deterministic for a fixed entropy source and distinct otherwise", async () => {
  expect(await issueToken(fill(7))).toEqual(await issueToken(fill(7)));
  const tokens = new Set<string>();
  for (let i = 0; i < 200; i += 1) tokens.add((await issueToken()).token);
  expect(tokens.size).toBe(200);
});

it("derives a per-session CSRF token that is never the stored session hash", async () => {
  const { token, hash } = await issueToken(fill(1));
  const csrf = await csrfTokenFor(token);
  // Domain separation: if these matched, the CSRF value rendered into every form
  // would also be the exact lookup key sitting in the session table.
  expect(csrf).not.toBe(hash);
  expect(await csrfTokenFor(token)).toBe(csrf);
  expect(await csrfTokenFor((await issueToken(fill(2))).token)).not.toBe(csrf);
});
