// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { TokenCipher } from "../crypto/tokens.js";
import { type SqlStatement, type StoragePort, stmt } from "../db/port.js";
import type { ProjectionRow } from "../db/schema.js";
import { feedEntries } from "../feeds/feed.js";
import { HttpError } from "../oauth/http.js";
import { type CapabilityConfig, hasCapability } from "../people/capability.js";
import type { CalendarProvider } from "../providers/base.js";
import { ProviderEventGoneError } from "../providers/base.js";
import { type Action, actionReason, assertNever, type LogReason } from "./actions.js";
import { type DesiredCopy, decidePush, nextRetryAt } from "./decide.js";
import { pushNonce } from "./echo.js";
import { fieldsHash, projectEntry } from "./project.js";

// One reconcile tick for one connection (DESIGN.md §11). MVP-4 is PUSH only (rc40): the
// calendar holds what the person's feed holds, at their tier. Orchestration over the ports —
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
  readonly now: () => string; // injected clock (ISO-8601 UTC) — simulator-friendly (§9)
  readonly newNonce: () => string; // injected nonce generator
  readonly newId: () => string;
}

/** What a tick did, by event id and §14 reason — ids only, never content (§14). */
export interface TickResult {
  /**
   * `skipped`: no active connection, or no `calendar_sync` (rc43) — nothing touched.
   * `auth_error`: Google refused the grant; the connection is marked and the tick stopped.
   * `deferred`: a token couldn't be had for another reason; the next tick tries again.
   */
  readonly outcome: "done" | "skipped" | "auth_error" | "deferred";
  readonly decisions: readonly { readonly eventId: string; readonly reason: LogReason }[];
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
      stmt("SELECT id FROM calendar_connection WHERE status = 'active' ORDER BY id"),
    )
  ).map((r) => idRowSchema.parse(r).id);
  if (ids.length <= max) return ids;
  const turn = Math.floor(Date.parse(at) / 60_000) % Math.ceil(ids.length / max);
  return ids.slice(turn * max, (turn + 1) * max);
}

const idRowSchema = z.object({ id: z.string() });

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
  calendar_id: z.string(),
  access_token_enc: z.string(),
  refresh_token_enc: z.string(),
  token_expiry: z.string().nullable(),
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

const ringSchema = z.array(z.string());

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

export async function runTick(ports: TickPorts, connectionId: string): Promise<TickResult> {
  const { storage } = ports;
  const [row] = await storage.query(
    stmt(
      `SELECT owner_id, calendar_id, access_token_enc, refresh_token_enc, token_expiry
         FROM calendar_connection WHERE id = ? AND status = 'active'`,
      connectionId,
    ),
  );
  if (row === undefined) return { outcome: "skipped", decisions: [] };
  const conn = connectionSchema.parse(row);
  // Without calendar_sync the copies are left as they are (rc43): losing it deletes nothing.
  if (!(await hasCapability(storage, ports.capabilities, conn.owner_id, "calendar_sync"))) {
    return { outcome: "skipped", decisions: [] };
  }
  const now = ports.now();

  const wanted = new Map<string, Want>();
  for (const entry of await feedEntries(
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
        await storage.batch([
          stmt(
            `UPDATE calendar_connection SET status = 'auth_error', updated_at = ?
               WHERE id = ? AND status = 'active'`,
            now,
            connectionId,
          ),
        ]);
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
  return { outcome: "done", decisions };
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
  const ring = ringSchema.parse(JSON.parse(previous?.recentWriteNonces ?? "[]"));
  return record({
    state: "synced",
    providerEventId: written.id,
    providerEtag: written.etag,
    lastPushedHash: want.hash,
    recentWriteNonces: JSON.stringify(pushNonce(ring, nonce)),
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
