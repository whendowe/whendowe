// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { StoragePort } from "../../db/port.js";
import { MailCapReachedError } from "../../mail/capped.js";
import type { MailPort } from "../../mail/port.js";
import {
  consumeLoginToken,
  issueLoginToken,
  LOGIN_TOKEN_TTL_MS,
  peekLoginToken,
} from "../../people/login.js";
import { findOrCreatePerson, normalizeEmail } from "../../people/person.js";
import { createSession, revokeSession } from "../../people/session.js";
import { html, renderPage } from "../layout.js";
import { type AppEnv, clearSessionCookie, setSessionCookie, verifyFormCsrf } from "../session.js";

// Magic-link sign-in (MVP-1 slice C). Sign-up and sign-in are one flow.
//
//   GET  /auth/sign-in   form: your email
//   POST /auth/sign-in   issue a link, email it, "check your inbox"
//   GET  /auth/confirm   "Sign in as ann@…? [Continue]" — reads, never consumes
//   POST /auth/confirm   consume the link, create the person if new, start a session
//   POST /auth/sign-out  revoke this session (CSRF-checked)
//
// Security notes, each with a test:
// - The emailed link is built from PUBLIC_BASE_URL, NEVER from the request's Host
//   header. Otherwise a forged Host makes the app email someone's real login link
//   pointing at an attacker's domain (host-header injection → account takeover).
// - GET confirm never consumes: mail scanners open links automatically (§13 "GET
//   never mutates"). It names the account, which defeats silent login-CSRF.
// - The token is in the query string. §13 forbids LOGGING query strings and nothing
//   here logs them; exposure to intermediate logs is bounded by single use + 15 min.
//   Token-bearing responses send no-referrer and no-store.
// - Requesting a link for an address says the same thing whether or not an account
//   exists for it (none exist until a link is consumed), so it reveals nothing.

export const SIGN_IN_PATH = "/auth/sign-in";
export const CONFIRM_PATH = "/auth/confirm";
export const SIGN_OUT_PATH = "/auth/sign-out";

export interface AuthDeps {
  readonly storage: StoragePort;
  /** Always the capped port (src/mail/capped.ts); never a bare provider. */
  readonly mail: MailPort;
  /** Absolute origin links are built from, e.g. https://whendowe.org. Never the Host header. */
  readonly publicBaseUrl: string;
  readonly secureCookies: boolean;
  readonly now: () => string;
}

const tokenSchema = z.string().min(1).max(256);

function sensitive(c: Context): void {
  // Pages carrying or consuming a login token: keep the token out of Referer headers
  // and out of every cache.
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
}

function signInForm(email: string, error: string | null) {
  return html`<h1>Sign in</h1>
<p class="muted">We'll email you a link. No password, and no account to create first.</p>
${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${SIGN_IN_PATH}">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" autocomplete="email" required value="${email}" />
  <p><button type="submit">Email me a sign-in link</button></p>
</form>`;
}

function expiredPage() {
  return renderPage(
    "Link expired",
    html`<h1>This link has expired or was already used</h1>
<p>Sign-in links work once and last ${LOGIN_TOKEN_TTL_MS / 60_000} minutes.</p>
<p><a href="${SIGN_IN_PATH}">Get a new link</a></p>`,
  );
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthDeps): void {
  app.get(SIGN_IN_PATH, (c) => {
    if (c.get("signedIn") !== null) return c.redirect("/", 303);
    return c.html(renderPage("Sign in", signInForm("", null)));
  });

  app.post(SIGN_IN_PATH, async (c) => {
    const form = await c.req.parseBody();
    const raw = typeof form.email === "string" ? form.email : "";

    let email: string;
    try {
      email = normalizeEmail(raw);
    } catch {
      return c.html(
        renderPage(
          "Sign in",
          signInForm(raw.slice(0, 200), "That doesn't look like an email address."),
        ),
        400,
      );
    }

    const issued = await issueLoginToken(deps.storage, email, { now: deps.now() });
    if (!issued.ok) {
      return c.html(
        renderPage(
          "Too many requests",
          html`<h1>Too many sign-in links</h1>
<p>Several links were already sent to this address in the last hour. Use the newest one, or try again later.</p>`,
        ),
        429,
      );
    }

    // From the configured origin — never c.req.url / Host (see the header comment).
    const link = new URL(CONFIRM_PATH, deps.publicBaseUrl);
    link.searchParams.set("t", issued.token);

    try {
      await deps.mail.send({
        to: email,
        subject: "Your WhenDoWe sign-in link",
        text: [
          "Sign in to WhenDoWe:",
          "",
          link.toString(),
          "",
          `The link works once and expires in ${LOGIN_TOKEN_TTL_MS / 60_000} minutes.`,
          "If you didn't ask for it, ignore this email — nothing happens unless the link is used.",
        ].join("\n"),
      });
    } catch (error) {
      if (error instanceof MailCapReachedError) {
        return c.html(
          renderPage(
            "Can't send email",
            html`<h1>We can't send email right now</h1><p>Please try again later.</p>`,
          ),
          503,
        );
      }
      return c.html(
        renderPage(
          "Couldn't send",
          html`<h1>We couldn't send your link</h1><p>Please check the address and try again.</p>`,
        ),
        502,
      );
    }

    return c.html(
      renderPage(
        "Check your email",
        html`<h1>Check your email</h1>
<p>We sent a sign-in link to <strong>${email}</strong>. It works once and expires in ${LOGIN_TOKEN_TTL_MS / 60_000} minutes.</p>`,
      ),
    );
  });

  app.get(CONFIRM_PATH, async (c) => {
    sensitive(c);
    const token = tokenSchema.safeParse(c.req.query("t"));
    const email = token.success
      ? await peekLoginToken(deps.storage, token.data, { now: deps.now() })
      : null;
    if (!token.success || email === null) return c.html(expiredPage(), 400);
    return c.html(
      renderPage(
        "Sign in",
        html`<h1>Sign in as ${email}?</h1>
<p class="muted">If that isn't you, close this page — nothing happens unless you continue.</p>
<form method="post" action="${CONFIRM_PATH}">
  <input type="hidden" name="t" value="${token.data}" />
  <button type="submit">Continue</button>
</form>`,
      ),
    );
  });

  app.post(CONFIRM_PATH, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = tokenSchema.safeParse(form.t);
    const now = deps.now();
    const email = token.success ? await consumeLoginToken(deps.storage, token.data, { now }) : null;
    if (email === null) return c.html(expiredPage(), 400);

    const person = await findOrCreatePerson(deps.storage, email, { now });
    const session = await createSession(deps.storage, person.id, { now });
    setSessionCookie(c, session.token, deps.secureCookies);
    return c.redirect("/", 303);
  });

  app.post(SIGN_OUT_PATH, async (c) => {
    const signedIn = c.get("signedIn");
    if (signedIn === null) return c.redirect("/", 303);
    if (!(await verifyFormCsrf(signedIn, await c.req.parseBody()))) {
      return c.html(
        renderPage("Request rejected", html`<h1>Request rejected</h1><p>Please try again.</p>`),
        403,
      );
    }
    await revokeSession(deps.storage, signedIn.sessionToken, deps.now());
    clearSessionCookie(c, deps.secureCookies);
    return c.redirect("/", 303);
  });
}
