// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { StoragePort } from "../db/port.js";
import { findPersonById } from "../people/person.js";
import { resolveSession, SESSION_TTL_MS, verifyCsrf } from "../people/session.js";

// Session middleware: the cookie → the signed-in person, on every request (§13).
//
// Cookie: HttpOnly (no script can read it), SameSite=Lax (not sent on cross-site
// POSTs — a first line against CSRF; the per-session token below is the second),
// Secure wherever the instance is served over https, Path=/.

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
  Variables: { signedIn: SignedIn | null };
}

export interface SessionDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
  readonly secureCookies: boolean;
}

export function sessionMiddleware(deps: SessionDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("signedIn", null);
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined && token !== "") {
      const session = await resolveSession(deps.storage, token, { now: deps.now() });
      const person = session === null ? null : await findPersonById(deps.storage, session.personId);
      if (session !== null && person !== null) {
        c.set("signedIn", {
          personId: person.id,
          email: person.email,
          sessionId: session.sessionId,
          sessionToken: token,
          csrfToken: session.csrfToken,
        });
      }
    }
    await next();
  };
}

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Lax" });
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
 * The signed-in person, or a redirect to sign-in. Routes that need a person call
 * this first: `const me = requireSignedIn(c); if (me instanceof Response) return me;`
 */
export function requireSignedIn(c: Context<AppEnv>): SignedIn | Response {
  const signedIn = c.get("signedIn");
  return signedIn ?? c.redirect("/auth/sign-in", 303);
}
