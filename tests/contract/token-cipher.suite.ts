// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createTokenCipher, type TokenKey } from "../../src/crypto/tokens.js";

// The token-cipher contract suite (DESIGN.md §9/§13): MUST pass on BOTH runtimes.
// tests/contract/token-cipher.contract.test.ts runs it under Node;
// tests/workers/token-cipher.contract.test.ts runs it inside workerd.
//
// The cipher is built on the WebCrypto global rather than node:crypto so it stays
// platform-blind (§16) — which is a claim, not a fact, until it is exercised on
// both. Same reasoning as the storage-port matrix next door.

// Two distinct 32-byte keys. Not real key material; the length is what matters.
const KEY_1: TokenKey = { id: 1, material: `${"A".repeat(43)}=` };
const KEY_2: TokenKey = { id: 2, material: `${"B".repeat(43)}=` };

const REFRESH_TOKEN = "1//0eXAMPLE-not-a-real-refresh-token_abcdefgh";

function decodeEnvelope(envelope: string): Uint8Array {
  const binary = atob(envelope);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeEnvelope(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function keyBytes(material: string): Uint8Array {
  return decodeEnvelope(material);
}

export function runTokenCipherContract(): void {
  describe("token cipher", () => {
    it("round-trips a refresh token", async () => {
      const cipher = await createTokenCipher([KEY_1], 1);
      const sealed = await cipher.encrypt(REFRESH_TOKEN);
      expect(sealed).not.toContain(REFRESH_TOKEN);
      expect(await cipher.decrypt(sealed)).toBe(REFRESH_TOKEN);
    });

    it("round-trips unicode and empty input", async () => {
      const cipher = await createTokenCipher([KEY_1], 1);
      for (const plaintext of ["", "réunion 会議 🗓️", "x".repeat(4096)]) {
        expect(await cipher.decrypt(await cipher.encrypt(plaintext))).toBe(plaintext);
      }
    });

    it("uses a fresh IV per encryption", async () => {
      const cipher = await createTokenCipher([KEY_1], 1);
      const a = await cipher.encrypt(REFRESH_TOKEN);
      const b = await cipher.encrypt(REFRESH_TOKEN);
      // IV reuse under one key is a total break of GCM, not a weakening of it.
      expect(a).not.toBe(b);
      expect(await cipher.decrypt(a)).toBe(REFRESH_TOKEN);
      expect(await cipher.decrypt(b)).toBe(REFRESH_TOKEN);
    });

    // Pins the on-the-wire envelope layout documented in src/crypto/tokens.ts:
    //   [ key id: 1 byte ][ IV: 12 bytes ][ ciphertext + GCM tag ]
    // The envelope is assembled here by hand from a FIXED key and a FIXED IV, so
    // there is no opaque pre-generated fixture to trust: if the layout changes,
    // or the two runtimes disagree about it, this fails. That matters because a
    // self-hosted instance's rows must stay readable if it moves to Cloudflare.
    it("decrypts an envelope assembled by hand to the documented layout", async () => {
      const iv = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes(KEY_1.material),
        { name: "AES-GCM" },
        false,
        ["encrypt"],
      );
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          new TextEncoder().encode(REFRESH_TOKEN),
        ),
      );

      const envelope = new Uint8Array(1 + iv.length + sealed.length);
      envelope[0] = KEY_1.id;
      envelope.set(iv, 1);
      envelope.set(sealed, 1 + iv.length);

      const cipher = await createTokenCipher([KEY_1], 1);
      expect(await cipher.decrypt(encodeEnvelope(envelope))).toBe(REFRESH_TOKEN);
    });

    it("writes the current key id into the envelope prefix", async () => {
      const cipher = await createTokenCipher([KEY_1, KEY_2], 2);
      expect(decodeEnvelope(await cipher.encrypt(REFRESH_TOKEN))[0]).toBe(2);
    });

    it("rejects a tampered ciphertext", async () => {
      const cipher = await createTokenCipher([KEY_1], 1);
      const bytes = decodeEnvelope(await cipher.encrypt(REFRESH_TOKEN));
      const last = bytes.length - 1;
      bytes[last] = (bytes[last] ?? 0) ^ 0x01;
      await expect(cipher.decrypt(encodeEnvelope(bytes))).rejects.toThrow(/decryption failed/);
    });

    it("rejects an envelope written under a key it does not hold", async () => {
      const writer = await createTokenCipher([KEY_2], 2);
      const reader = await createTokenCipher([KEY_1], 1);
      await expect(reader.decrypt(await writer.encrypt(REFRESH_TOKEN))).rejects.toThrow(
        /no token key for envelope key id 2/,
      );
    });

    // §13: "version-prefix ciphertexts (key id byte) so key rotation needs no
    // migration" — rotation is adding a key and moving the pointer, nothing more.
    it("decrypts old rows after the current key rotates", async () => {
      const before = await createTokenCipher([KEY_1], 1);
      const sealedUnderOldKey = await before.encrypt(REFRESH_TOKEN);

      const after = await createTokenCipher([KEY_1, KEY_2], 2);
      expect(await after.decrypt(sealedUnderOldKey)).toBe(REFRESH_TOKEN);
      expect(decodeEnvelope(await after.encrypt(REFRESH_TOKEN))[0]).toBe(2);
    });
  });
}
