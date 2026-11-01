// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { revokeGoogleGrant } from "../oauth/token-exchange.js";
import { findPersonById } from "../people/person.js";
import type { RevokeCalendars } from "../privacy/erasure.js";
import { suppressingMailPort } from "../privacy/suppression.js";
import { securityHeaders } from "./csp.js";
import { ACCOUNT_PATH, html } from "./layout.js";
import { registerAccountRoutes } from "./routes/account.js";
import { type AuthDeps, registerAuthRoutes, SIGN_IN_PATH } from "./routes/auth.js";
import { EVENTS_PATH, POLLS_PATH, registerEventRoutes, yourEvents } from "./routes/events.js";
import { GROUPS_PATH, registerGroupRoutes } from "./routes/groups.js";
import { CONNECT_PATH, type OAuthRouteDeps, registerOAuthRoutes } from "./routes/oauth.js";
import { registerPlanRoutes, yourPlans } from "./routes/plans.js";
import { registerRespondRoutes } from "./routes/respond.js";
import { type AppEnv, page, sessionMiddleware } from "./session.js";

// The Hono app is shared verbatim by both deployments (DESIGN.md §6): workerd mounts
// it in deploy/cloudflare/worker.ts, Node in deploy/node/server.ts. Pages render
// through src/web/layout.ts, whose `html` tag escapes every interpolation (§13).

export interface AppOptions {
  /** People, sign-in and sessions. Absent only for the bare hello page (M0 proof, tests). */
  readonly auth?: AuthDeps;
  /** Google connect flow; absent on an instance with no Google credentials. */
  readonly oauth?: OAuthRouteDeps;
}

/** Someone with no handle shows as "Guest …" to everyone: ask them, once, on home (§10 rc21). */
async function nameNudge(auth: AuthDeps, personId: string) {
  const person = await findPersonById(auth.storage, personId);
  return person?.displayName === null
    ? html`<p class="wd-nudge"><strong>Choose the name people see.</strong> Until you do, others see you as a guest, never your email address. <a href="${ACCOUNT_PATH}">Choose a name</a></p>`
    : "";
}

/**
 * Revoke a person's Google grants before their tokens are deleted (§10 rc21), best
 * effort; undefined on an instance with no Google credentials. Shared by the delete
 * routes and the cron's purge pass.
 */
export function calendarRevoker(oauth: OAuthRouteDeps | undefined): RevokeCalendars | undefined {
  if (oauth === undefined) return undefined;
  return async (connections) => {
    for (const conn of connections) {
      const token = await oauth.cipher.decrypt(conn.refreshTokenEnc);
      await revokeGoogleGrant(token, oauth.fetchImpl);
    }
  };
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { oauth } = options;
  // Every send passes the opt-out seam (rc24): here, once, so no route can bypass it.
  const auth =
    options.auth === undefined
      ? undefined
      : {
          ...options.auth,
          mail: suppressingMailPort(options.auth.mail, options.auth.storage, {
            publicBaseUrl: options.auth.publicBaseUrl,
            now: options.auth.now,
          }),
        };
  // First, so every response — errors and redirects included — carries them (§13 rc21).
  app.use(securityHeaders());

  if (auth === undefined) {
    app.use(async (c, next) => {
      c.set("signedIn", null);
      c.set("accounts", []);
      await next();
    });
  } else {
    app.use(sessionMiddleware(auth));
  }

  app.get("/", async (c) => {
    const signedIn = c.get("signedIn");
    // Who is signed in, and the menu, are in every page's header (layout.ts, rc18).
    const account =
      signedIn !== null
        ? ""
        : auth === undefined
          ? html`<p class="muted">Sign-in is not configured on this instance.</p>`
          : html`<p><a href="${SIGN_IN_PATH}">Sign in</a></p>`;
    // POST, not a link: starting a flow sets state, and a GET would let any page
    // trigger it with an <img> tag.
    // Connecting a calendar needs a person to own it (MVP-1 E), so the button only
    // appears signed in, and carries that session's CSRF token.
    const connect =
      oauth === undefined
        ? html`<p class="muted">Google credentials are not configured on this instance.</p>`
        : signedIn === null
          ? ""
          : html`<form method="post" action="${CONNECT_PATH}">
  <input type="hidden" name="csrf" value="${signedIn.csrfToken}" />
  <button type="submit">Connect Google Calendar</button>
</form>`;
    return c.html(
      page(
        c,
        signedIn === null ? "Home" : "Your events",
        signedIn === null || auth === undefined
          ? html`${account}
<h1>WhenDoWe</h1>
<p>One canonical event, projected into many calendars — with attribution.</p>
<p class="muted">Milestone: MVP-1 — People</p>
${connect}`
          : html`${await nameNudge(auth, signedIn.personId)}${await yourEvents(auth.storage, signedIn.personId, auth.now())}
<p><a href="${EVENTS_PATH}/new">+ New event</a> · <a href="${POLLS_PATH}/new">+ Find a time (poll)</a></p>
${await yourPlans(auth.storage, signedIn.personId)}
<p><a href="${GROUPS_PATH}">Your groups</a></p>
${connect}`,
      ),
    );
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  if (auth !== undefined) {
    registerAuthRoutes(app, auth, { google: oauth !== undefined });
    registerAccountRoutes(app, auth, { revokeCalendars: calendarRevoker(oauth) });
    registerGroupRoutes(app, auth);
    registerEventRoutes(app, auth);
    registerPlanRoutes(app, auth);
    registerRespondRoutes(app, auth);
  }
  if (oauth !== undefined) registerOAuthRoutes(app, oauth, auth);

  return app;
}
