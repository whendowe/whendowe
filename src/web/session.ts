// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { StoragePort } from "../db/port.js";
import { type Account, addAccount, canAdd, cookieTokens, cookieValue } from "../people/accounts.js";
import {
  createSession,
  resolveAccounts,
  revokeSession,
  SESSION_TTL_MS,
  verifyCsrf,
} from "../people/session.js";
import { csrfTokenFor } from "../people/tokens.js";
import {
  ADD_ACCOUNT_PATH,
  type Html,
  html,
  renderPage,
  switchForm,
  type Viewer,
} from "./layout.js";

// Session middleware: the cookie → this browser's signed-in accounts, on every
// request (§13 rc18). The first is the active one, the person every route acts as.
//
// Cookie: HttpOnly (no script can read it), SameSite=Lax (not sent on cross-site
// POSTs — a first line against CSRF; the per-session token below is the second),
// Secure wherever the instance is served over https, Path=/. It holds up to four
// session tokens (src/people/accounts.ts); nothing on the server links them.

export const SESSION_COOKIE = "wdw_session";

export interface SignedIn {
  readonly personId: string;
  readonly email: string;
  readonly sessionId: string;
  /** The raw cookie token. Needed to revoke and to verify CSRF; never rendered. */
  readonly sessionToken: string;
  /** Render into every form; verifyFormCsrf checks it on every mutating request. */
  readonly csrfToken: string;
}

export interface AppEnv {
  Variables: {
    /** The active account, or null when no account is signed in on this browser. */
    signedIn: SignedIn | null;
    /** Every account signed in on this browser, the active one first. */
    accounts: readonly Account[];
  };
}

export interface SessionDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
  readonly secureCookies: boolean;
}

export function sessionMiddleware(deps: SessionDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tokens = cookieTokens(getCookie(c, SESSION_COOKIE));
    const accounts = await resolveAccounts(deps.storage, tokens, { now: deps.now() });
    await setAccounts(c, accounts);
    await next();
    // A token that is unknown, expired or revoked leaves the cookie on this response,
    // unless the route has already written the cookie itself. A cookie rewrite only:
    // nothing is written to storage.
    const written = (c.res.headers.get("set-cookie") ?? "").includes(`${SESSION_COOKIE}=`);
    if (accounts.length !== tokens.length && !written) {
      writeAccountsCookie(c, accounts, deps.secureCookies);
    }
  };
}

async function setAccounts(c: Context<AppEnv>, accounts: readonly Account[]): Promise<void> {
  c.set("accounts", accounts);
  const active = accounts[0];
  c.set(
    "signedIn",
    active === undefined
      ? null
      : {
          personId: active.personId,
          email: active.email,
          sessionId: active.sessionId,
          sessionToken: active.token,
          csrfToken: await csrfTokenFor(active.token),
        },
  );
}

