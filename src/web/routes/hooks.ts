// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import { type StoragePort, stmt } from "../../db/port.js";
import { timingSafeEqual } from "../../oauth/pkce.js";
import { hashToken } from "../../people/tokens.js";
import { GOOGLE_HOOK_PATH } from "../../reconcile/watch.js";
import type { AppEnv } from "../session.js";

// POST /hooks/google (DESIGN §10 rc53, §12): Google's push notification for a channel
// reconcile/watch.ts made. A notification carries no event, only "something changed on this
// calendar", so all it does is ask for that connection to be read.
//
// Google signs nothing, so the channel's own secret is the only proof: the notification must
// name a channel we made, on an active connection, and carry its token, compared in constant
// time against the hash we keep. Anything else is 404 and nothing is read: a forged poke can't
// corrupt anything (identity and echo detection hold), but each one would spend Google's
// quota and ours. Repeats for one connection are coalesced where the read runs (the
// connection's Durable Object, or the Node loop). No session and no CSRF: Google is the
// caller. Nothing here is logged — the headers carry the secret.
//
//   X-Goog-Channel-ID      the channel's id, ours
//   X-Goog-Channel-Token   its secret
//   X-Goog-Resource-State  `sync` when the channel is made (nothing to read yet), else `exists`

export interface HookDeps {
  readonly storage: StoragePort;
  /** Ask for this connection to be read soon (rc53); coalesced by whoever runs the read. */
  readonly poke: (connectionId: string) => Promise<void>;
}

const headersSchema = z.object({
  channel: z.string().min(1).max(256),
  token: z.string().min(1).max(256),
  state: z.string().max(64).optional(),
});

const rowSchema = z.object({ id: z.string(), watch_token_hash: z.string().nullable() });

/** The connection a notification is for, if it proves itself; null otherwise. */
export async function connectionForNotice(
  storage: StoragePort,
  channel: string,
  token: string,
): Promise<string | null> {
  const [row] = await storage.query(
    stmt(
      `SELECT id, watch_token_hash FROM calendar_connection
        WHERE watch_channel = ? AND status = 'active'`,
      channel,
    ),
  );
  if (row === undefined) return null;
  const known = rowSchema.parse(row);
  if (known.watch_token_hash === null) return null;
  return timingSafeEqual(await hashToken(token), known.watch_token_hash) ? known.id : null;
}

/** Keep the read going after answering where the platform allows it (Workers), else wait. */
async function inBackground(c: Context<AppEnv>, work: Promise<void>): Promise<void> {
  let ctx: { waitUntil(p: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null; // Node has no execution context
  }
  if (ctx === null) await work;
  else ctx.waitUntil(work.catch(() => undefined));
}

export function registerHookRoutes(app: Hono<AppEnv>, deps: HookDeps): void {
  app.post(GOOGLE_HOOK_PATH, async (c) => {
    const headers = headersSchema.safeParse({
      channel: c.req.header("x-goog-channel-id"),
      token: c.req.header("x-goog-channel-token"),
      state: c.req.header("x-goog-resource-state"),
    });
    if (!headers.success) return c.body(null, 404);
    const connectionId = await connectionForNotice(
      deps.storage,
      headers.data.channel,
      headers.data.token,
    );
    if (connectionId === null) return c.body(null, 404);
    // `sync` is Google saying the channel now exists: nothing has changed yet.
    if (headers.data.state !== "sync") await inBackground(c, deps.poke(connectionId));
    return c.body(null, 200);
  });
}
