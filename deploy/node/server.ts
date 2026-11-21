// SPDX-License-Identifier: AGPL-3.0-or-later
import { serve } from "@hono/node-server";
import { createClient } from "@libsql/client";
import {
  anyGoogleOAuthConfigured,
  type Config,
  capabilityConfigOf,
  loadConfig,
  mailCapOf,
} from "../../src/config.js";
import type { StoragePort } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { followingPass, followLog } from "../../src/following/follow.js";
import { runDueHeld } from "../../src/held.js";
import { cappedMailPort } from "../../src/mail/capped.js";
import { cloudflareRestMailPort } from "../../src/mail/cloudflare.js";
import { consoleMailPort } from "../../src/mail/console.js";
import { disabledMailPort, type MailPort } from "../../src/mail/port.js";
import { eraseDue } from "../../src/privacy/erasure.js";
import { retentionPass } from "../../src/privacy/purge.js";
import { isRetentionMinute } from "../../src/privacy/retention.js";
import { runTick, tickFailureLog, tickLog, ticksDue } from "../../src/reconcile/tick.js";
import { calendarGrants, createApp, heldRunners, reconnectMailer } from "../../src/web/app.js";
import type { AuthDeps } from "../../src/web/routes/auth.js";
import type { OAuthRouteDeps } from "../../src/web/routes/oauth.js";
import { buildOAuthDeps, pushTickPorts, tokenCipherFor } from "../../src/web/routes/oauth-deps.js";
import { nodePublicGet } from "./public-address.js";

// Node entry (DESIGN.md §8): the same Hono app object as the Cloudflare worker,
// served by @hono/node-server, with an in-process scheduler as the Node twin of the
// Worker's cron (§6): held actions, the purge pass, and the push tick (MVP-4 G2).
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
    cap: mailCapOf(c),
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

const auth: AuthDeps = {
  storage,
  mail: buildMail(config, storage),
  publicBaseUrl: config.PUBLIC_BASE_URL,
  secureCookies: new URL(config.PUBLIC_BASE_URL).protocol === "https:",
  now,
  // Calendar feed links (rc34): only with a key to keep them under.
  feedCipher:
    config.TOKEN_ENCRYPTION_KEY === undefined
      ? undefined
      : await tokenCipherFor(config.TOKEN_ENCRYPTION_KEY),
  // Capabilities (rc43): who may use what, and the operators who decide.
  capabilities: capabilityConfigOf(config),
};
// rc53: Google's push notifications (routes/hooks.ts) ask for a connection to be read; the
// minute's loop below reads them, so this process stays the only writer. A set: any number of
// pokes before the next minute are one read.
const poked = new Set<string>();
const app = createApp({
  auth,
  oauth,
  ...(config.GOOGLE_PUSH_CHANNELS === "on"
    ? {
        poke: (connectionId: string) => {
          poked.add(connectionId);
          return Promise.resolve();
        },
      }
    : {}),
});

// The pass (§10 rc21/rc22, rc46), each minute like the Worker's cron: held actions, then purge;
// retention hourly; then each connection's push tick, one after another (§11) — this one
// process is the single writer for every connection, as a Durable Object is on Workers.
// Passes never overlap: the next is scheduled when this one is done.
const PASS_INTERVAL_MS = 60_000;
const calendars = calendarGrants(oauth);
const runners = heldRunners(auth);
const mailReconnects = reconnectMailer(auth);
const tickPorts =
  oauth === undefined
    ? undefined
    : pushTickPorts(oauth, {
        publicBaseUrl: config.PUBLIC_BASE_URL,
        capabilities: capabilityConfigOf(config),
        pushChannels: config.GOOGLE_PUSH_CHANNELS === "on",
      });
/** Every connection due this minute, in turn; one failing doesn't stop the rest. */
async function pushTicks(at: string): Promise<void> {
  if (tickPorts === undefined) return;
  const due = await ticksDue(storage, at, Number.POSITIVE_INFINITY);
  // Poked since the last minute: read now, whether or not it is their turn (rc53).
  const asked = new Set(poked);
  poked.clear();
  for (const id of asked)
    if (!due.some((d) => d.connectionId === id)) due.push({ connectionId: id, pull: true });
  for (const { connectionId: id, pull: turn } of due) {
    const pull = turn || asked.has(id);
    try {
      const line = tickLog(id, await runTick(tickPorts, id, { pull }));
      if (line !== null) console.log(JSON.stringify(line));
    } catch (error) {
      console.error(JSON.stringify(tickFailureLog(id, error)));
    }
  }
}
/** A followed link's GET (rc57): every address the name has checked in the connection's lookup. */
const publicGet = nodePublicGet();

async function purgePass(): Promise<void> {
  try {
    const at = now();
    // rc46: actions held their minute, first — someone is waiting on them.
    const ran = await runDueHeld(storage, runners, at);
    if (ran > 0) console.log(JSON.stringify({ reason: "held_ran", count: ran }));
    const erased = await eraseDue(storage, { now: at, calendars });
    if (erased > 0) console.log(JSON.stringify({ reason: "accounts_erased", count: erased }));
    if (isRetentionMinute(at)) {
      const r = await retentionPass(storage, at);
      if (r.events + r.plans + r.sweeps > 0)
        console.log(JSON.stringify({ reason: "retention_purged", ...r }));
    }
    await pushTicks(at);
    // rc56: the followed calendars whose turn it is, each in its own minute of six hours.
    for (const { calendarId, refreshed } of await followingPass(storage, publicGet, at)) {
      const line = followLog(calendarId, refreshed);
      if (line !== null) console.log(JSON.stringify(line));
    }
    // rc40: one email to each account Google stopped answering for, the tick above included.
    const mailed = await mailReconnects(at);
    if (mailed.sent + mailed.failed > 0)
      console.log(JSON.stringify({ reason: "reconnect_mailed", ...mailed }));
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
