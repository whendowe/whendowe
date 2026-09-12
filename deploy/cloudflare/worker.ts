// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Hono } from "hono";
import { anyGoogleOAuthConfigured, loadConfig } from "../../src/config.js";
import { d1StoragePort } from "../../src/db/d1.js";
import { createApp } from "../../src/web/app.js";
import { buildOAuthDeps } from "../../src/web/oauth-deps.js";

export { ConnectionDO } from "./connection-do.js";

// Cloudflare entry (DESIGN.md §8): Hono fetch + scheduled handler. This adapter is
// one of the only platform-aware files; domain code stays platform-blind.
export interface Env {
  DB: D1Database;
  CONNECTION_DO: DurableObjectNamespace;
  // Secrets via `wrangler secret`, never wrangler.jsonc (§13). Absent on an
  // instance that has not connected a calendar yet, which is a valid state.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  LOG_LEVEL?: string;
}

// Built lazily because bindings only exist per-request, then cached for the life of
// the isolate: constructing the cipher imports a key, which is async and need not
// repeat. The fields are copied out of Env explicitly rather than passing Env to
// loadConfig() — Env holds bindings as well as strings, and AGENTS.md forbids the
// cast that would paper over that.
let cachedApp: Promise<Hono> | undefined;

async function buildApp(env: Env): Promise<Hono> {
  const config = loadConfig({
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI,
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
    LOG_LEVEL: env.LOG_LEVEL,
  });

  if (!anyGoogleOAuthConfigured(config)) {
    return createApp();
  }
  return createApp(await buildOAuthDeps(config, d1StoragePort(env.DB)));
}

function getApp(env: Env): Promise<Hono> {
  cachedApp ??= buildApp(env);
  return cachedApp;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = await getApp(env);
    return app.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // M2: fan out to one ConnectionDO per active calendar_connection (§11).
    // Cron is the only scheduler of regular ticks — never per-tick DO alarms (§16).
    console.log(JSON.stringify({ reason: "tick_noop", milestone: "M1" }));
  },
};
