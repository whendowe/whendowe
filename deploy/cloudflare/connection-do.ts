// SPDX-License-Identifier: AGPL-3.0-or-later
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { anyGoogleOAuthConfigured, capabilityConfigOf, loadConfig } from "../../src/config.js";
import { d1StoragePort } from "../../src/db/d1.js";
import { runTick, type TickPorts, tickFailureLog, tickLog } from "../../src/reconcile/tick.js";
import { PokeGate } from "../../src/reconcile/watch.js";
import { buildOAuthDeps, pushTickPorts } from "../../src/web/routes/oauth-deps.js";

// Durable Object per calendar_connection (DESIGN.md §11): the structural single writer. The
// cron fans out to it each minute (worker.ts) and it runs that connection's push tick, one at
// a time: a tick asked for while one is running is refused, and the next minute's cron asks
// again. It holds NO domain data (§16); all state lives in D1. It sets no alarms: a copy that
// failed waits for its retry_at, which decidePush checks on every tick, so the minute's cron
// is all the retrying needs — and an alarm would bill as a write (§11).

/** What the Durable Object reads from the Worker's bindings: storage and the Google client. */
export interface ConnectionEnv {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  PUBLIC_BASE_URL?: string;
  CAPABILITIES_DEFAULT?: string;
  OPERATOR_EMAILS?: string;
  GOOGLE_PUSH_CHANNELS?: string;
}

/** The one request the cron sends: tick this connection. */
export const tickRequestSchema = z.object({
  connectionId: z.string().min(1).max(64),
  /** rc53: read what changed in Google first. */
  pull: z.boolean().default(false),
  /** rc53: Google's push notification asked (routes/hooks.ts): read after a running tick. */
  poke: z.boolean().default(false),
});

/** The path the cron posts to; any host — a Durable Object stub routes by its id, not its URL. */
export const TICK_URL = "https://connection.do/tick";

export class ConnectionDO extends DurableObject<ConnectionEnv> {
  private ports: Promise<TickPorts | null> | undefined;
  /** Coalesces Google's pokes (rc53); in this object's memory only, so it writes nothing. */
  private readonly gate = new PokeGate();

  /** Built once per instance; null where Google isn't configured, so nothing can be pushed. */
  private tickPorts(): Promise<TickPorts | null> {
    this.ports ??= (async () => {
      const env = this.env;
      const config = loadConfig({
        GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI,
        TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
        PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
        CAPABILITIES_DEFAULT: env.CAPABILITIES_DEFAULT,
        OPERATOR_EMAILS: env.OPERATOR_EMAILS,
        GOOGLE_PUSH_CHANNELS: env.GOOGLE_PUSH_CHANNELS,
      });
      if (!anyGoogleOAuthConfigured(config)) return null;
      const oauth = await buildOAuthDeps(config, d1StoragePort(env.DB));
      return pushTickPorts(oauth, {
        publicBaseUrl: config.PUBLIC_BASE_URL,
        capabilities: capabilityConfigOf(config),
        pushChannels: config.GOOGLE_PUSH_CHANNELS === "on",
      });
    })();
    return this.ports;
  }

  override async fetch(request: Request): Promise<Response> {
    const asked = tickRequestSchema.safeParse(await request.json().catch(() => null));
    if (request.method !== "POST" || !asked.success) return new Response(null, { status: 400 });
    const id = asked.data.connectionId;
    // Decided before the first await: a second request can only arrive at an await (rc53
    // coalescing, reconcile/watch.ts).
    const go = this.gate.arrive(asked.data.poke);
    if (go === "busy") return Response.json({ outcome: "busy" }, { status: 409 });
    if (go !== "run") return Response.json({ outcome: go }, { status: 202 });
    try {
      const ports = await this.tickPorts();
      if (ports === null) return Response.json({ outcome: "unconfigured" }, { status: 503 });
      let result = await this.tick(ports, id, asked.data.pull);
      // Pokes that came while it ran — a change may have landed after its read began.
      while (this.gate.ended()) result = await this.tick(ports, id, true);
      return Response.json({ outcome: result.outcome });
    } catch (error) {
      console.error(JSON.stringify(tickFailureLog(id, error)));
      return new Response(null, { status: 500 });
    } finally {
      this.gate.release();
    }
  }

  private async tick(ports: TickPorts, id: string, pull: boolean) {
    const result = await runTick(ports, id, { pull });
    const line = tickLog(id, result);
    if (line !== null) console.log(JSON.stringify(line));
    return result;
  }
}
