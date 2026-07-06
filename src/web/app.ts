// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { z } from "zod";

// The Hono app is shared verbatim by both deployments (DESIGN.md §6): workerd mounts
// it in deploy/cloudflare/worker.ts, Node in deploy/node/server.ts. Views render
// typed (zod) view-models only — no business logic in templates (§16).

const homeViewSchema = z.object({
  appName: z.literal("WhenDoWe"),
  tagline: z.string(),
  milestone: z.string(),
});

type HomeView = z.infer<typeof homeViewSchema>;

function renderHome(view: HomeView): string {
  // Static, trusted strings only for now. The moment event fields reach a view,
  // they are untrusted input and must be escaped on render (§13).
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
    "</body>",
    "</html>",
  ].join("\n");
}

export function createApp(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const view = homeViewSchema.parse({
      appName: "WhenDoWe",
      tagline: "One canonical event, projected into many calendars — with attribution.",
      milestone: "M0 — Bootstrap",
    });
    return c.html(renderHome(view));
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  return app;
}
