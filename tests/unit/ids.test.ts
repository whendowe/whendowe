// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { type RandomBytes, UUIDV7_PATTERN, uuidv7, uuidv7Timestamp } from "../../src/ids.js";

function bytes(...values: number[]): RandomBytes {
  return () => new Uint8Array(values);
}
const fill =
  (b: number): RandomBytes =>
  (n) =>
    new Uint8Array(n).fill(b);

it("reproduces the RFC 9562 Appendix A.6 example exactly", () => {
  // Timestamp 0x017F22E279B0 = Tue 2022-02-22 19:22:22.000 UTC, plus the RFC's own
  // random bits. Pinning the spec's vector, not just round-tripping our own output.
  const id = uuidv7(
    0x017f22e279b0,
    bytes(0x7c, 0xc3, 0x98, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f),
  );
  expect(id).toBe("017f22e2-79b0-7cc3-98c4-dc0c0c07398f");
});

it("forces version 7 and the RFC variant whatever the random bits are", () => {
  // The two cases where masking bugs show: all bits set, and no bits set.
  expect(uuidv7(0, fill(0xff))).toMatch(UUIDV7_PATTERN);
  expect(uuidv7(0, fill(0xff)).slice(14, 15)).toBe("7");
  expect(uuidv7(0, fill(0xff)).slice(19, 20)).toBe("b");
  expect(uuidv7(0, fill(0x00))).toBe("00000000-0000-7000-8000-000000000000");
});

it("round-trips the embedded millisecond timestamp, including high bits", () => {
  // Values past 2^32 catch the classic bug of shifting with 32-bit JS bit operators.
  for (const ms of [0, 1, 2 ** 32 - 1, 2 ** 32, 1_783_338_715_076, 2 ** 48 - 1]) {
    expect(uuidv7Timestamp(uuidv7(ms))).toBe(ms);
  }
});

it("sorts by creation time as plain strings", () => {
  const ids = [1_700_000_000_000, 1_700_000_000_001, 1_800_000_000_000].map((ms) => uuidv7(ms));
  expect([...ids].sort()).toEqual(ids);
});

it("produces distinct ids from the default CSPRNG", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(1_700_000_000_000)));
  expect(ids.size).toBe(1000);
});

it("rejects a timestamp outside 48 bits or not an integer", () => {
  expect(() => uuidv7(-1)).toThrow(/2\^48/);
  expect(() => uuidv7(2 ** 48)).toThrow(/2\^48/);
  expect(() => uuidv7(1.5)).toThrow(/2\^48/);
});

it("refuses to read a timestamp out of something that is not a UUIDv7", () => {
  expect(() => uuidv7Timestamp("not-a-uuid")).toThrow(/not a UUIDv7/);
  // A v4 UUID: right shape, wrong version nibble.
  expect(() => uuidv7Timestamp("550e8400-e29b-41d4-a716-446655440000")).toThrow(/not a UUIDv7/);
});
