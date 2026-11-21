// SPDX-License-Identifier: AGPL-3.0-or-later
import { type SqlStatement, stmt } from "../db/port.js";
import { issueToken } from "../people/tokens.js";
import type { CalendarProvider } from "../providers/base.js";

// Push channels (DESIGN.md §10 rc53 *Google Calendar, both ways*, §12): each connection's
// calendar has one, so a change made in Google is read within a minute, not at the 6-hour
// backstop. A channel expires; the tick replaces it within a day of that, a new one first and
// then the old one stopped, so there is never a gap. Its secret is kept hashed: a
// notification must carry it (routes/hooks.ts). A calendar Google won't watch is asked again
// an hour later, never every minute, so a failure can't spend Google's quota.

/** Where Google posts a channel's notifications, on this instance (routes/hooks.ts, T3b). */
export const GOOGLE_HOOK_PATH = "/hooks/google";

/** How long a channel is asked to last. Google may give less; its answer is what is kept. */
export const CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A channel this close to its expiry is replaced. */
export const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;
/** After a failure, when to try making a channel again. */
export const RETRY_WATCH_MS = 60 * 60 * 1000;

/** A connection's channel as stored. With no channel, `expiresAt` is when to try again. */
export interface ChannelState {
  readonly channel: string | null;
  readonly resourceId: string | null;
  readonly expiresAt: string | null;
}

/** Whether a connection needs a channel made or replaced now. Pure; reads nothing. */
export function channelDue(state: ChannelState, now: string): boolean {
  if (state.expiresAt === null) return true;
  const left = Date.parse(state.expiresAt) - Date.parse(now);
  return state.channel === null ? left <= 0 : left <= RENEW_WITHIN_MS;
}

/** The statement that records a channel, or none and when to try again. */
function recordChannel(
  connectionId: string,
  channel: {
    readonly id: string | null;
    readonly tokenHash: string | null;
    readonly resourceId: string | null;
    readonly expiresAt: string;
  },
): SqlStatement {
  return stmt(
    `UPDATE calendar_connection
        SET watch_channel = ?, watch_token_hash = ?, watch_resource_id = ?, watch_expires_at = ?
      WHERE id = ?`,
    channel.id,
    channel.tokenHash,
    channel.resourceId,
    channel.expiresAt,
    connectionId,
  );
}

/**
 * Make a connection's channel, or replace the one it has (rc53): the new one is asked for and
 * recorded first, then the old one stopped, so notifications never stop. If Google refuses,
 * the old one is given up too, and making one is tried again in an hour. Errors that mean the
 * grant is gone are the caller's (the tick marks the connection); stopping an old channel is
 * best effort, since an unstopped one only pokes until it expires, and pokes for a channel we
 * no longer know are refused (routes/hooks.ts).
 */
export async function renewChannel(
  provider: CalendarProvider,
  storage: { batch(statements: readonly SqlStatement[]): Promise<void> },
  input: {
    readonly connectionId: string;
    readonly state: ChannelState;
    readonly hookUrl: string;
    readonly now: string;
    readonly newId: () => string;
    /**
     * Errors that aren't Google refusing the channel — the grant is gone, or no token could be
     * had — and are the caller's: rethrown, never recorded as a refusal.
     */
    readonly isTheCallers: (error: unknown) => boolean;
  },
): Promise<"made" | "failed"> {
  const id = input.newId();
  const secret = await issueToken();
  let outcome: "made" | "failed";
  try {
    const made = await provider.watch({
      id,
      token: secret.token,
      address: input.hookUrl,
      ttlSeconds: CHANNEL_TTL_SECONDS,
    });
    await storage.batch([
      recordChannel(input.connectionId, {
        id,
        tokenHash: secret.hash,
        resourceId: made.resourceId,
        expiresAt: made.expiresAt,
      }),
    ]);
    outcome = "made";
  } catch (error) {
    if (input.isTheCallers(error)) throw error;
    const retry = new Date(Date.parse(input.now) + RETRY_WATCH_MS).toISOString();
    await storage.batch([
      recordChannel(input.connectionId, {
        id: null,
        tokenHash: null,
        resourceId: null,
        expiresAt: retry,
      }),
    ]);
    outcome = "failed";
  }
  await stopChannel(provider, input.state);
  return outcome;
}

/** Stop a connection's channel, if it has one; best effort (see renewChannel). */
export async function stopChannel(provider: CalendarProvider, state: ChannelState): Promise<void> {
  if (state.channel === null || state.resourceId === null) return;
  try {
    await provider.stopWatch({ id: state.channel, resourceId: state.resourceId });
  } catch {
    // It pokes until it expires, and each poke is refused.
  }
}
