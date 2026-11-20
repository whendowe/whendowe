// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { diff } from "../changelog.js";
import type { TokenCipher } from "../crypto/tokens.js";
import { type SqlStatement, type StoragePort, stmt } from "../db/port.js";
import type { ProjectionRow } from "../db/schema.js";
import {
  eventFieldsSchema,
  fieldEditStatements,
  fieldsAtRevision,
  findEventForParticipant,
  flatten,
} from "../events/event.js";
import { proposeChange } from "../events/proposal.js";
import { feedEntries } from "../feeds/feed.js";
import { noticeStatement } from "../held.js";
import type { MailPort } from "../mail/port.js";
import { HttpError } from "../oauth/http.js";
import { type CapabilityConfig, hasCapability } from "../people/capability.js";
import type { CalendarProvider, ChangeBatch, ProviderEvent } from "../providers/base.js";
import { ProviderEventGoneError, SyncTokenExpiredError } from "../providers/base.js";
import { type Action, actionReason, assertNever, type LogReason } from "./actions.js";
import { fromCopy, type InboundFields, mergeInbound } from "./conflict.js";
import { type DesiredCopy, decidePull, decidePush, nextRetryAt } from "./decide.js";
import { parseRing, pushWrite } from "./echo.js";
import { fieldsHash, projectEntry } from "./project.js";
import { channelDue, renewChannel, stopChannel } from "./watch.js";

// One reconcile tick for one connection (DESIGN.md §11). PUSH (rc40): the calendar holds what
// the person's feed holds, at their tier. PULL (rc53), when the tick is asked to read: changes
// made in Google come in first, so the push that follows starts from the merged event. Orchestration over the ports —
// the imperative shell around the pure decidePush(). What it must uphold (§9): idempotency,
// convergence, and the steady-state ZERO-WRITE path (§6): when every copy matches, nothing is
// written and Google is not called, so no token is refreshed either.
export interface TickPorts {
  readonly storage: StoragePort;
  readonly cipher: TokenCipher;
  readonly capabilities: CapabilityConfig;
  /** A fresh access token from a refresh token (§12): token-exchange's refreshAccessToken. */
  readonly refresh: (
    refreshToken: string,
  ) => Promise<{ readonly accessToken: string; readonly expiresAt: string }>;
  /** The provider for a connection's calendar; it asks for a token only when it calls out. */
  readonly providerFor: (
    calendarId: string,
    getAccessToken: () => Promise<string>,
  ) => CalendarProvider;
  /** An event's page, the link each copy carries (rc40). */
  readonly eventUrl: (eventId: string) => string;
  /** Give a grant back to Google (§10 rc40 disconnect): token-exchange's revokeGoogleGrant. */
  readonly revoke: (refreshToken: string) => Promise<boolean>;
  readonly now: () => string; // injected clock (ISO-8601 UTC) — simulator-friendly (§9)
  readonly newNonce: () => string; // injected nonce generator
  readonly newId: () => string;
  /**
   * Where Google's push notifications go (rc53, routes/hooks.ts), or null where push channels
   * are off — the instance hasn't turned them on — and the 6-hour backstop is all there is.
   */
  readonly hookUrl: string | null;
}

/** What a tick did, by event id and §14 reason — ids only, never content (§14). */
export interface TickResult {
  /**
   * `skipped`: no active connection, or no `calendar_sync` (rc43) — nothing touched.
   * `auth_error`: Google refused the grant; the connection is marked and the tick stopped.
   * `deferred`: a token couldn't be had for another reason; the next tick tries again.
   * `disconnected`: a connection being disconnected has no copies left, or Google refused its
   * grant; the grant is given back and the connection deleted (rc40).
   */
  readonly outcome: "done" | "skipped" | "auth_error" | "deferred" | "disconnected";
  readonly decisions: readonly { readonly eventId: string; readonly reason: LogReason }[];
  /** rc53: a push channel made or replaced this tick, or Google refusing one. */
  readonly channel?: "made" | "failed";
}

/**
 * At most this many connections are ticked in one minute (§11 cron fan-out): one call out each
 * on Workers, where a scheduled run may make only so many. Past it they take turns, a share a
 * minute, so every one is still ticked within a few minutes.
 */
