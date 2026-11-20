// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// 3-layer echo detection (DESIGN.md §11): a read-back of our own write must never
// be mistaken for a user edit. Layers, cheapest first: our write's (nonce, etag) pair in
// the ring, etag equality, content-hash equality. Any one true → suppress.
//
// Why a RING, not the last write only: two pushes in quick succession (A then B) can
// deliver A's notification after B's bookkeeping overwrote the stored etag and hash. With
// only B's, the stale read-back of A is applied inbound, and the system oscillates between
// A and B. Ring membership suppresses these stale echoes (§9 stale-echo property).
//
// Why the nonce WITH its write's etag (rc53), not the nonce alone: Google keeps the hidden
// properties a write stamps when a person later edits the event there — it must, or the
// canonical id couldn't find the copy again. So their edit carries the nonce of our last
// write, and a nonce-only test would throw it away. Their edit changes the etag; a stale
// read-back of our own write still has the etag that write made.

export const NONCE_RING_SIZE = 5;

/** One of our writes: the nonce we stamped, and the etag the provider gave that write. */
export type Written = readonly [nonce: string, etag: string];

/**
 * The stored ring, read leniently: a ring written before rc53 holds bare nonces, which name no
 * write's etag and so recognise nothing. Anything unreadable is no ring at all.
 */
export function parseRing(stored: string): readonly Written[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return [];
  }
  const ring = z.array(z.unknown()).safeParse(raw);
  if (!ring.success) return [];
  return ring.data.flatMap((entry) => {
    const pair = z.tuple([z.string(), z.string()]).safeParse(entry);
    return pair.success ? [pair.data] : [];
  });
}

/** Append a write, keeping only the newest `size` entries (oldest evicted first). */
export function pushWrite(
  ring: readonly Written[],
  written: Written,
  size: number = NONCE_RING_SIZE,
): readonly Written[] {
  return [...ring, written].slice(-size);
}

export interface EchoMarkers {
  /** Write-nonce read back from provider metadata, if the provider preserved it. */
  readonly nonce: string | null;
  readonly etag: string | null;
  /** Hash of the incoming fields normalised to our fieldset. */
  readonly contentHash: string | null;
}

export interface ProjectionMarkers {
  readonly recentWrites: readonly Written[];
  readonly providerEtag: string | null;
  readonly lastPushedHash: string | null;
}

export function isEcho(incoming: EchoMarkers, projection: ProjectionMarkers): boolean {
  if (
    incoming.nonce !== null &&
    incoming.etag !== null &&
    projection.recentWrites.some(([n, e]) => n === incoming.nonce && e === incoming.etag)
  ) {
    return true; // layer 1: one of our recent writes, nonce and etag both
  }
  if (incoming.etag !== null && incoming.etag === projection.providerEtag) {
    return true; // layer 2: etag
  }
  if (incoming.contentHash !== null && incoming.contentHash === projection.lastPushedHash) {
    return true; // layer 3: content hash (fallback when metadata is stripped)
  }
  return false;
}
