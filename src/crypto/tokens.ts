// SPDX-License-Identifier: AGPL-3.0-or-later
import { base64ToBytes, bytesToBase64 } from "./base64.js";

// OAuth token encryption at rest (DESIGN.md §13). The refresh tokens are the
// crown jewels: whoever can read them can read every user's calendar, so they
// never touch the database in plaintext.
//
// Deliberately uses the WebCrypto GLOBAL, not node:crypto — domain code stays
// platform-blind (§16), and `crypto.subtle` is the one primitive both workerd and
// Node 22 expose under the same name.
//
// Envelope layout, base64-encoded:
//
//     [ key id: 1 byte ][ IV: 12 bytes ][ ciphertext + GCM tag ]
//
// The leading key id is §13's "version-prefix ciphertexts (key id byte) so key
// rotation needs no migration": a cipher can hold several keys, decrypt rows
// written under any of them, and write new rows under the current one. Rotation
// is therefore a config change plus a lazy re-encrypt — never a schema change.

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const GCM_TAG_BYTES = 16;
const MIN_ENVELOPE_BYTES = 1 + IV_BYTES + GCM_TAG_BYTES;
const MIN_KEY_ID = 0;
const MAX_KEY_ID = 255; // it is one byte

// The key handle type, derived from the API rather than named directly:
// `CryptoKey` is a DOM global, and this tsconfig deliberately ships lib ES2023
// with only node types, so naming it would mean either widening the lib (pulling
// browser globals into platform-blind code) or importing from node:crypto (a
// platform import, §16). Deriving it commits to neither and resolves correctly
// under both runtimes.
type SubtleKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** One key in the ring. `material` is base64 of exactly 32 bytes. */
export interface TokenKey {
  readonly id: number;
  readonly material: string;
}

export interface TokenCipher {
  /** Encrypt under the current key. Output is safe to store in a text column. */
  encrypt(plaintext: string): Promise<string>;
  /** Decrypt a value written under any key in the ring. */
  decrypt(envelope: string): Promise<string>;
}

async function importKey(material: string, keyId: number): Promise<SubtleKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(material);
  } catch {
    throw new Error(`token key ${keyId} is not valid base64`);
  }
  if (raw.length !== KEY_BYTES) {
    // Length only — never the material itself (§13/§14).
    throw new Error(`token key ${keyId} must be ${KEY_BYTES} bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Build a cipher over a key ring. `currentKeyId` selects the key new ciphertexts
 * are written under; every key in `keys` remains available for decryption.
 *
 * Throws on a malformed ring — a bad key should fail at boot, not at the first
 * token write (same reasoning as the config-level length check in src/config.ts).
 */
export async function createTokenCipher(
  keys: readonly TokenKey[],
  currentKeyId: number,
): Promise<TokenCipher> {
  if (keys.length === 0) {
    throw new Error("token cipher needs at least one key");
  }

  const imported = new Map<number, SubtleKey>();
  for (const key of keys) {
    if (!Number.isInteger(key.id) || key.id < MIN_KEY_ID || key.id > MAX_KEY_ID) {
      throw new Error(`token key id must be an integer ${MIN_KEY_ID}–${MAX_KEY_ID}, got ${key.id}`);
    }
    if (imported.has(key.id)) {
      throw new Error(`duplicate token key id ${key.id}`);
    }
    imported.set(key.id, await importKey(key.material, key.id));
  }

  const current = imported.get(currentKeyId);
  if (current === undefined) {
    throw new Error(`current token key id ${currentKeyId} is not in the key ring`);
  }

  return {
    async encrypt(plaintext: string): Promise<string> {
      // Fresh IV per encryption — reusing one under the same key is a total
      // break of GCM, not a weakening of it.
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        current,
        new TextEncoder().encode(plaintext),
      );
      const sealedBytes = new Uint8Array(sealed);

      const envelope = new Uint8Array(1 + IV_BYTES + sealedBytes.length);
      envelope[0] = currentKeyId;
      envelope.set(iv, 1);
      envelope.set(sealedBytes, 1 + IV_BYTES);
      return bytesToBase64(envelope);
    },

    async decrypt(envelope: string): Promise<string> {
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(envelope);
      } catch {
        throw new Error("token envelope is not valid base64");
      }
      if (bytes.length < MIN_ENVELOPE_BYTES) {
        throw new Error("token envelope is truncated");
      }

      const keyId = bytes[0];
      if (keyId === undefined) {
        throw new Error("token envelope is truncated");
      }
      const key = imported.get(keyId);
      if (key === undefined) {
        // The key id is not a secret; naming it is what makes a failed rotation
        // diagnosable instead of mysterious.
        throw new Error(`no token key for envelope key id ${keyId}`);
      }

      const iv = bytes.slice(1, 1 + IV_BYTES);
      const sealed = bytes.slice(1 + IV_BYTES);
      try {
        const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed);
        return new TextDecoder().decode(opened);
      } catch {
        // GCM authentication failure: wrong key, or the stored bytes were
        // tampered with. Deliberately opaque — no plaintext, no key, no
        // ciphertext in the message (§13/§14).
        throw new Error(`token decryption failed under key id ${keyId}`);
      }
    },
  };
}
