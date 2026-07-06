// SPDX-License-Identifier: AGPL-3.0-or-later
import { createApp } from "../../src/web/app.js";

export { ConnectionDO } from "./connection-do.js";

// Cloudflare entry (DESIGN.md §8): Hono fetch + scheduled handler. This adapter is
// one of the only platform-aware files; domain code stays platform-blind.
export interface Env {
  DB: D1Database;
  CONNECTION_DO: DurableObjectNamespace;
}

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // M2: fan out to one ConnectionDO per active calendar_connection (§11).
    // Cron is the only scheduler of regular ticks — never per-tick DO alarms (§16).
    console.log(JSON.stringify({ reason: "tick_noop", milestone: "M0" }));
  },
};
