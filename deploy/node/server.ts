// SPDX-License-Identifier: AGPL-3.0-or-later
import { serve } from "@hono/node-server";
import { createClient } from "@libsql/client";
import { anyGoogleOAuthConfigured, type Config, loadConfig } from "../../src/config.js";
import type { StoragePort } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { cappedMailPort } from "../../src/mail/capped.js";
import { cloudflareRestMailPort } from "../../src/mail/cloudflare.js";
import { consoleMailPort } from "../../src/mail/console.js";
import { disabledMailPort, type MailPort } from "../../src/mail/port.js";
import { eraseDue } from "../../src/privacy/erasure.js";
import { calendarRevoker, createApp } from "../../src/web/app.js";
import type { OAuthRouteDeps } from "../../src/web/routes/oauth.js";
import { buildOAuthDeps } from "../../src/web/routes/oauth-deps.js";

// Node entry (DESIGN.md §8): the same Hono app object as the Cloudflare worker,
// served by @hono/node-server, with an in-process scheduler as the Node twin of the
// Worker's cron (§6). Today it runs the purge pass; runTick() joins it in MVP-4.
const config = loadConfig(process.env);
const storage = sqliteStoragePort(createClient({ url: config.DATABASE_URL }));
const now = () => new Date().toISOString();

/** The provider for this target, ALWAYS behind the cap (DESIGN §13 rc9). */
function buildMail(c: Config, s: StoragePort): MailPort {
  let inner: MailPort;
  switch (c.MAIL_PROVIDER) {
    case "disabled":
      // Fail closed: refuse rather than print tokens into logs (src/mail/port.ts).
      return disabledMailPort;
    case "console":
      inner = consoleMailPort();
      break;
    case "cloudflare":
      if (
        c.MAIL_FROM_ADDRESS === undefined ||
        c.CLOUDFLARE_ACCOUNT_ID === undefined ||
        c.CLOUDFLARE_EMAIL_API_TOKEN === undefined
      ) {
        throw new Error(
          "MAIL_PROVIDER=cloudflare on Node needs MAIL_FROM_ADDRESS, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN",
        );
      }
      inner = cloudflareRestMailPort({
        accountId: c.CLOUDFLARE_ACCOUNT_ID,
        apiToken: c.CLOUDFLARE_EMAIL_API_TOKEN,
        from: { address: c.MAIL_FROM_ADDRESS, name: c.MAIL_FROM_NAME },
      });
      break;
  }
  return cappedMailPort(inner, s, {
    cap: { daily: c.MAIL_DAILY_CAP, monthly: c.MAIL_MONTHLY_CAP },
    now,
  });
}

// Google connect: not configured at all → absent; half configured → buildOAuthDeps
// throws naming the missing keys (a deployment missing one of four secrets is a
// mistake, not a mode).
let oauth: OAuthRouteDeps | undefined;
if (anyGoogleOAuthConfigured(config)) {
  oauth = await buildOAuthDeps(config, storage);
}

const app = createApp({
  auth: {
    storage,
    mail: buildMail(config, storage),
    publicBaseUrl: config.PUBLIC_BASE_URL,
    secureCookies: new URL(config.PUBLIC_BASE_URL).protocol === "https:",
    now,
  },
  oauth,
});

// The purge pass (§10 rc21/rc22), each minute like the Worker's cron. Ticks never
// overlap: the next is scheduled when this one is done.
const PASS_INTERVAL_MS = 60_000;
const revokeCalendars = calendarRevoker(oauth);
async function purgePass(): Promise<void> {
  try {
    const erased = await eraseDue(storage, { now: now(), revokeCalendars });
    if (erased > 0) console.log(JSON.stringify({ reason: "accounts_erased", count: erased }));
  } catch (error) {
    console.error(JSON.stringify({ reason: "purge_pass_failed", error: String(error) }));
  }
  setTimeout(() => void purgePass(), PASS_INTERVAL_MS).unref();
}
setTimeout(() => void purgePass(), PASS_INTERVAL_MS).unref();

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(
    JSON.stringify({
      reason: "listening",
      port: info.port,
      milestone: "MVP-1",
      mail: config.MAIL_PROVIDER,
      connect_flow: oauth === undefined ? "disabled" : "enabled",
    }),
  );
});
