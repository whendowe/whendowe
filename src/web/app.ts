// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { html, renderPage } from "./layout.js";
import { type AuthDeps, registerAuthRoutes, SIGN_IN_PATH, SIGN_OUT_PATH } from "./routes/auth.js";
import { GROUPS_PATH, registerGroupRoutes } from "./routes/groups.js";
import { CONNECT_PATH, type OAuthRouteDeps, registerOAuthRoutes } from "./routes/oauth.js";
import { type AppEnv, sessionMiddleware } from "./session.js";

// The Hono app is shared verbatim by both deployments (DESIGN.md §6): workerd mounts
// it in deploy/cloudflare/worker.ts, Node in deploy/node/server.ts. Pages render
// through src/web/layout.ts, whose `html` tag escapes every interpolation (§13).

export interface AppOptions {
  /** People, sign-in and sessions. Absent only for the bare hello page (M0 proof, tests). */
  readonly auth?: AuthDeps;
  /** Google connect flow; absent on an instance with no Google credentials. */
  readonly oauth?: OAuthRouteDeps;
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { auth, oauth } = options;

  if (auth === undefined) {
    app.use(async (c, next) => {
      c.set("signedIn", null);
      await next();
    });
  } else {
    app.use(sessionMiddleware(auth));
  }

  app.get("/", (c) => {
    const signedIn = c.get("signedIn");
    const account =
      signedIn === null
        ? auth === undefined
          ? html`<p class="muted">Sign-in is not configured on this instance.</p>`
          : html`<p><a href="${SIGN_IN_PATH}">Sign in</a></p>`
        : html`<header>
  <span>Signed in as <strong>${signedIn.email}</strong></span>
  <form method="post" action="${SIGN_OUT_PATH}">
    <input type="hidden" name="csrf" value="${signedIn.csrfToken}" />
    <button type="submit">Sign out</button>
  </form>
</header>`;
    // POST, not a link: starting a flow sets state, and a GET would let any page
    // trigger it with an <img> tag.
    const connect =
      oauth === undefined
        ? html`<p class="muted">Google credentials are not configured on this instance.</p>`
        : html`<form method="post" action="${CONNECT_PATH}"><button type="submit">Connect Google Calendar</button></form>`;
    return c.html(
      renderPage(
        "Home",
        html`${account}
<h1>WhenDoWe</h1>
<p>One canonical event, projected into many calendars — with attribution.</p>
<p class="muted">Milestone: MVP-1 — People</p>
${signedIn === null ? "" : html`<p><a href="${GROUPS_PATH}">Your groups</a></p>`}
${connect}`,
      ),
    );
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  if (auth !== undefined) {
    registerAuthRoutes(app, auth);
    registerGroupRoutes(app, auth);
  }
  if (oauth !== undefined) registerOAuthRoutes(app, oauth);

  return app;
}