export const FAN_OUT_MAX = 40;

/**
 * The connections to tick in the minute `at`: every active one, or past `max`, this minute's
 * share in turn. Reads only: scheduling writes nothing (§6, §16).
 */
export async function connectionsToTick(
  storage: StoragePort,
  at: string,
  max: number = FAN_OUT_MAX,
): Promise<string[]> {
  const ids = (
    await storage.query(
      // A disconnected connection is ticked until its copies are removed (rc40).
      stmt(
        "SELECT id FROM calendar_connection WHERE status IN ('active', 'disconnected') ORDER BY id",
      ),
    )
  ).map((r) => idRowSchema.parse(r).id);
  if (ids.length <= max) return ids;
  const turn = Math.floor(Date.parse(at) / 60_000) % Math.ceil(ids.length / max);
  return ids.slice(turn * max, (turn + 1) * max);
}

const idRowSchema = z.object({ id: z.string() });

/**
 * The backstop (rc53): Google doesn't promise every push notification arrives, so each
 * connection is also read once every this many minutes.
 */
export const PULL_EVERY_MINUTES = 6 * 60;

/**
 * A connection's own minute in every PULL_EVERY_MINUTES, from its id (FNV-1a), so reads are
 * spread out and the backstop keeps no clock: nothing is written to remember when it ran.
 */
export function pullTurn(connectionId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < connectionId.length; i += 1) {
    h ^= connectionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % PULL_EVERY_MINUTES;
}

/**
 * What to tick in the minute `at`, and which of them to read first (rc53): this minute's share
 * (connectionsToTick), and every active connection whose turn to be read it is, ticked whether
 * or not its share is now, so a long rotation can't make it miss its turn. Reads only (§6).
 */
export async function ticksDue(
  storage: StoragePort,
  at: string,
  max: number = FAN_OUT_MAX,
): Promise<{ readonly connectionId: string; readonly pull: boolean }[]> {
  const minute = Math.floor(Date.parse(at) / 60_000) % PULL_EVERY_MINUTES;
  const reading = new Set(
    (
      await storage.query(
        stmt("SELECT id FROM calendar_connection WHERE status = 'active' ORDER BY id"),
      )
    )
      .map((r) => idRowSchema.parse(r).id)
      .filter((id) => pullTurn(id) === minute),
  );
  const share = await connectionsToTick(storage, at, max);
  const ids = [...new Set([...share, ...reading])];
  return ids.map((connectionId) => ({ connectionId, pull: reading.has(connectionId) }));
}

/**
 * A tick's log line (§14): its outcome and how many decisions of each reason, by connection
 * id — never event content. Null for a quiet tick (nothing but `skipped_unchanged`) or a
 * skipped one, so a steady state logs nothing.
 */
export function tickLog(
  connectionId: string,
  result: TickResult,
): Record<string, string | number> | null {
  if (result.outcome === "skipped") return null;
  const counts: Record<string, number> = {};
  for (const d of result.decisions)
    if (d.reason !== "skipped_unchanged") counts[d.reason] = (counts[d.reason] ?? 0) + 1;
  if (result.outcome === "done" && Object.keys(counts).length === 0) return null;
  return { reason: "push_tick", connection: connectionId, outcome: result.outcome, ...counts };
}

/**
 * A tick that threw, for the log (§14): the error's kind only. Its message could carry
 * anything — a statement, a response body — so it is not logged.
 */
export function tickFailureLog(connectionId: string, error: unknown): Record<string, string> {
  return {
    reason: "push_tick_failed",
    connection: connectionId,
    error: error instanceof Error ? error.name : typeof error,
  };
}

/** A token refresh margin: a token this close to expiry is refreshed first. */
const TOKEN_MARGIN_MS = 60_000;

const connectionSchema = z.object({
  owner_id: z.string(),
  status: z.enum(["active", "disconnected"]),
  calendar_id: z.string(),
  access_token_enc: z.string(),
  refresh_token_enc: z.string(),
  token_expiry: z.string().nullable(),
  sync_token: z.string().nullable(),
  watch_channel: z.string().nullable(),
  watch_resource_id: z.string().nullable(),
  watch_expires_at: z.string().nullable(),
});

