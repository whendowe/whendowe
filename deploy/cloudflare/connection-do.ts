// SPDX-License-Identifier: AGPL-3.0-or-later
import { DurableObject } from "cloudflare:workers";

// Durable Object per calendar_connection (DESIGN.md §11): the structural
// single-writer — it serializes every PULL/PUSH for its connection and owns its
// retry alarms. It holds NO domain data (§16); all state lives in D1. Overlapping
// ticks are impossible by construction, not prevented by locks. Wired up in M2.
export class ConnectionDO extends DurableObject {
  override async fetch(_request: Request): Promise<Response> {
    return new Response("ConnectionDO lands in M2 (DESIGN.md §15)", { status: 501 });
  }

  override async alarm(): Promise<void> {
    // M2: retry backoff for projections in 'error' with retry_at (§12).
  }
}
