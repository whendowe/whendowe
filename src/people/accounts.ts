// SPDX-License-Identifier: AGPL-3.0-or-later

// A browser's signed-in accounts (DESIGN §13 rc18). Pure: no storage, no cookies.
//
// The session cookie carries up to MAX_ACCOUNTS session tokens, the active one first.
// Each is an ordinary session; nothing on the server links them, so the list exists
// only in that browser's cookie. These functions are the rules for changing it, so the
// routes and the property test (tests/property/accounts.property.test.ts) share them.

export const MAX_ACCOUNTS = 4;

/** Session tokens are 32 random bytes, base64url: 43 characters (tokens.ts). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SEPARATOR = ".";

export interface Account {
  /** The raw cookie token. Never rendered. */
  readonly token: string;
  readonly sessionId: string;
  readonly personId: string;
  readonly email: string;
  /** When this account will be deleted, if its deletion was asked for (§10 rc22). */
  readonly deletesAt: string | null;
}

/**
 * The tokens in a cookie value, in order. Anything that is not a token is dropped, as
 * are repeats and any beyond the limit: the cookie is input, not trusted.
 */
export function cookieTokens(value: string | undefined): string[] {
  if (value === undefined) return [];
  const tokens: string[] = [];
  for (const part of value.split(SEPARATOR)) {
    if (TOKEN.test(part) && !tokens.includes(part)) tokens.push(part);
    if (tokens.length === MAX_ACCOUNTS) break;
  }
  return tokens;
}

export function cookieValue(accounts: readonly Account[]): string {
  return accounts.map((a) => a.token).join(SEPARATOR);
}

export type Added =
  | {
      readonly kind: "added";
      readonly accounts: readonly Account[];
      readonly replaced: Account | null;
    }
  | { readonly kind: "full" };

/**
 * Sign in to one more account, which becomes active. Signing in again as an account
 * already here replaces its session (the caller revokes `replaced`). A fifth account
 * is refused rather than pushing one out.
 */
export function addAccount(accounts: readonly Account[], account: Account): Added {
  const replaced = accounts.find((a) => a.personId === account.personId) ?? null;
  const rest = accounts.filter((a) => a.personId !== account.personId);
  if (rest.length >= MAX_ACCOUNTS) return { kind: "full" };
  return { kind: "added", accounts: [account, ...rest], replaced };
}

/** Whether this browser can take another account (or already holds this person's). */
export function canAdd(accounts: readonly Account[], personId: string | null): boolean {
  return accounts.length < MAX_ACCOUNTS || accounts.some((a) => a.personId === personId);
}

/** Make the account with this session active; null if it isn't on this browser. */
export function switchTo(accounts: readonly Account[], sessionId: string): Account[] | null {
  const target = accounts.find((a) => a.sessionId === sessionId);
  if (target === undefined) return null;
  return [target, ...accounts.filter((a) => a !== target)];
}

/** Sign out of the active account only; the next one becomes active. */
export function signOutActive(accounts: readonly Account[]): {
  readonly accounts: readonly Account[];
  readonly signedOut: Account | null;
} {
  return { accounts: accounts.slice(1), signedOut: accounts[0] ?? null };
}
