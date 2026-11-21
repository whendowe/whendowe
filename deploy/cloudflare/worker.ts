// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Hono } from "hono";
import {
  anyGoogleOAuthConfigured,
  type Config,
  capabilityConfigOf,
  loadConfig,
  mailCapOf,
} from "../../src/config.js";
import { d1StoragePort } from "../../src/db/d1.js";
import type { StoragePort } from "../../src/db/port.js";
import { followingPass, followLog } from "../../src/following/follow.js";
import { type HeldRunners, runDueHeld } from "../../src/held.js";
import { cappedMailPort } from "../../src/mail/capped.js";
import { cloudflareBindingMailPort, type EmailBindingLike } from "../../src/mail/cloudflare.js";
import { consoleMailPort } from "../../src/mail/console.js";
import { disabledMailPort, type MailPort } from "../../src/mail/port.js";
import { type CalendarGrants, eraseDue } from "../../src/privacy/erasure.js";
import { retentionPass } from "../../src/privacy/purge.js";
import { isRetentionMinute } from "../../src/privacy/retention.js";
import { tickFailureLog, ticksDue } from "../../src/reconcile/tick.js";
import { calendarGrants, createApp, heldRunners, reconnectMailer } from "../../src/web/app.js";
import type { AuthDeps } from "../../src/web/routes/auth.js";
import { buildOAuthDeps, tokenCipherFor } from "../../src/web/routes/oauth-deps.js";
import type { AppEnv } from "../../src/web/session.js";

import { TICK_URL } from "./connection-do.js";
import { workerPublicGet } from "./public-address.js";

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
  // Sign-in and mail (MVP-1). EMAIL is the send_email binding the template declares;
  // an instance overlay may restrict it to verified recipients before Workers Paid
  // (DESIGN §13/§18 rc14). It is used only when MAIL_PROVIDER=cloudflare.
  PUBLIC_BASE_URL?: string;
  // rc43: capabilities, and the operators who grant them (§10 Capabilities).
  CAPABILITIES_DEFAULT?: string;
  OPERATOR_EMAILS?: string;
  GOOGLE_PUSH_CHANNELS?: string;
  MAIL_PROVIDER?: string;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  MAIL_DAILY_CAP?: string;
  MAIL_MONTHLY_CAP?: string;
  MAIL_SENDER_DAILY_CAP?: string;
  MAIL_SENDER_MONTHLY_CAP?: string;
  MAIL_NEW_SENDER_DAILY_CAP?: string;
  MAIL_NEW_SENDER_DAYS?: string;
  EMAIL?: EmailBindingLike;
}

// Built lazily because bindings only exist per-request, then cached for the life of
// the isolate: constructing the cipher imports a key, which is async and need not
// repeat. The fields are copied out of Env explicitly rather than passing Env to
// loadConfig() — Env holds bindings as well as strings, and AGENTS.md forbids the
// cast that would paper over that.
interface Built {
  readonly app: Hono<AppEnv>;
  readonly storage: StoragePort;
  readonly calendars: CalendarGrants | undefined;
  readonly runners: HeldRunners;
  /** The minute's reconnect emails (rc40). */
  readonly mailReconnects: (
    at: string,
  ) => Promise<{ readonly sent: number; readonly failed: number }>;
  /** Whether Google is configured, so there is anything to push (MVP-4 G2). */
  readonly pushing: boolean;
}
let cached: Promise<Built> | undefined;

const now = () => new Date().toISOString();

/** The provider for this target, ALWAYS behind the cap (DESIGN §13 rc9). */
function buildMail(c: Config, env: Env, s: StoragePort): MailPort {
  let inner: MailPort;
  switch (c.MAIL_PROVIDER) {
    case "disabled":
      return disabledMailPort; // fail closed (src/mail/port.ts)
    case "console":
      inner = consoleMailPort();
      break;
    case "cloudflare":
      if (env.EMAIL === undefined || c.MAIL_FROM_ADDRESS === undefined) {
        throw new Error(
          "MAIL_PROVIDER=cloudflare on Workers needs the EMAIL send_email binding and MAIL_FROM_ADDRESS",
        );
      }
      inner = cloudflareBindingMailPort(env.EMAIL, {
        address: c.MAIL_FROM_ADDRESS,
        name: c.MAIL_FROM_NAME,
      });
      break;
  }
  return cappedMailPort(inner, s, {
    cap: mailCapOf(c),
    now,
  });
}

/** A followed link's GET (rc57): DNS over HTTPS first, then the calendar, redirects unfollowed. */
const publicGet = workerPublicGet((url, init) => fetch(url, init));

