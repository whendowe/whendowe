// SPDX-License-Identifier: AGPL-3.0-or-later
import { serve } from "@hono/node-server";
import { loadConfig } from "../../src/config.js";
import { createApp } from "../../src/web/app.js";

// Node entry (DESIGN.md §8): the same Hono app object as the Cloudflare worker,
// served by @hono/node-server. The in-process scheduler (the Node twin of cron
// fan-out — §6) lands in M2 alongside runTick().
const config = loadConfig(process.env);
const app = createApp();

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(JSON.stringify({ reason: "listening", port: info.port, milestone: "M0" }));
});
