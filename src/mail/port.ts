// SPDX-License-Identifier: AGPL-3.0-or-later

// HTTPS mail port (DESIGN.md §6): raw SMTP is unavailable from Workers, so mail is
// an HTTPS transactional API (e.g. Resend) behind this seam. Needed from M3
// (invites, token links — WORKFLOWS §9 delta 10); the port is the M0 shape.
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface MailPort {
  send(message: MailMessage): Promise<void>;
}