async function build(env: Env): Promise<Built> {
  const config = loadConfig({
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI,
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
    LOG_LEVEL: env.LOG_LEVEL,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    MAIL_PROVIDER: env.MAIL_PROVIDER,
    MAIL_FROM_ADDRESS: env.MAIL_FROM_ADDRESS,
    MAIL_FROM_NAME: env.MAIL_FROM_NAME,
    MAIL_DAILY_CAP: env.MAIL_DAILY_CAP,
    MAIL_MONTHLY_CAP: env.MAIL_MONTHLY_CAP,
    MAIL_SENDER_DAILY_CAP: env.MAIL_SENDER_DAILY_CAP,
    MAIL_SENDER_MONTHLY_CAP: env.MAIL_SENDER_MONTHLY_CAP,
    MAIL_NEW_SENDER_DAILY_CAP: env.MAIL_NEW_SENDER_DAILY_CAP,
    MAIL_NEW_SENDER_DAYS: env.MAIL_NEW_SENDER_DAYS,
    CAPABILITIES_DEFAULT: env.CAPABILITIES_DEFAULT,
    OPERATOR_EMAILS: env.OPERATOR_EMAILS,
    GOOGLE_PUSH_CHANNELS: env.GOOGLE_PUSH_CHANNELS,
  });
  const storage = d1StoragePort(env.DB);
  const oauth = anyGoogleOAuthConfigured(config)
    ? await buildOAuthDeps(config, storage)
    : undefined;

  const auth: AuthDeps = {
    storage,
    mail: buildMail(config, env, storage),
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
  // rc53: a push notification asks the connection's Durable Object to read, which coalesces
  // pokes (connection-do.ts); the request is answered without waiting for the read.
  const poke = async (connectionId: string) => {
    await env.CONNECTION_DO.get(env.CONNECTION_DO.idFromName(connectionId)).fetch(TICK_URL, {
      method: "POST",
      body: JSON.stringify({ connectionId, pull: true, poke: true }),
    });
  };
  const app = createApp({
    auth,
    oauth,
    publicGet,
    ...(config.GOOGLE_PUSH_CHANNELS === "on" ? { poke } : {}),
  });
  return {
    app,
    storage,
    calendars: calendarGrants(oauth),
    runners: heldRunners(auth),
    mailReconnects: reconnectMailer(auth),
    pushing: oauth !== undefined,
  };
}

/** Ask each connection's Durable Object to tick; one failing doesn't stop the rest. */
async function fanOut(
  env: Env,
  due: readonly { readonly connectionId: string; readonly pull: boolean }[],
): Promise<void> {
  const asked = await Promise.allSettled(
    due.map(({ connectionId, pull }) =>
      env.CONNECTION_DO.get(env.CONNECTION_DO.idFromName(connectionId)).fetch(TICK_URL, {
        method: "POST",
        body: JSON.stringify({ connectionId, pull }),
      }),
    ),
  );
  asked.forEach((r, i) => {
    if (r.status === "rejected")
      console.error(JSON.stringify(tickFailureLog(due[i]?.connectionId ?? "", r.reason)));
  });
}

function getBuilt(env: Env): Promise<Built> {
  cached ??= build(env);
  return cached;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { app } = await getBuilt(env);
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // The purge pass (§10 rc21/rc22): accounts whose 7 days are over, each minute, and
    // retention once an hour. Bounded per run; with nothing due, reads only (§16).
    const { storage, calendars, runners, mailReconnects, pushing } = await getBuilt(env);
    const at = new Date(controller.scheduledTime).toISOString();
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
    // rc40: one email to each account Google stopped answering for, after the tick that found it.
    const mailed = await mailReconnects(at);
    if (mailed.sent + mailed.failed > 0)
      console.log(JSON.stringify({ reason: "reconnect_mailed", ...mailed }));
    // The push tick (MVP-4 G2): fan out to one ConnectionDO per active calendar_connection,
    // its single writer (§11). Cron is the only scheduler of regular ticks — never per-tick DO
    // alarms (§16). Choosing whom to tick reads only; a quiet tick writes nothing (§6).
    // rc53: with each connection's turn to be read in Google, every 6 hours.
    if (pushing) await fanOut(env, await ticksDue(storage, at));
    // rc56: the followed calendars whose turn it is, each in its own minute of six hours.
    const followed = await followingPass(storage, publicGet, at);
    for (const { calendarId, refreshed } of followed) {
      const line = followLog(calendarId, refreshed);
      if (line !== null) console.log(JSON.stringify(line));
    }
  },
};