/** Write the browser's accounts to the cookie, or clear it when none are left. */
export function writeAccountsCookie(
  c: Context,
  accounts: readonly Account[],
  secure: boolean,
): void {
  if (accounts.length === 0) {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Lax" });
    return;
  }
  setCookie(c, SESSION_COOKIE, cookieValue(accounts), {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Whether this browser can sign in as this person: room for one more, or already here. */
export function roomFor(c: Context<AppEnv>, personId: string | null): boolean {
  return canAdd(c.get("accounts"), personId);
}

/**
 * Sign this browser in as a person, as the active account, keeping the others. Signing
 * in again as an account already here replaces its session, revoking the old one.
 * Returns false, and changes nothing, when the browser already holds four others.
 */
export async function signInAs(
  c: Context<AppEnv>,
  deps: SessionDeps,
  personId: string,
): Promise<boolean> {
  const accounts = c.get("accounts");
  if (!canAdd(accounts, personId)) return false;
  const now = deps.now();
  const session = await createSession(deps.storage, personId, { now });
  const resolved = await resolveAccounts(deps.storage, [session.token], { now });
  const fresh = resolved[0];
  if (fresh === undefined) throw new Error("a new session did not resolve");
  const added = addAccount(accounts, fresh);
  if (added.kind === "full") throw new Error("checked above: there was room");
  if (added.replaced !== null) await revokeSession(deps.storage, added.replaced.token, now);
  writeAccountsCookie(c, added.accounts, deps.secureCookies);
  await setAccounts(c, added.accounts);
  return true;
}

/** True only if the submitted form carries this session's CSRF token. */
export async function verifyFormCsrf(
  signedIn: SignedIn,
  form: Record<string, unknown>,
): Promise<boolean> {
  const presented = form.csrf;
  return typeof presented === "string" && (await verifyCsrf(signedIn.sessionToken, presented));
}

/**
 * The page for a form whose CSRF check failed. When the form was rendered for another
 * account on this browser, someone switched in another tab: say so, and that nothing
 * was done (§13 rc18). A form never acts as an account it was not rendered for.
 */
export async function rejectedPage(c: Context<AppEnv>, form: Record<string, unknown>) {
  const presented = form.csrf;
  const active = c.get("signedIn");
  let renderedFor: Account | undefined;
  if (typeof presented === "string") {
    for (const a of c.get("accounts").slice(1)) {
      if (await verifyCsrf(a.token, presented)) renderedFor = a;
    }
  }
  const body =
    renderedFor !== undefined && active !== null
      ? html`<h1>Nothing was changed</h1>
<p>This page was for <strong>${renderedFor.email}</strong>, but you switched to <strong>${active.email}</strong> in another tab.</p>
<p>Switch back from the menu above to try again as ${renderedFor.email}.</p>`
      : html`<h1>Request rejected</h1><p>Please try again.</p>`;
  return c.html(page(c, "Request rejected", body), 403);
}

/**
 * The answer when the active account may not see an event, poll or group page (§13
 * rc18). If another account on this browser can, say so and offer the switch; otherwise
 * the ordinary not-found, naming the account in use. 404 either way, and the same page
 * whether or not the thing exists: only accounts whose sessions this browser already
 * holds are asked, so it tells no one anything they couldn't see by switching.
 */
export async function notVisible(
  c: Context<AppEnv>,
  visibleTo: (personId: string) => Promise<boolean>,
): Promise<Response> {
  const viewer = viewerOf(c);
  if (viewer === null) return c.html(page(c, "Not found", html`<h1>Not found</h1>`), 404);
  for (const other of c.get("accounts").slice(1)) {
    if (await visibleTo(other.personId)) {
      return c.html(
        page(
          c,
          "Another of your accounts",
          html`<h1>This is visible to ${other.email}, also signed in here</h1>
<p>You're viewing as <strong>${viewer.email}</strong>, who can't see it.</p>
${switchForm(viewer, other)}`,
        ),
        404,
      );
    }
  }
  return c.html(
    page(
      c,
      "Not found",
      html`<h1>Not found</h1>
<p>You're signed in as <strong>${viewer.email}</strong>.${
        viewer.canAddAccount
          ? html` If this was shared with another of your addresses, <a href="${ADD_ACCOUNT_PATH}">add another account</a>.`
          : ""
      }</p>
<p><a href="/groups">Your groups</a></p>`,
    ),
    404,
  );
}

/** The header's view of this browser's accounts; null when none is signed in. */
export function viewerOf(c: Context<AppEnv>): Viewer | null {
  const active = c.get("signedIn");
  if (active === null) return null;
  return {
    email: active.email,
    csrfToken: active.csrfToken,
    others: c
      .get("accounts")
      .slice(1)
      .map((a) => ({ sessionId: a.sessionId, email: a.email })),
    canAddAccount: canAdd(c.get("accounts"), null),
    // The path only: a query string may carry a token (§13), and never goes in a form.
    here: c.req.path,
  };
}

/** A page in the shared shell, with this browser's accounts in its header. */
export function page(c: Context<AppEnv>, title: string, body: Html): string {
  return renderPage(title, body, viewerOf(c));
}

/**
 * The signed-in person, or a redirect to sign-in. Routes that need a person call
 * this first: `const me = requireSignedIn(c); if (me instanceof Response) return me;`
 */
export function requireSignedIn(c: Context<AppEnv>): SignedIn | Response {
  const signedIn = c.get("signedIn");
  return signedIn ?? c.redirect("/auth/sign-in", 303);
}
