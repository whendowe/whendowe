// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { isEcho, parseRing, pushWrite, type Written } from "../../src/reconcile/echo.js";

const cleanProjection = {
  recentWrites: [
    ["n1", "etag-1"],
    ["n2", "etag-5"],
  ] satisfies Written[],
  providerEtag: "etag-5",
  lastPushedHash: "hash-abc",
};

it("layer 1: one of our writes in the ring, nonce and etag both, is an echo", () => {
  expect(isEcho({ nonce: "n1", etag: "etag-1", contentHash: null }, cleanProjection)).toBe(true);
});

it("rc53: our nonce with an etag our write didn't make is a person's edit in Google", () => {
  // Google keeps the hidden properties through their edit, so our last nonce survives it.
  expect(isEcho({ nonce: "n2", etag: "etag-6", contentHash: null }, cleanProjection)).toBe(false);
  expect(isEcho({ nonce: "n1", etag: null, contentHash: null }, cleanProjection)).toBe(false);
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
      { recentWrites: [], providerEtag: null, lastPushedHash: null },
    ),
  ).toBe(false);
});

it("pushWrite evicts the oldest entry beyond the ring size", () => {
  let ring: readonly Written[] = [];
  for (const n of ["a", "b", "c", "d", "e", "f"]) {
    ring = pushWrite(ring, [n, `etag-${n}`]);
  }
  expect(ring.map(([n]) => n)).toEqual(["b", "c", "d", "e", "f"]);
});

it("a ring from before rc53 holds bare nonces, which recognise nothing; junk is no ring", () => {
  expect(parseRing(JSON.stringify(["n1", ["n2", "etag-2"], "n3"]))).toEqual([["n2", "etag-2"]]);
  for (const junk of ["", "{", '{"n1":1}', "null", "[[1,2]]"]) expect(parseRing(junk)).toEqual([]);
});
