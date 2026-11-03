// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MiddlewareHandler } from "hono";

// Security headers on every response (DESIGN §13 rc21).
//
// Scripts are allowed by HASH, never 'unsafe-inline': the pages' inline scripts are
// fixed strings (picker.ts, plan-editor.ts, layout.ts ZONE_GUESS and SHARE_BUTTONS), so their hashes are
// constants. An injected <script> — the day an escaping bug slips through — matches none
// of them and does not run. tests/unit/csp.test.ts recomputes these from the shipped
// scripts and fails, naming the new values, whenever a script changes.
export const SCRIPT_HASHES: readonly string[] = [
  "sha256-hy1CT6orc1H1ttOry9+3LGLyKv9lFZDPcMIK/nQvAJo=",
  "sha256-Ut9HYEA7WCEd+RNydfR65LQ8AkGLkHN9+rpxVaTPi2c=",
  "sha256-thOP9cofq68135/BNxIx19zBU2Nd3F8xNvN0xZ1hJoc=",
  "sha256-to6JPZkUfWfQiXrrmnVXATfIzIPJqlnSwh2dzCjuWAM=",
];

/**
 * The policy. Styles stay inline (`<style>` blocks and `style=` attributes are used
 * throughout, and style injection is not script execution). Forms may post only here —
 * and to Google, because the sign-in and connect POSTs answer with a redirect there,
 * which browsers check against form-action too.
 */
function policy(withFrameAncestors: boolean): string {
  return [
    "default-src 'none'",
    `script-src ${SCRIPT_HASHES.map((h) => `'${h}'`).join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self' https://accounts.google.com",
    "base-uri 'none'",
    ...(withFrameAncestors ? ["frame-ancestors 'none'"] : []),
  ].join("; ");
}

export const CONTENT_SECURITY_POLICY = policy(true);

/**
 * The same policy for a `<meta>` tag in every page, so pages opened as files — the
 * browser tier's fixtures — run their scripts under it too. frame-ancestors is header-only.
 */
export const META_CONTENT_SECURITY_POLICY = policy(false);

const HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  // Routes that put a token on the page send no-referrer instead; theirs wins.
  "Referrer-Policy": "same-origin",
};

/** Adds each header the route didn't set itself, after the route has answered. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(HEADERS)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
}
