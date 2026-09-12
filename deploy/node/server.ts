// SPDX-License-Identifier: AGPL-3.0-or-later
import { serve } from "@hono/node-server";
import { createClient } from "@libsql/client";
import { anyGoogleOAuthConfigured, loadConfig } from "../../src/config.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { createApp } from "../../src/web/app.js";
import { buildOAuthDeps } from "../../src/web/oauth-deps.js";
import type { OAuthRouteDeps } from "../../src/web/oauth-routes.js";

// Node entry (DESIGN.md §8): the same Hono app object as the Cloudflare worker,
// served by @hono/node-server. The in-process scheduler (the Node twin of cron
// fan-out — §6) lands in M2 alongside runTick().
const config = loadConfig(process.env);

// Not configured at all → serve without the connect flow, so the M0 dual-deploy
// proof still boots on a bare checkout. Half configured → requireGoogleOAuth()
// inside buildOAuthDeps throws, naming the missing keys, because a deployment
// missing one of four secrets is a mistake rather than a mode.
let oauth: OAuthRouteDeps | undefined;
if (anyGoogleOAuthConfigured(config)) {
  oauth = await buildOAuthDeps(
    config,
    sqliteStoragePort(createClient({ url: config.DATABASE_URL })),
  );
}

const app = createApp(oauth);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(
    JSON.stringify({
      reason: "listening",
      port: info.port,
      milestone: "M1",
      connect_flow: oauth === undefined ? "disabled" : "enabled",
    }),
  );
});
