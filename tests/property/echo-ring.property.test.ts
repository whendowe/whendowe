// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { isEcho, NONCE_RING_SIZE, pushWrite, type Written } from "../../src/reconcile/echo.js";
import { propertySettings } from "./budget.js";

// M0 scope: these properties prove the Hegel harness is wired and pin the nonce-ring
// behaviour that the §9 stale-echo-suppression property depends on. The full
// simulation state machine (fault-injecting fake provider + draw-loop) is M2 scope.

test("nonce ring is bounded and keeps exactly the newest nonces, in order", () =>
  hegel.test((tc) => {
    const nonces = tc.draw(gs.arrays(gs.integers())).map(String);

    let ring: readonly Written[] = [];
    for (const nonce of nonces) {
      ring = pushWrite(ring, [nonce, `etag-${nonce}`]);
    }

    if (ring.length > NONCE_RING_SIZE) {
      throw new Error(`ring exceeded capacity: ${ring.length} > ${NONCE_RING_SIZE}`);
    }
    const expected = nonces.slice(-NONCE_RING_SIZE);
    if (JSON.stringify(ring.map(([n]) => n)) !== JSON.stringify(expected)) {
      throw new Error(`ring ${JSON.stringify(ring)} != newest ${JSON.stringify(expected)}`);
    }
  }, propertySettings));

test("any of the last RING_SIZE writes is still recognized as an echo; their nonce on a new etag is not", () =>
  hegel.test((tc) => {
    // The stale-echo scenario (§11): notifications for recent writes may arrive
    // after later writes overwrote etag and hash — ring membership must still hold.
    const nonces = tc.draw(gs.arrays(gs.integers())).map((n) => `nonce-${n}`);

    let ring: readonly Written[] = [];
    for (const nonce of nonces) {
      ring = pushWrite(ring, [nonce, `etag-of-${nonce}`]);
    }

    const projection = {
      recentWrites: ring,
      providerEtag: "etag-of-newest-write-only",
      lastPushedHash: "hash-of-newest-write-only",
    };
    for (const recent of nonces.slice(-NONCE_RING_SIZE)) {
      if (!isEcho({ nonce: recent, etag: `etag-of-${recent}`, contentHash: null }, projection)) {
        throw new Error(`stale echo not suppressed for recent nonce ${recent}`);
      }
      // rc53: Google keeps our nonce through a person's edit; the etag their edit made is new.
      if (isEcho({ nonce: recent, etag: `edited-${recent}`, contentHash: null }, projection)) {
        throw new Error(`a person's edit carrying our nonce ${recent} was taken for an echo`);
      }
    }
  }, propertySettings));
