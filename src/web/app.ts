// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { z } from "zod";
import { CONNECT_PATH, type OAuthRouteDeps, registerOAuthRoutes } from "./oauth-routes.js";

// The Hono app is shared verbatim by both deployments (DESIGN.md §6): workerd mounts
// it in deploy/cloudflare/worker.ts, Node in deploy/node/server.ts. Views render
// typed (zod) view-models only — no business logic in templates (§16).

const homeViewSchema = z.object({
  appName: z.literal("WhenDoWe"),
  tagline: z.string(),
  milestone: z.string(),
  /** Whether this instance has Google credentials configured (§13 config). */
  canConnect: z.boolean(),
});

type HomeView = z.infer<typeof homeViewSchema>;

function renderHome(view: HomeView): string {
  // Static, trusted strings only on this page. Views that render provider-supplied
  // text escape it — see src/web/escape.ts and the OAuth callback (§13).
  const connect = view.canConnect
    ? [
        // POST, not a link: starting a flow sets state, and a GET would let any
        // page trigger it with an <img> tag.
        `<form method="post" action="${CONNECT_PATH}">`,
        '<button type="submit">Connect Google Calendar</button>',
        "</form>",
      ].join("\n")
    : "<p>Google credentials are not configured on this instance.</p>";

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${view.appName}</title>`,
    "</head>",
    "<body>",
    `<h1>${view.appName}</h1>`,
    `<p>${view.tagline}</p>`,
    `<p>Milestone: ${view.milestone}</p>`,
    connect,
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * The shared Hono app (§6): mounted verbatim by both deployment targets.
 *
 * `oauth` is optional so an instance with no Google credentials still boots and
 * serves a page — the M0 dual-deploy proof keeps working, and a half-configured
 * deployment fails visibly on the home page rather than at import time.
 */
export function createApp(oauth?: OAuthRouteDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const view = homeViewSchema.parse({
      appName: "WhenDoWe",
      tagline: "One canonical event, projected into many calendars — with attribution.",
      milestone: "M1 — Read",
      canConnect: oauth !== undefined,
    });
    return c.html(renderHome(view));
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  if (oauth !== undefined) {
    registerOAuthRoutes(app, oauth);
  }

  return app;
}
