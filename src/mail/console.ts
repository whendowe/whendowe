// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MailMessage, MailPort } from "./port.js";

// Development adapter: prints the whole message instead of sending it, so MVP-1 can
// be worked on with no mail credentials — the magic link appears in the terminal.
//
// It prints TOKENS. That is the point in development and a credential leak anywhere
// else, which is why it is never a default: only an explicit MAIL_PROVIDER=console
// selects it (see disabledMailPort in port.ts).
export function consoleMailPort(log: (line: string) => void = console.log): MailPort {
  return {
    send(message: MailMessage): Promise<void> {
      log(
        [
          "──── mail (console adapter: NOT sent) ────",
          `To:      ${message.to}`,
          `Subject: ${message.subject}`,
          "",
          message.text,
          "──────────────────────────────────────────",
        ].join("\n"),
      );
      return Promise.resolve();
    },
  };
}
