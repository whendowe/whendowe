// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { isEcho, pushNonce } from "../../src/reconcile/echo.js";

const cleanProjection = {
  recentWriteNonces: ["n1", "n2"],
  providerEtag: "etag-5",
  lastPushedHash: "hash-abc",
};

it("layer 1: a nonce in the ring is an echo", () => {
  expect(isEcho({ nonce: "n1", etag: null, contentHash: null }, cleanProjection)).toBe(true);
});

it("layer 2: a matching etag is an echo", () => {
  expect(isEcho({ nonce: null, etag: "etag-5", contentHash: null }, cleanProjection)).toBe(true);
});

it("layer 3: a matching content hash is an echo (metadata stripped)", () => {
  expect(isEcho({ nonce: null, etag: null, contentHash: "hash-abc" }, cleanProjection)).toBe(true);
});

it("a genuine external edit matches no layer", () => {
  expect(isEcho({ nonce: "other", etag: "etag-9", contentHash: "hash-xyz" }, cleanProjection)).toBe(
    false,
  );
});

it("null markers never match null projection state", () => {
  expect(
    isEcho(
      { nonce: null, etag: null, contentHash: null },
      { recentWriteNonces: [], providerEtag: null, lastPushedHash: null },
    ),
  ).toBe(false);
});

it("pushNonce evicts the oldest entry beyond the ring size", () => {
  let ring: readonly string[] = [];
  for (const n of ["a", "b", "c", "d", "e", "f"]) {
    ring = pushNonce(ring, n);
  }
  expect(ring).toEqual(["b", "c", "d", "e", "f"]);
});
