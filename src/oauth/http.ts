// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ZodType, z } from "zod";

// The minimal HTTP surface the Google OAuth/Calendar calls need (DESIGN.md §6:
// "Google Calendar via plain REST fetch — no SDK").
//
// FetchLike is declared structurally rather than as `typeof fetch` on purpose: the
// root tsconfig types `fetch` from @types/node and the workers tsconfig from
// @cloudflare/workers-types, and those two signatures are not identical. Depending
// on either would tie this module to one runtime. The real `fetch` satisfies this
// interface on both, and a test fake satisfies it in three lines.

export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

// Google returns either {error: "code", error_description: "..."} (OAuth) or
// {error: {message: "..."}} (API). Parsed with zod rather than hand-narrowed casts
// — AGENTS.md forbids `as`, and this is untrusted upstream input anyway.
const errorBodySchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string().optional() })]).optional(),
  error_description: z.string().optional(),
});

function describeErrorBody(body: string): string {
  // Only the error code and description are surfaced; the raw body is never
  // interpolated, because an upstream error echoing part of the request would put
  // the authorization code or client secret into our logs (§13/§14).
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "unparseable error body";
  }

  const result = errorBodySchema.safeParse(parsed);
  if (!result.success) {
    return "unrecognized error body";
  }

  const { error, error_description: description } = result.data;
  if (typeof error === "string") {
    return description === undefined ? error : `${error}: ${description}`;
  }
  if (error !== undefined && error.message !== undefined) {
    return error.message;
  }
  return "unrecognized error body";
}

/**
 * A non-2xx response, carrying the status so callers can branch on it.
 *
 * Needed because some statuses are protocol, not failure: Google answers an
 * expired sync cursor with 410 GONE, which means "start a full resync" (§12), not
 * "something broke". The message still carries only the status and Google's own
 * error code.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, context: string, detail: string) {
    super(`${context} failed: HTTP ${status} (${detail})`);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Make a request and validate the JSON response against `schema`.
 *
 * `context` labels errors (e.g. "token exchange"). Errors carry the HTTP status
 * and Google's own error code — never the request body, which holds the client
 * secret and authorization code.
 */
export async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: HttpRequestInit,
  schema: ZodType<T>,
  context: string,
): Promise<T> {
  const response = await fetchImpl(url, init);
  const body = await response.text();

  if (!response.ok) {
    throw new HttpError(response.status, context, describeErrorBody(body));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${context} returned a non-JSON body`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    // Field paths only. A zod error can echo received values, and this body
    // contains access and refresh tokens.
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`${context} returned an unexpected shape; offending fields: ${fields}`);
  }
  return result.data;
}

/** Form-encode a body for the token endpoint. */
export function formEncode(fields: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value);
  }
  return params.toString();
}
