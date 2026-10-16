// SPDX-License-Identifier: AGPL-3.0-or-later

// UUIDv7 (RFC 9562 §5.7) for text primary keys, generated in app code — the
// convention src/db/schema.ts states. v7 rather than v4 because the leading 48 bits
// are a millisecond timestamp, so ids sort by creation time: change_log and index
// pages stay append-friendly, and an id alone tells you roughly when a row was made.
//
// Platform-blind: the WebCrypto CSPRNG global, never node:crypto (§16). Clock and
// entropy are injectable so the RFC's own example can be reproduced exactly in tests.
//
// Layout (128 bits):  unix_ts_ms:48 | ver=0111:4 | rand_a:12 | var=10:2 | rand_b:62

/** Injectable entropy, defaulting to the WebCrypto CSPRNG. */
export type RandomBytes = (length: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

const MAX_TIMESTAMP_MS = 2 ** 48 - 1;

function hex(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

/** A new UUIDv7 string, lowercase, 8-4-4-4-12. */
export function uuidv7(
  nowMs: number = Date.now(),
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIMESTAMP_MS) {
    throw new Error(`uuidv7 timestamp must be an integer in [0, 2^48), got ${nowMs}`);
  }

  const bytes = new Uint8Array(16);
  // 48-bit big-endian millisecond timestamp. Division rather than bit shifts:
  // JS bitwise operators truncate to 32 bits, which would corrupt the high bytes.
  let ts = nowMs;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }

  bytes.set(randomBytes(10).subarray(0, 10), 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // variant 10xx

  return `${hex(bytes, 0, 4)}-${hex(bytes, 4, 6)}-${hex(bytes, 6, 8)}-${hex(bytes, 8, 10)}-${hex(bytes, 10, 16)}`;
}

/** The millisecond timestamp embedded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  if (!UUIDV7_PATTERN.test(id)) {
    throw new Error("not a UUIDv7");
  }
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
