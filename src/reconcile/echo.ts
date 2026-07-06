// SPDX-License-Identifier: AGPL-3.0-or-later

// 3-layer echo detection (DESIGN.md §11): a read-back of our own write must never
// be mistaken for a user edit. Layers, cheapest first: write-nonce ring membership,
// etag equality, content-hash equality. Any one true → suppress.
//
// Why a nonce RING, not a single nonce: two pushes in quick succession (A then B)
// can deliver A's notification after B's bookkeeping overwrote the stored nonce,
// etag, and hash. A single nonce misses all three layers, the stale read-back of A
// is applied inbound, and the system oscillates between A and B. Ring membership
// suppresses these stale echoes (§9 stale-echo property).

export const NONCE_RING_SIZE = 5;

/** Append a nonce, keeping only the newest `size` entries (oldest evicted first). */
export function pushNonce(
  ring: readonly string[],
  nonce: string,
  size: number = NONCE_RING_SIZE,
): readonly string[] {
  return [...ring, nonce].slice(-size);
}

export interface EchoMarkers {
  /** Write-nonce read back from provider metadata, if the provider preserved it. */
  readonly nonce: string | null;
  readonly etag: string | null;
  /** Hash of the incoming fields normalised to our fieldset. */
  readonly contentHash: string | null;
}

export interface ProjectionMarkers {
  readonly recentWriteNonces: readonly string[];
  readonly providerEtag: string | null;
  readonly lastPushedHash: string | null;
}

export function isEcho(incoming: EchoMarkers, projection: ProjectionMarkers): boolean {
  if (incoming.nonce !== null && projection.recentWriteNonces.includes(incoming.nonce)) {
    return true; // layer 1: write-nonce ring
  }
  if (incoming.etag !== null && incoming.etag === projection.providerEtag) {
    return true; // layer 2: etag
  }
  if (incoming.contentHash !== null && incoming.contentHash === projection.lastPushedHash) {
    return true; // layer 3: content hash (fallback when metadata is stripped)
  }
  return false;
}
