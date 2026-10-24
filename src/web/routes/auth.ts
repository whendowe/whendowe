// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { StoragePort } from "../../db/port.js";
import { MailCapReachedError } from "../../mail/capped.js";
import type { MailPort } from "../../mail/port.js";
import { signOutActive, switchTo } from "../../people/accounts.js";
import {
  consumeLoginToken,
  issueLoginToken,
  LOGIN_TOKEN_TTL_MS,
  peekLoginToken,
} from "../../people/login.js";
import { findOrCreatePerson, findPersonByEmail, normalizeEmail } from "../../people/person.js";
import { revokeSession } from "../../people/session.js";
import { html, SIGN_OUT_ALL_PATH, SIGN_OUT_PATH, SWITCH_PATH } from "../layout.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  roomFor,
  signInAs,
  verifyFormCsrf,
  writeAccountsCookie,
} from "../session.js";

// Magic-link sign-in (MVP-1 slice C). Sign-up and sign-in are one flow.
//
//   GET  /auth/sign-in   form: your email
//   POST /auth/sign-in   issue a link, email it, "check your inbox"
//   GET  /auth/confirm   "Sign in as ann@…? [Continue]" — reads, never consumes
//   POST /auth/confirm   consume the link, create the person if new, start a session
//   POST /auth/sign-out      sign out of the active account; the next becomes active
//   POST /auth/sign-out-all  sign out of every account on this browser
//   POST /auth/switch        make another of this browser's accounts active
//
// A browser holds up to four accounts (DESIGN §13 rc18). Signing in while signed in
// adds one; switching only reorders the cookie and writes nothing to storage. The
// three POSTs above are CSRF-checked against the active account.
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
export { SIGN_OUT_ALL_PATH, SIGN_OUT_PATH, SWITCH_PATH };

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

/** The form; signed in, it adds another account rather than replacing this one. */
function signInForm(email: string, error: string | null, signedInAs: string | null) {
  return html`${
    signedInAs === null
      ? html`<h1>Sign in</h1>
<p class="muted">We'll email you a link. No password, and no account to create first.</p>`
      : html`<h1>Add another account</h1>
<p class="muted">You stay signed in as ${signedInAs}. Once you open the link we email, you can switch between the two from the menu at the top.</p>`
  }
${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${SIGN_IN_PATH}">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" autocomplete="email" required value="${email}" />
  <p><button type="submit">Email me a sign-in link</button></p>
</form>`;
}

function full(c: Context<AppEnv>) {
  return c.html(
    page(
      c,
      "Too many accounts",
      html`<h1>Four accounts are already signed in here</h1>
<p>That is the most one browser holds. Sign out of one from the menu at the top, then add this one.</p>`,
    ),
    409,
  );
}

function expiredPage(c: Context<AppEnv>) {
  return page(
    c,
    "Link expired",
    html`<h1>This link has expired or was already used</h1>
<p>Sign-in links work once and last ${LOGIN_TOKEN_TTL_MS / 60_000} minutes.</p>
<p><a href="${SIGN_IN_PATH}">Get a new link</a></p>`,
  );
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthDeps): void {
  app.get(SIGN_IN_PATH, (c) => {
    if (!roomFor(c, null)) return full(c);
    return c.html(page(c, "Sign in", signInForm("", null, c.get("signedIn")?.email ?? null)));
  });

  app.post(SIGN_IN_PATH, async (c) => {
    const form = await c.req.parseBody();
    const raw = typeof form.email === "string" ? form.email : "";

    let email: string;
    try {
      email = normalizeEmail(raw);
    } catch {
      return c.html(
        page(
          c,
          "Sign in",
          signInForm(
            raw.slice(0, 200),
            "That doesn't look like an email address.",
            c.get("signedIn")?.email ?? null,
          ),
        ),
        400,
      );
    }

    const issued = await issueLoginToken(deps.storage, email, { now: deps.now() });
    if (!issued.ok) {
      return c.html(
        page(
          c,
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
          page(
            c,
            "Can't send email",
            html`<h1>We can't send email right now</h1><p>Please try again later.</p>`,
          ),
          503,
        );
      }
      return c.html(
        page(
          c,
          "Couldn't send",
          html`<h1>We couldn't send your link</h1><p>Please check the address and try again.</p>`,
        ),
        502,
      );
    }

    return c.html(
      page(
        c,
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
    if (!token.success || email === null) return c.html(expiredPage(c), 400);
    return c.html(
      page(
        c,
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
    // A full browser refuses before the link is used, so it still works after signing
    // out of one account.
    const peeked = token.success ? await peekLoginToken(deps.storage, token.data, { now }) : null;
    if (peeked !== null) {
      const known = await findPersonByEmail(deps.storage, peeked);
      if (!roomFor(c, known?.id ?? null)) return full(c);
    }
    const email = token.success ? await consumeLoginToken(deps.storage, token.data, { now }) : null;
    if (email === null) return c.html(expiredPage(c), 400);

    const person = await findOrCreatePerson(deps.storage, email, { now });
    if (!(await signInAs(c, deps, person.id))) return full(c);
    return c.redirect("/", 303);
  });

  app.post(SIGN_OUT_PATH, async (c) => {
    const signedIn = c.get("signedIn");
    if (signedIn === null) return c.redirect("/", 303);
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(signedIn, form))) return rejectedPage(c, form);
    const { accounts, signedOut } = signOutActive(c.get("accounts"));
    if (signedOut !== null) await revokeSession(deps.storage, signedOut.token, deps.now());
    writeAccountsCookie(c, accounts, deps.secureCookies);
    return c.redirect("/", 303);
  });

  app.post(SIGN_OUT_ALL_PATH, async (c) => {
    const signedIn = c.get("signedIn");
    if (signedIn === null) return c.redirect("/", 303);
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(signedIn, form))) return rejectedPage(c, form);
    const now = deps.now();
    for (const a of c.get("accounts")) await revokeSession(deps.storage, a.token, now);
    writeAccountsCookie(c, [], deps.secureCookies);
    return c.redirect("/", 303);
  });

  // Switching changes nothing on the server: the cookie is reordered, that's all (§6).
  app.post(SWITCH_PATH, async (c) => {
    const signedIn = c.get("signedIn");
    if (signedIn === null) return c.redirect("/", 303);
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(signedIn, form))) return rejectedPage(c, form);
    const target = typeof form.session === "string" ? form.session : "";
    const accounts = switchTo(c.get("accounts"), target);
    // Gone already (signed out in another tab, or expired): stay as we are.
    if (accounts !== null) writeAccountsCookie(c, accounts, deps.secureCookies);
    return c.redirect(backTo(form.back), 303);
  });
}

/**
 * Where a switch returns to: this site's own path, or home. Never another origin —
 * "//evil.example" and "/\\evil.example" are protocol-relative to a browser.
 */
export function backTo(value: unknown): string {
  return typeof value === "string" && /^\/(?![/\\])[^\s]{0,500}$/.test(value) ? value : "/";
}
