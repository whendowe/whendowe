// SPDX-License-Identifier: AGPL-3.0-or-later

// HTTPS mail port (DESIGN.md §6): raw SMTP is unavailable from Workers, so mail is
// an HTTPS transactional API behind this seam. Provider: Cloudflare Email Service
// (rc9), sending from the notify. subdomain, always behind the cap in capped.ts.
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /**
   * Caused by someone with no session: a sign-in link. Counted against the cap's
   * anonymous share as well as the whole (DESIGN §13 rc21).
   */
  readonly anonymous?: boolean;
  /**
   * What caused it (DESIGN §10 rc24): the address's own request (a sign-in link, the
   * deletion email), which no opt-out stops; or someone else, perhaps through a group,
   * which an opt-out may stop and which carries the opt-out link. Required, so no send
   * can leave it out.
   */
  readonly cause: MailCause;
}

export type MailCause =
  | { readonly kind: "self" }
  | {
      readonly kind: "from";
      readonly senderId: string;
      readonly groupId: string | null;
      /** "dm invited you to “Thursday Table”": the footer's "You got this because …". */
      readonly why: string;
    };

export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

/**
 * The adapter used when no provider is configured: it refuses every send.
 *
 * Fail closed on purpose. The obvious alternative — fall back to the console
 * adapter — would make a misconfigured production instance print magic-link
 * tokens into its logs, where anyone who can read logs can sign in as anyone
 * (§13: never log tokens). Development opts in to the console explicitly.
 */
export const disabledMailPort: MailPort = {
  send: () =>
    Promise.reject(
      new Error("mail is not configured (MAIL_PROVIDER is 'disabled'); refusing to send"),
    ),
};
