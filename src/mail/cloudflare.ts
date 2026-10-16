// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { defaultFetch, type FetchLike, requestJson } from "../oauth/http.js";
import type { MailMessage, MailPort } from "./port.js";

// Cloudflare Email Service (DESIGN rc9). Two adapters, one per deployment target:
//
//   binding — the hosted Workers instance. `env.EMAIL` is a send_email binding: no
//             API key exists anywhere, so there is no mail credential to leak.
//   REST    — Node self-hosters. POST /accounts/{id}/email/sending/send with a token
//             carrying the Email Sending permission.
//
// Both are always wrapped by capped.ts; neither is ever handed out bare.
//
// The binding is typed structurally (EmailBindingLike) rather than imported from
// @cloudflare/workers-types, for the same reason FetchLike is: domain code stays
// platform-blind (§16), and a test fake satisfies it in a line.

export interface MailFrom {
  /** On the onboarded sending domain, e.g. login@notify.whendowe.org. */
  readonly address: string;
  readonly name: string;
}

/** The slice of the Workers send_email binding this adapter uses. */
export interface EmailBindingLike {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

function bindingErrorCode(error: unknown): string {
  // Binding errors carry a string code (E_*). Only the code is surfaced: a raw
  // message could echo the recipient address, which is personal data in a log.
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

export function cloudflareBindingMailPort(binding: EmailBindingLike, from: MailFrom): MailPort {
  return {
    async send(message: MailMessage): Promise<void> {
      try {
        await binding.send({
          to: message.to,
          from: { email: from.address, name: from.name },
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
        });
      } catch (error) {
        throw new Error(`cloudflare email binding send failed (${bindingErrorCode(error)})`);
      }
    },
  };
}

const restResponseSchema = z.object({
  success: z.boolean(),
  result: z
    .object({
      delivered: z.array(z.string()).nullish(),
      permanent_bounces: z.array(z.string()).nullish(),
      queued: z.array(z.string()).nullish(),
    })
    .nullish(),
});

export interface CloudflareRestOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly from: MailFrom;
  readonly fetchImpl?: FetchLike;
}

export function cloudflareRestMailPort(options: CloudflareRestOptions): MailPort {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/email/sending/send`;
  return {
    async send(message: MailMessage): Promise<void> {
      const response = await requestJson(
        options.fetchImpl ?? defaultFetch,
        url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            to: message.to,
            // REST uses `address` where the binding uses `email`.
            from: { address: options.from.address, name: options.from.name },
            subject: message.subject,
            text: message.text,
            ...(message.html === undefined ? {} : { html: message.html }),
          }),
        },
        restResponseSchema,
        "cloudflare email send",
      );
      if (!response.success) {
        throw new Error("cloudflare email send reported success: false");
      }
      // A permanent bounce is a failed send even though the call returned 200: for a
      // magic link it means the person will never receive it, and the caller must
      // say so rather than show "check your inbox". The address is not echoed.
      if ((response.result?.permanent_bounces ?? []).length > 0) {
        throw new Error("cloudflare email send: recipient permanently bounced");
      }
    },
  };
}
