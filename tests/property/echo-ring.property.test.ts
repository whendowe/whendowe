// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { isEcho, NONCE_RING_SIZE, pushNonce } from "../../src/reconcile/echo.js";

// M0 scope: these properties prove the Hegel harness is wired and pin the nonce-ring
// behaviour that the §9 stale-echo-suppression property depends on. The full
// simulation state machine (fault-injecting fake provider + draw-loop) is M2 scope.

test("nonce ring is bounded and keeps exactly the newest nonces, in order", () =>
  hegel.test((tc) => {
    const nonces = tc.draw(gs.arrays(gs.integers())).map(String);

    let ring: readonly string[] = [];
    for (const nonce of nonces) {
      ring = pushNonce(ring, nonce);
    }

    if (ring.length > NONCE_RING_SIZE) {
      throw new Error(`ring exceeded capacity: ${ring.length} > ${NONCE_RING_SIZE}`);
    }
    const expected = nonces.slice(-NONCE_RING_SIZE);
    if (JSON.stringify(ring) !== JSON.stringify(expected)) {
      throw new Error(`ring ${JSON.stringify(ring)} != newest ${JSON.stringify(expected)}`);
    }
  }));

test("any of the last RING_SIZE written nonces is still recognized as an echo", () =>
  hegel.test((tc) => {
    // The stale-echo scenario (§11): notifications for recent writes may arrive
    // after later writes overwrote etag and hash — ring membership must still hold.
    const nonces = tc.draw(gs.arrays(gs.integers())).map((n) => `nonce-${n}`);

    let ring: readonly string[] = [];
    for (const nonce of nonces) {
      ring = pushNonce(ring, nonce);
    }

    const projection = {
      recentWriteNonces: ring,
      providerEtag: "etag-of-newest-write-only",
      lastPushedHash: "hash-of-newest-write-only",
    };
    for (const recent of nonces.slice(-NONCE_RING_SIZE)) {
      if (!isEcho({ nonce: recent, etag: null, contentHash: null }, projection)) {
        throw new Error(`stale echo not suppressed for recent nonce ${recent}`);
      }
    }
  }));
