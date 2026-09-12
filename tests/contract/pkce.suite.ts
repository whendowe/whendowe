// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { codeChallengeFor, createPkcePair, type RandomBytes } from "../../src/oauth/pkce.js";

// PKCE contract suite (DESIGN.md §9/§13): MUST pass on BOTH runtimes.
// Run by tests/contract/pkce.contract.test.ts (Node) and
// tests/workers/pkce.contract.test.ts (workerd).
//
// The challenge derivation goes through crypto.subtle.digest, so "platform-blind"
// is a claim until it runs on both — same reasoning as the token-cipher suite.

// RFC 7636 Appendix B. Pinning the spec's own published vector is the point: a
// round-trip test would only prove the implementation agrees with itself, and an
// S256 implementation that is self-consistently wrong still fails against Google.
const RFC_7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** Deterministic byte source, so a generated pair can be asserted exactly. */
function fixedRandomBytes(fill: number): RandomBytes {
  return (length: number) => new Uint8Array(length).fill(fill);
}

export function runPkceContract(): void {
  describe("PKCE", () => {
    it("matches the RFC 7636 Appendix B S256 vector", async () => {
      expect(await codeChallengeFor(RFC_7636_VERIFIER)).toBe(RFC_7636_CHALLENGE);
    });

    it("derives challenges deterministically", async () => {
      const first = await codeChallengeFor(RFC_7636_VERIFIER);
      const second = await codeChallengeFor(RFC_7636_VERIFIER);
      expect(first).toBe(second);
    });

    it("produces base64url output with no padding or unsafe characters", async () => {
      const pair = await createPkcePair();
      for (const value of [pair.verifier, pair.challenge]) {
        expect(value).toMatch(/^[A-Za-z0-9\-_]+$/);
        expect(value).not.toContain("=");
        expect(value).not.toContain("+");
        expect(value).not.toContain("/");
      }
    });

    it("generates a 43-character verifier and challenge", async () => {
      const pair = await createPkcePair();
      // 32 bytes → 43 base64url chars; SHA-256 is also 32 bytes.
      expect(pair.verifier).toHaveLength(43);
      expect(pair.challenge).toHaveLength(43);
      expect(pair.method).toBe("S256");
    });

    it("is reproducible from a fixed entropy source", async () => {
      const a = await createPkcePair(fixedRandomBytes(0x41));
      const b = await createPkcePair(fixedRandomBytes(0x41));
      expect(a).toEqual(b);
      // ...and different entropy gives a different pair, i.e. the source is used.
      const c = await createPkcePair(fixedRandomBytes(0x42));
      expect(c.verifier).not.toBe(a.verifier);
      expect(c.challenge).not.toBe(a.challenge);
    });

    it("never returns the verifier as the challenge (no `plain` fallback)", async () => {
      const pair = await createPkcePair();
      expect(pair.challenge).not.toBe(pair.verifier);
    });
  });
}
