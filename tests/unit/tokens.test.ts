// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createTokenCipher, type TokenKey } from "../../src/crypto/tokens.js";

// The cross-runtime behaviour (round-trip, envelope layout, tampering, rotation)
// lives in tests/contract/token-cipher.suite.ts and runs on BOTH Node and workerd.
// What stays here is runtime-independent: key-ring validation, malformed input,
// and log hygiene.

const KEY_1: TokenKey = { id: 1, material: `${"A".repeat(43)}=` };
const KEY_2: TokenKey = { id: 2, material: `${"B".repeat(43)}=` };

const REFRESH_TOKEN = "1//0eXAMPLE-not-a-real-refresh-token_abcdefgh";

function encodeEnvelope(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function decodeEnvelope(envelope: string): Uint8Array {
  const binary = atob(envelope);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

it("round-trips randomised inputs", async () => {
  const cipher = await createTokenCipher([KEY_1], 1);
  for (let i = 0; i < 100; i += 1) {
    const length = Math.floor(Math.random() * 200);
    const plaintext = Array.from({ length }, () =>
      String.fromCodePoint(Math.floor(Math.random() * 0x2ff) + 1),
    ).join("");
    expect(await cipher.decrypt(await cipher.encrypt(plaintext))).toBe(plaintext);
  }
});

it("rejects a malformed or truncated envelope", async () => {
  const cipher = await createTokenCipher([KEY_1], 1);
  await expect(cipher.decrypt("not base64 !!!")).rejects.toThrow(/not valid base64/);
  await expect(cipher.decrypt(encodeEnvelope(new Uint8Array([1, 2, 3])))).rejects.toThrow(
    /truncated/,
  );
});

// A bad key ring should fail at boot, not at the first token write — same
// reasoning as the TOKEN_ENCRYPTION_KEY length check in src/config.ts.
it("rejects an empty key ring", async () => {
  await expect(createTokenCipher([], 1)).rejects.toThrow(/at least one key/);
});

it("rejects duplicate key ids", async () => {
  await expect(createTokenCipher([KEY_1, { id: 1, material: KEY_2.material }], 1)).rejects.toThrow(
    /duplicate token key id 1/,
  );
});

it("rejects a key id outside one byte", async () => {
  await expect(createTokenCipher([{ id: 256, material: KEY_1.material }], 256)).rejects.toThrow(
    /key id must be an integer/,
  );
  await expect(createTokenCipher([{ id: -1, material: KEY_1.material }], -1)).rejects.toThrow(
    /key id must be an integer/,
  );
  await expect(createTokenCipher([{ id: 1.5, material: KEY_1.material }], 1.5)).rejects.toThrow(
    /key id must be an integer/,
  );
});

it("rejects key material of the wrong length or encoding", async () => {
  await expect(createTokenCipher([{ id: 1, material: "AAAA" }], 1)).rejects.toThrow(
    /must be 32 bytes, got 3/,
  );
  await expect(createTokenCipher([{ id: 1, material: "not base64 !!!" }], 1)).rejects.toThrow(
    /not valid base64/,
  );
});

it("rejects a current key id absent from the ring", async () => {
  await expect(createTokenCipher([KEY_1], 9)).rejects.toThrow(/current token key id 9/);
});

it("never puts key material or plaintext into an error message (§13)", async () => {
  const cipher = await createTokenCipher([KEY_1], 1);
  const bytes = decodeEnvelope(await cipher.encrypt(REFRESH_TOKEN));
  const last = bytes.length - 1;
  bytes[last] = (bytes[last] ?? 0) ^ 0xff;

  let message = "";
  try {
    await cipher.decrypt(encodeEnvelope(bytes));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toBe("");
  expect(message).not.toContain(REFRESH_TOKEN);
  expect(message).not.toContain(KEY_1.material);
});
