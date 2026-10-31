// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Hono } from "hono";
import { anyGoogleOAuthConfigured, type Config, loadConfig } from "../../src/config.js";
import { d1StoragePort } from "../../src/db/d1.js";
import type { StoragePort } from "../../src/db/port.js";
import { cappedMailPort } from "../../src/mail/capped.js";
import { cloudflareBindingMailPort, type EmailBindingLike } from "../../src/mail/cloudflare.js";
import { consoleMailPort } from "../../src/mail/console.js";
import { disabledMailPort, type MailPort } from "../../src/mail/port.js";
import { eraseDue, type RevokeCalendars } from "../../src/privacy/erasure.js";
import { calendarRevoker, createApp } from "../../src/web/app.js";
import { buildOAuthDeps } from "../../src/web/routes/oauth-deps.js";
import type { AppEnv } from "../../src/web/session.js";

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
  MAIL_PROVIDER?: string;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  MAIL_DAILY_CAP?: string;
  MAIL_MONTHLY_CAP?: string;
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
  readonly revokeCalendars: RevokeCalendars | undefined;
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
    cap: { daily: c.MAIL_DAILY_CAP, monthly: c.MAIL_MONTHLY_CAP },
    now,
  });
}

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
  });
  const storage = d1StoragePort(env.DB);
  const oauth = anyGoogleOAuthConfigured(config)
    ? await buildOAuthDeps(config, storage)
    : undefined;

  const app = createApp({
    auth: {
      storage,
      mail: buildMail(config, env, storage),
      publicBaseUrl: config.PUBLIC_BASE_URL,
      secureCookies: new URL(config.PUBLIC_BASE_URL).protocol === "https:",
      now,
    },
    oauth,
  });
  return { app, storage, revokeCalendars: calendarRevoker(oauth) };
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

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // The purge pass (§10 rc21/rc22): accounts whose 7 days are over. Bounded per run;
    // with nothing due, one read and no writes (§16).
    const { storage, revokeCalendars } = await getBuilt(env);
    const erased = await eraseDue(storage, { now: now(), revokeCalendars });
    if (erased > 0) console.log(JSON.stringify({ reason: "accounts_erased", count: erased }));
    // M2: fan out to one ConnectionDO per active calendar_connection (§11).
    // Cron is the only scheduler of regular ticks — never per-tick DO alarms (§16).
  },
};