const projectionSchema = z
  .object({
    id: z.string(),
    canonical_event_id: z.string(),
    calendar_connection_id: z.string(),
    visibility_profile: z.string(),
    provider_event_id: z.string().nullable(),
    provider_etag: z.string().nullable(),
    last_pushed_hash: z.string().nullable(),
    recent_write_nonces: z.string(),
    base_revision: z.number().nullable(),
    state: z.string(),
    last_error: z.string().nullable(),
    retry_at: z.string().nullable(),
    unsubscribed_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform(
    (r): ProjectionRow => ({
      id: r.id,
      canonicalEventId: r.canonical_event_id,
      calendarConnectionId: r.calendar_connection_id,
      visibilityProfile: r.visibility_profile,
      providerEventId: r.provider_event_id,
      providerEtag: r.provider_etag,
      lastPushedHash: r.last_pushed_hash,
      recentWriteNonces: r.recent_write_nonces,
      baseRevision: r.base_revision,
      state: r.state,
      lastError: r.last_error,
      retryAt: r.retry_at,
      unsubscribedAt: r.unsubscribed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );

/** Google refused the grant: revoked, or expired (§12). */
class AuthLost extends Error {}
/** No token for another reason — Google down, the network — so nothing is recorded. */
class NoToken extends Error {}

/** 400 and 401 from the token endpoint mean the grant is gone (invalid_grant). */
function refusesGrant(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 400 || error.status === 401);
}

/** What last_error keeps: Google's status and error code, or the error's kind — never content. */
function errorText(error: unknown): string {
  if (error instanceof HttpError) return error.message.slice(0, 200);
  return error instanceof Error ? error.name : "unknown error";
}

interface Want extends DesiredCopy {
  readonly revision: number;
  readonly visibility: string;
}

export async function runTick(
  ports: TickPorts,
  connectionId: string,
  /** `pull`: read what changed in Google first (rc53) — the backstop's turn, or a push poke. */
  options: { readonly pull?: boolean } = {},
): Promise<TickResult> {
  const { storage } = ports;
  const [row] = await storage.query(
    stmt(
      `SELECT owner_id, status, calendar_id, access_token_enc, refresh_token_enc, token_expiry,
              sync_token, watch_channel, watch_resource_id, watch_expires_at
         FROM calendar_connection WHERE id = ? AND status IN ('active', 'disconnected')`,
      connectionId,
    ),
  );
  if (row === undefined) return { outcome: "skipped", decisions: [] };
  const conn = connectionSchema.parse(row);
  // Disconnecting with "Remove them" (rc40): nothing is wanted, so every copy is removed.
  const leaving = conn.status === "disconnected";
  // Without calendar_sync the copies are left as they are (rc43): losing it deletes nothing.
  // Removing them on disconnecting still works without it.
  if (
    !leaving &&
    !(await hasCapability(storage, ports.capabilities, conn.owner_id, "calendar_sync"))
  ) {
    return { outcome: "skipped", decisions: [] };
  }
  const now = ports.now();

  // The token, fetched on the first call out and refreshed (and kept) only if it must be.
  let token: Promise<string> | null = null;
  const getAccessToken = (): Promise<string> => {
    token ??= (async () => {
      if (
        conn.token_expiry !== null &&
        Date.parse(conn.token_expiry) - Date.parse(now) > TOKEN_MARGIN_MS
      ) {
        return ports.cipher.decrypt(conn.access_token_enc);
      }
      const fresh = await ports.refresh(await ports.cipher.decrypt(conn.refresh_token_enc));
      await storage.batch([
        stmt(
          `UPDATE calendar_connection SET access_token_enc = ?, token_expiry = ?, updated_at = ?
             WHERE id = ?`,
          await ports.cipher.encrypt(fresh.accessToken),
          fresh.expiresAt,
          now,
          connectionId,
        ),
      ]);
      return fresh.accessToken;
    })().catch((error: unknown) => {
      throw refusesGrant(error) ? new AuthLost() : new NoToken();
    });
    return token;
  };
  const provider = ports.providerFor(conn.calendar_id, getAccessToken);

  const decisions: { eventId: string; reason: LogReason }[] = [];
  if (options.pull === true && !leaving) {
    try {
      decisions.push(...(await pull(ports, provider, { connectionId, conn, now })));
    } catch (error) {
      if (error instanceof AuthLost || (error instanceof HttpError && error.status === 401)) {
        await storage.batch([authError(connectionId, now)]);
        return { outcome: "auth_error", decisions };
      }
      if (error instanceof NoToken) return { outcome: "deferred", decisions };
      throw error;
    }
  }

  const wanted = new Map<string, Want>();
  for (const entry of leaving
    ? []
    : await feedEntries(
        storage,
        { personId: conn.owner_id, groupId: null, ownCalendar: true },
        { now, eventUrl: ports.eventUrl },
      )) {
    if (entry.status !== "scheduled") continue; // a cancelled entry is a copy to remove
    const fields = projectEntry(entry);
    wanted.set(entry.id, {
      fields,
      hash: await fieldsHash(fields),
      revision: entry.revision,
      visibility: entry.visibility,
    });
  }
  const existing = new Map<string, ProjectionRow>();
  for (const r of await storage.query(
    stmt("SELECT * FROM projection WHERE calendar_connection_id = ?", connectionId),
  )) {
    const p = projectionSchema.parse(r);
    existing.set(p.canonicalEventId, p);
  }

  const ids = [...new Set([...wanted.keys(), ...existing.keys()])].sort();
  for (const eventId of ids) {
    const want = wanted.get(eventId) ?? null;
    const previous = existing.get(eventId) ?? null;
    const action = decidePush(want, previous, now);
    if (action.kind === "noop") continue; // steady state: no write, no call (§6)
    const record = (change: Change): SqlStatement =>
      upsertProjection(ports, { connectionId, eventId, previous, now, change });
    try {
      const reason = await apply(ports, provider, action, { eventId, want, previous, now }, record);
      decisions.push({ eventId, reason });
    } catch (error) {
      if (error instanceof AuthLost || (error instanceof HttpError && error.status === 401)) {
        // Being disconnected, the copies left can't be removed: the connection goes anyway.
        if (leaving) {
          await storage.batch(forgetConnection(connectionId));
          return { outcome: "disconnected", decisions };
        }
        await storage.batch([authError(connectionId, now)]);
        return { outcome: "auth_error", decisions };
      }
      if (error instanceof NoToken) return { outcome: "deferred", decisions };
      await storage.batch([
        record({
          state: "error",
          lastError: errorText(error),
          retryAt: nextRetryAt(now, previous),
        }),
      ]);
      decisions.push({ eventId, reason: "retry_scheduled" });
    }
  }
  const state = {
    channel: conn.watch_channel,
    resourceId: conn.watch_resource_id,
    expiresAt: conn.watch_expires_at,
  };
  if (leaving && (await copiesOn(storage, connectionId)) === 0) {
    await stopChannel(provider, state);
    await ports.revoke(await ports.cipher.decrypt(conn.refresh_token_enc));
    await storage.batch(forgetConnection(connectionId));
    return { outcome: "disconnected", decisions };
  }
  // rc53: the push channel, made or replaced within a day of its expiry. A quiet tick with a
  // channel that has days left writes nothing and calls nothing (§6).
  if (!leaving && ports.hookUrl !== null && channelDue(state, now)) {
    try {
      const channel = await renewChannel(provider, storage, {
        connectionId,
        state,
        hookUrl: ports.hookUrl,
        now,
        newId: ports.newId,
        isTheCallers: (error) => lostGrant(error) || error instanceof NoToken,
      });
      return { outcome: "done", decisions, channel };
    } catch (error) {
      if (lostGrant(error)) {
        await storage.batch([authError(connectionId, now)]);
        return { outcome: "auth_error", decisions };
      }
      if (error instanceof NoToken) return { outcome: "deferred", decisions };
      throw error;
    }
  }
  return { outcome: "done", decisions };
}

/** The grant is gone: the refresh was refused, or the calendar answered 401. */
function lostGrant(error: unknown): boolean {
  return error instanceof AuthLost || (error instanceof HttpError && error.status === 401);
}

/** Google refused the grant (§12): the connection waits for its person to reconnect. */
function authError(connectionId: string, now: string): SqlStatement {
  return stmt(
    `UPDATE calendar_connection SET status = 'auth_error', updated_at = ?
       WHERE id = ? AND status = 'active'`,
    now,
    connectionId,
  );
}

/** A rival edit landing between reading the event and writing the merge: try this often. */
const TAKE_IN_ATTEMPTS = 3;

/**
 * PULL (§11, rc53): read what changed on the connection's calendar since its cursor, and
 * decide each change (decidePull). Our own writes read back are echoes; a copy deleted there
 * is its person unsubscribing (rc45); an editor's change is merged in (mergeInbound). The
 * cursor is kept after the changes it covers, and only when Google moved it, so a quiet read
 * writes nothing (§6). A change applied twice — a read repeated after a crash — merges to
 * nothing the second time (§11 "inbound apply is idempotent").
 */
async function pull(
  ports: TickPorts,
  provider: CalendarProvider,
  at: {
    readonly connectionId: string;
    readonly conn: z.infer<typeof connectionSchema>;
    readonly now: string;
  },
): Promise<{ eventId: string; reason: LogReason }[]> {
  const { storage } = ports;
  const { connectionId, conn, now } = at;
  let batch: ChangeBatch;
  try {
    batch = await provider.listChanges(conn.sync_token);
  } catch (error) {
    // The cursor expired (§12): read everything. The reverse diff — copies deleted while the
    // cursor was dead — is T4's.
    if (!(error instanceof SyncTokenExpiredError)) throw error;
    batch = await provider.listChanges(null);
  }
  const copies = new Map<string, ProjectionRow>();
  for (const r of await storage.query(
    stmt("SELECT * FROM projection WHERE calendar_connection_id = ?", connectionId),
  )) {
    const p = projectionSchema.parse(r);
    copies.set(p.canonicalEventId, p);
  }
  const decisions: { eventId: string; reason: LogReason }[] = [];
  for (const change of batch.changes) {
    const uid = change.metadata.canonicalUid ?? null;
    const copy = uid === null ? null : (copies.get(uid) ?? null);
    const action = decidePull(copy, change, await fieldsHash(change.fields));
    switch (action.kind) {
      case "noop":
        break;
      case "skip_instance":
        // Only one of ours is worth a line: the person's own series are their business.
        if (copy !== null)
          decisions.push({ eventId: copy.canonicalEventId, reason: "skipped_instance_edit" });
        break;
      case "suppress_echo":
        if (copy !== null)
          decisions.push({ eventId: copy.canonicalEventId, reason: "echo_suppressed" });
        break;
      case "unsubscribe":
        if (copy === null) break;
        await storage.batch([
          upsertProjection(ports, {
            connectionId,
            eventId: copy.canonicalEventId,
            previous: copy,
            now,
            change: {
              state: "deleted",
              providerEventId: null,
              providerEtag: null,
              lastPushedHash: null,
              lastError: null,
              retryAt: null,
              unsubscribedAt: now,
            },
          }),
        ]);
        decisions.push({ eventId: copy.canonicalEventId, reason: "inbound_delete_unsubscribed" });
        break;
      case "apply_inbound": {
        if (copy === null) break;
        const reason = await takeIn(ports, {
          connectionId,
          copy,
          incoming: action.incoming,
          ownerId: conn.owner_id,
          now,
        });
        if (reason !== null) decisions.push({ eventId: copy.canonicalEventId, reason });
        break;
      }
      case "create_mirror":
      case "adopt_orphan":
      case "push":
      case "delete_mirror":
        throw new Error(`${action.kind} is PUSH's, never PULL's`);
      default:
        assertNever(action);
    }
  }
  if (batch.nextSyncToken !== conn.sync_token) {
    await storage.batch([
      stmt(
        "UPDATE calendar_connection SET sync_token = ? WHERE id = ?",
        batch.nextSyncToken,
        connectionId,
      ),
    ]);
  }
  return decisions;
}

/** The parts of an event a copy can bring back (rc53). */
function inbound(f: InboundFields): InboundFields {
  return {
    title: f.title,
    description: f.description,
    location: f.location,
    startLocal: f.startLocal,
    endLocal: f.endLocal,
    tzid: f.tzid,
    allDay: f.allDay,
  };
}

/**
 * A change from Google, merged into the event (rc53) and done as the person may do it here,
 * by their edit tier (§11):
 *   - `edit`: written as their edit, from Google — "changed it in Google";
 *   - `propose`: made their proposal (WORKFLOWS §5), their copy put back until it is accepted;
 *   - `view`: their copy put back.
 * Either of the last two is told in one email, held for the minute's pass (rc54), at most one a
 * day per person per event. A change only to what never comes back — reminders, the copy's
 * link — merges to nothing and is left alone. Null when there is no event to change: it is
 * gone, or no longer agreed.
 */
async function takeIn(
  ports: TickPorts,
  at: {
    readonly connectionId: string;
    readonly copy: ProjectionRow;
    readonly incoming: ProviderEvent;
    readonly ownerId: string;
    readonly now: string;
  },
): Promise<LogReason | null> {
  const { storage } = ports;
  for (let attempt = 0; attempt < TAKE_IN_ATTEMPTS; attempt += 1) {
    const access = await findEventForParticipant(storage, at.copy.canonicalEventId, at.ownerId);
    if (access === null || access.event.status !== "scheduled") return null;
    const current = access.event;
    const base =
      at.copy.baseRevision === null
        ? current
        : await fieldsAtRevision(storage, current, at.copy.baseRevision);
    const merge = mergeInbound({
      base: inbound(base),
      current: inbound(current),
      incoming: fromCopy(at.incoming.fields),
      visibility: access.participation.visibility,
    });
    if (merge.applied.length === 0) return "skipped_unchanged";
    const tier = access.participation.editTier;
    const moved = merge.applied.includes("time");
    // The copy is put back by the push that follows in this tick: pending_update is pushed.
    const putBack = (outcome: "proposed" | "put_back"): SqlStatement[] => [
      upsertProjection(ports, {
        connectionId: at.connectionId,
        eventId: current.id,
        previous: at.copy,
        now: at.now,
        change: { state: "pending_update" },
      }),
      noticeStatement({
        actorId: at.ownerId,
        eventId: current.id,
        args: { outcome, moved },
        now: at.now,
        newId: ports.newId,
      }),
    ];
    if (tier === "view") {
      await storage.batch(putBack("put_back"));
      return "inbound_put_back";
    }
    const parsed = eventFieldsSchema.safeParse({ ...current, ...merge.fields });
    // Google allows nothing the form refuses that we know of; if it ever does, the event is
    // left as it is and the next push puts the copy back.
    if (!parsed.success) return "error";
    if (tier === "propose") {
      const proposed = await proposeChange(storage, access, {
        fields: parsed.data,
        now: at.now,
        expectedRevision: current.revision,
        newId: ports.newId,
      });
      switch (proposed.kind) {
        case "proposed":
          await storage.batch(putBack("proposed"));
          return "inbound_proposed";
        case "unchanged":
          return "skipped_unchanged";
        case "conflict":
          continue; // someone's edit landed first: merge again against it
        case "forbidden":
        case "closed":
        case "limit":
          // No longer theirs to propose, or past the most proposals one person may make.
          await storage.batch(putBack("put_back"));
          return "inbound_put_back";
        default:
          return assertNever(proposed);
      }
    }
    const change = diff(flatten(current), flatten(parsed.data));
    if (Object.keys(change).length === 0) return "skipped_unchanged";
    try {
      await storage.batch(
        fieldEditStatements({
          eventId: current.id,
          expected: current.revision,
          fields: parsed.data,
          change,
          actorId: at.ownerId,
          now: at.now,
          source: "inbound_sync",
        }),
      );
    } catch {
      continue; // UNIQUE(event, revision): someone else's edit landed first; merge again
    }
    const [written] = await storage.query(
      stmt(
        "SELECT actor, source FROM change_log WHERE canonical_event_id = ? AND revision = ?",
        current.id,
        current.revision + 1,
      ),
    );
    if (written?.actor === at.ownerId && written.source === "inbound_sync")
      return "inbound_applied";
  }
  return "error";
}

/** How many of WhenDoWe's copies a connection has in Google now (rc40: "Also remove the 23"). */
export async function copiesOn(storage: StoragePort, connectionId: string): Promise<number> {
  const [row] = await storage.query(
    stmt(
      `SELECT COUNT(*) AS n FROM projection
        WHERE calendar_connection_id = ? AND provider_event_id IS NOT NULL AND state <> 'deleted'`,
      connectionId,
    ),
  );
  return z.object({ n: z.number() }).parse(row).n;
}

/**
 * A connection's rows, deleted (rc40 disconnect): its tokens, its copies' records and its busy
 * calendars. Kept copies still carry their canonical id in Google, so connecting again adopts
 * them (§11) without these.
 */
export function forgetConnection(connectionId: string): SqlStatement[] {
  return [
    stmt("DELETE FROM projection WHERE calendar_connection_id = ?", connectionId),
    stmt("DELETE FROM busy_calendar WHERE connection_id = ?", connectionId),
    stmt("DELETE FROM calendar_connection WHERE id = ?", connectionId),
  ];
}

/** Carry out one action against Google, then record it. Returns its §14 reason. */
async function apply(
  ports: TickPorts,
  provider: CalendarProvider,
  action: Exclude<Action, { readonly kind: "noop" }>,
  at: {
    readonly eventId: string;
    readonly want: Want | null;
    readonly previous: ProjectionRow | null;
    readonly now: string;
  },
  record: (change: Change) => SqlStatement,
): Promise<LogReason> {
  const { eventId, want, previous, now } = at;
  switch (action.kind) {
    case "create_mirror":
    case "push": {
      if (want === null) throw new Error("a copy to write has a desired state");
      // A copy we made whose id was never recorded — a crash between Google and storage — is
      // found by its canonical id and taken over, never duplicated (§11).
      const orphan =
        action.kind === "create_mirror" ? await provider.findByMetadata(eventId) : null;
      const target = action.kind === "push" ? action.providerEventId : (orphan?.id ?? null);
      const nonce = ports.newNonce();
      try {
        const written = await provider.upsert(target, action.fields, {
          canonicalUid: eventId,
          writeNonce: nonce,
        });
        await ports.storage.batch([synced(record, previous, want, written, nonce)]);
      } catch (error) {
        if (!(error instanceof ProviderEventGoneError)) throw error;
        // Deleted in Google: for this person, never put back (rc40, rc45).
        await ports.storage.batch([
          record({
            state: "deleted",
            providerEventId: null,
            providerEtag: null,
            lastPushedHash: null,
            lastError: null,
            retryAt: null,
            unsubscribedAt: now,
          }),
        ]);
        return "gone_in_provider";
      }
      return orphan === null ? actionReason(action) : "adopted_orphan";
    }
    case "delete_mirror":
      await provider.delete(action.providerEventId);
      await ports.storage.batch([
        record({
          state: "deleted",
          providerEventId: null,
          providerEtag: null,
          lastPushedHash: null,
          lastError: null,
          retryAt: null,
        }),
      ]);
      return actionReason(action);
    case "adopt_orphan":
    case "suppress_echo":
    case "apply_inbound":
    case "unsubscribe":
    case "skip_instance":
      throw new Error(`${action.kind} is PULL's, which MVP-5 adds`);
    default:
      return assertNever(action);
  }
}

function synced(
  record: (change: Change) => SqlStatement,
  previous: ProjectionRow | null,
  want: Want,
  written: { readonly id: string; readonly etag: string },
  nonce: string,
): SqlStatement {
  const ring = parseRing(previous?.recentWriteNonces ?? "[]");
  return record({
    state: "synced",
    providerEventId: written.id,
    providerEtag: written.etag,
    lastPushedHash: want.hash,
    recentWriteNonces: JSON.stringify(pushWrite(ring, [nonce, written.etag])),
    baseRevision: want.revision,
    visibilityProfile: want.visibility,
    lastError: null,
    retryAt: null,
  });
}

type Change = Partial<{
  readonly visibilityProfile: string;
  readonly providerEventId: string | null;
  readonly providerEtag: string | null;
  readonly lastPushedHash: string | null;
  readonly recentWriteNonces: string;
  readonly baseRevision: number | null;
  readonly state: string;
  readonly lastError: string | null;
  readonly retryAt: string | null;
  readonly unsubscribedAt: string | null;
}>;

/**
 * The event's projection on this connection after `change`: one statement, keyed by the
 * (event, connection) unique index, inserting the row the first time. The new row is worked
 * out here from the old one, so the SQL is fixed and only the bound values vary.
 */
function upsertProjection(
  ports: TickPorts,
  input: {
    readonly connectionId: string;
    readonly eventId: string;
    readonly previous: ProjectionRow | null;
    readonly now: string;
    readonly change: Change;
  },
): SqlStatement {
  const base: ProjectionRow = input.previous ?? {
    id: ports.newId(),
    canonicalEventId: input.eventId,
    calendarConnectionId: input.connectionId,
    visibilityProfile: "FULL",
    providerEventId: null,
    providerEtag: null,
    lastPushedHash: null,
    recentWriteNonces: "[]",
    baseRevision: null,
    state: "pending_create",
    lastError: null,
    retryAt: null,
    unsubscribedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const r: ProjectionRow = { ...base, ...input.change, updatedAt: input.now };
  return stmt(
    `INSERT INTO projection
       (id, canonical_event_id, calendar_connection_id, visibility_profile, provider_event_id,
        provider_etag, last_pushed_hash, recent_write_nonces, base_revision, state, last_error,
        retry_at, unsubscribed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(canonical_event_id, calendar_connection_id) DO UPDATE SET
       visibility_profile = excluded.visibility_profile,
       provider_event_id = excluded.provider_event_id,
       provider_etag = excluded.provider_etag,
       last_pushed_hash = excluded.last_pushed_hash,
       recent_write_nonces = excluded.recent_write_nonces,
       base_revision = excluded.base_revision,
       state = excluded.state,
       last_error = excluded.last_error,
       retry_at = excluded.retry_at,
       unsubscribed_at = excluded.unsubscribed_at,
       updated_at = excluded.updated_at`,
    r.id,
    r.canonicalEventId,
    r.calendarConnectionId,
    r.visibilityProfile,
    r.providerEventId,
    r.providerEtag,
    r.lastPushedHash,
    r.recentWriteNonces,
    r.baseRevision,
    r.state,
    r.lastError,
    r.retryAt,
    r.unsubscribedAt,
    r.createdAt,
    r.updatedAt,
  );
}

/** At most this many reconnect emails a minute; the rest go the next minutes. */
export const RECONNECT_MAIL_MAX = 20;

const lostSchema = z.object({ id: z.string(), account_email: z.string(), email: z.string() });

/**
 * "One email says so" (§10 rc40): each connection Google stopped answering for is mailed once,
 * to its owner's own address — mail they caused, like a sign-in link, so it takes nothing from
 * anyone's share (rc37) and no opt-out stops it. Recorded on success only, so a failed send — the
 * cap reached, the provider down — is tried again the next minute, and doesn't stop the others.
 * With nothing to send it reads only (§16). Counts only: an address is never logged (§14).
 */
export async function reconnectMailPass(
  storage: StoragePort,
  mail: MailPort,
  input: { readonly now: string; readonly publicBaseUrl: string },
): Promise<{ readonly sent: number; readonly failed: number }> {
  const rows = await storage.query(
    stmt(
      `SELECT c.id, c.account_email, p.email FROM calendar_connection c
         JOIN person p ON p.id = c.owner_id
        WHERE c.status = 'auth_error' AND c.reconnect_mailed_at IS NULL
        ORDER BY c.id LIMIT ?`,
      RECONNECT_MAIL_MAX,
    ),
  );
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const lost = lostSchema.parse(r);
    try {
      await mail.send({
        to: lost.email,
        subject: "Reconnect Google Calendar",
        text: `Google stopped accepting WhenDoWe's access to ${lost.account_email}, so your WhenDoWe events aren't reaching that calendar any more.

Reconnect it: ${input.publicBaseUrl}/

If you removed WhenDoWe's access on purpose, you can disconnect it there instead.`,
        cause: { kind: "self" },
      });
    } catch {
      failed += 1;
      continue;
    }
    await storage.batch([
      stmt(
        `UPDATE calendar_connection SET reconnect_mailed_at = ?
          WHERE id = ? AND status = 'auth_error'`,
        input.now,
        lost.id,
      ),
    ]);
    sent += 1;
  }
  return { sent, failed };
}
