// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createTokenCipher, type TokenCipher } from "../../src/crypto/tokens.js";
import { type SqlStatement, type StoragePort, stmt } from "../../src/db/port.js";
import {
  createEvent,
  type EventAccess,
  type EventFieldsInput,
  editEvent,
  fieldsAtRevision,
  findEventForParticipant,
  setCancelled,
} from "../../src/events/event.js";
import { setInCalendar } from "../../src/events/participation.js";
import { PROPOSAL_CEILING } from "../../src/events/proposal.js";
import { HttpError } from "../../src/oauth/http.js";
import { type CapabilityConfig, EVERYTHING, grantCapability } from "../../src/people/capability.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { hashToken } from "../../src/people/tokens.js";
import type {
  CalendarProvider,
  EventFields,
  ProviderMetadata,
  UpsertResult,
} from "../../src/providers/base.js";
import { FakeCalendarProvider } from "../../src/providers/fake.js";
import { RETRY_FIRST_MS } from "../../src/reconcile/decide.js";
import {
  connectionsToTick,
  PULL_EVERY_MINUTES,
  pullTurn,
  runTick,
  type TickPorts,
  ticksDue,
} from "../../src/reconcile/tick.js";

// The push tick (DESIGN §11, §10 rc40/rc43/rc45) on BOTH drivers, against the fake provider:
// a calendar converges to what its person's feed holds, a quiet tick writes nothing and calls
// nothing, a copy deleted in Google stays deleted, a failure waits its backoff, and a refused
// grant marks the connection.

const T0 = "2101-10-01T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes: a test key
const url = (id: string) => `https://whendowe.example/events/${id}`;
const FAR = "2102-01-01T00:00:00.000Z"; // a token that won't expire during a test

const DINNER: EventFieldsInput = {
  title: "Dinner",
  description: "Bring wine",
  location: "Ann's",
  allDay: false,
  startLocal: "2101-11-21T18:00",
  endLocal: "2101-11-21T20:00",
  tzid: "Europe/Prague",
};

/** Counts writes, so the zero-write steady state is checked, not assumed (§6). */
interface Counted extends StoragePort {
  writes: number;
  /** Run once just before the next batch that edits an event: a rival edit landing then. */
  beforeEdit: (() => Promise<void>) | null;
}

function counting(port: StoragePort): Counted {
  const counted: Counted = {
    writes: 0,
    beforeEdit: null,
    query: (s: SqlStatement) => {
      if (!/^\s*SELECT/i.test(s.sql)) counted.writes += 1;
      return port.query(s);
    },
    batch: async (s: readonly SqlStatement[]) => {
      const rival = counted.beforeEdit;
      // An edit's batch, or a proposal's (T2): either is where a rival edit can land first.
      if (
        rival !== null &&
        /^\s*(UPDATE canonical_event|INSERT INTO event_change_proposal)/.test(s[0]?.sql ?? "")
      ) {
        counted.beforeEdit = null;
        await rival();
      }
      counted.writes += s.length;
      return port.batch(s);
    },
  };
  return counted;
}

/** The fake, with calls counted, a failure to inject, and the token each call carried. */
class Recording implements CalendarProvider {
  readonly fake = new FakeCalendarProvider();
  calls = 0;
  fail: Error | null = null;
  /** A failure of the write itself, after any lookup. */
  failUpsert: Error | null = null;
  tokens: string[] = [];
  /** The token source of the tick now running. */
  token: () => Promise<string> = () => Promise.reject(new Error("no tick"));
  private async call(): Promise<void> {
    this.calls += 1;
    this.tokens.push(await this.token());
    if (this.fail !== null) throw this.fail;
  }
  async listChanges(t: string | null) {
    await this.call();
    return this.fake.listChanges(t);
  }
  async upsert(id: string | null, f: EventFields, m: ProviderMetadata): Promise<UpsertResult> {
    await this.call();
    if (this.failUpsert !== null) throw this.failUpsert;
    return this.fake.upsert(id, f, m);
  }
  async delete(id: string): Promise<void> {
    await this.call();
    return this.fake.delete(id);
  }
  async findByMetadata(uid: string) {
    await this.call();
    return this.fake.findByMetadata(uid);
  }
  async watch(input: Parameters<CalendarProvider["watch"]>[0]) {
    await this.call();
    return this.fake.watch(input);
  }
  async stopWatch(input: Parameters<CalendarProvider["stopWatch"]>[0]) {
    await this.call();
    return this.fake.stopWatch(input);
  }
}

async function setUp(
  makePort: () => Promise<StoragePort>,
  tag: string,
  opts: {
    readonly expiry?: string | null;
    readonly capabilities?: CapabilityConfig;
    /** rc53: push channels on, posting here. */
    readonly hookUrl?: string;
  } = {},
) {
  const inner = await makePort();
  const port = counting(inner);
  const cipher: TokenCipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const ann = await findOrCreatePerson(inner, `tick-ann-${tag}@example.org`, { now: T0 });
  const connectionId = `conn-${tag}`;
  await inner.batch([
    stmt(
      `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
         access_token_enc, refresh_token_enc, token_expiry, status, made_by_us, created_at, updated_at)
       VALUES (?, ?, 'google', ?, 'cal', ?, ?, ?, 'active', 1, ?, ?)`,
      connectionId,
      ann.id,
      `tick-ann-${tag}@example.org`,
      await cipher.encrypt("access-1"),
      await cipher.encrypt("refresh-1"),
      opts.expiry === undefined ? FAR : opts.expiry,
      T0,
      T0,
    ),
  ]);
  let clock = T0;
  let n = 0;
  const google = new Recording(); // one across ticks, so Google's state persists
  google.fake.now = () => Date.parse(clock); // channel expiries count from the test's clock
  const refreshes: string[] = [];
  const revoked: string[] = [];
  let refusal: Error | null = null;
  const ports: TickPorts = {
    storage: port,
    cipher,
    capabilities: opts.capabilities ?? EVERYTHING,
    refresh: (refreshToken) => {
      refreshes.push(refreshToken);
      return refusal === null
        ? Promise.resolve({ accessToken: "access-2", expiresAt: FAR })
        : Promise.reject(refusal);
    },
    providerFor: (calendarId, getAccessToken) => {
      expect(calendarId).toBe("cal");
      google.token = getAccessToken;
      return google;
    },
    eventUrl: url,
    revoke: (refreshToken) => {
      revoked.push(refreshToken);
      return Promise.resolve(true);
    },
    now: () => clock,
    newNonce: () => `nonce-${++n}`,
    newId: () => `${tag}-id-${++n}`,
    hookUrl: opts.hookUrl ?? null,
  };
  const event = async (fields: EventFieldsInput = DINNER) =>
    (await createEvent(inner, { creatorId: ann.id, group: null, fields, now: clock })).id;
  const access = async (id: string): Promise<EventAccess> => {
    const a = await findEventForParticipant(inner, id, ann.id);
    if (a === null) throw new Error("access");
    return a;
  };
  const rows = async () =>
    inner.query(
      stmt(
        `SELECT canonical_event_id, provider_event_id, state, last_error, retry_at,
                unsubscribed_at, base_revision, recent_write_nonces, visibility_profile
           FROM projection WHERE calendar_connection_id = ? ORDER BY canonical_event_id`,
        connectionId,
      ),
    );
  return {
    port,
    inner,
    ports,
    ann: ann.id,
    connectionId,
    event,
    access,
    rows,
    refreshes,
    revoked,
    refuse: (e: Error | null) => {
      refusal = e;
    },
    setClock: (t: string) => {
      clock = t;
    },
    google: () => google,
    tick: () => runTick(ports, connectionId),
    /** A tick that reads Google first (rc53). */
    read: () => runTick(ports, connectionId, { pull: true }),
    copyId: async (eventId: string) => {
      const copy = await google.fake.findByMetadata(eventId);
      if (copy === null) throw new Error("no copy");
      return copy.id;
    },
  };
}

export function runPushTickContract(makePort: () => Promise<StoragePort>): void {
  describe("the push tick (rc40)", () => {
    it("makes a copy of each agreed event, then a second tick writes and calls nothing", async () => {
      const t = await setUp(makePort, "create");
      const dinner = await t.event();
      const result = await t.tick();
      expect(result).toEqual({
        outcome: "done",
        decisions: [{ eventId: dinner, reason: "pushed" }],
      });
      const copy = await t.google().fake.findByMetadata(dinner);
      expect(copy?.fields.title).toBe("Dinner");
      expect(copy?.fields.sourceUrl).toBe(url(dinner));
      expect(copy?.metadata).toEqual({ canonicalUid: dinner, writeNonce: expect.any(String) });
      expect(await t.rows()).toEqual([
        expect.objectContaining({
          canonical_event_id: dinner,
          provider_event_id: copy?.id,
          state: "synced",
          base_revision: 1,
          retry_at: null,
        }),
      ]);
      expect(t.google().tokens).toEqual(["access-1", "access-1"]); // lookup, then create
      expect(t.refreshes).toEqual([]); // a fresh token isn't refreshed

      const calls = t.google().calls;
      const writes = t.port.writes;
      expect(await t.tick()).toEqual({ outcome: "done", decisions: [] });
      expect(t.google().calls).toBe(calls);
      expect(t.port.writes).toBe(writes); // the steady state writes nothing (§6)
    });

    it("an edit is pushed to the same copy; cancelling removes it, and restoring makes it again", async () => {
      const t = await setUp(makePort, "edit");
      const dinner = await t.event();
      await t.tick();
      const [first] = await t.rows();
      const edited = await editEvent(t.inner, await t.access(dinner), {
        fields: { ...DINNER, title: "Late dinner" },
        actorId: t.ann,
        now: at(1000),
      });
      expect(edited.kind).toBe("updated");
      t.setClock(at(2000));
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "pushed" }]);
      const [second] = await t.rows();
      expect(second?.provider_event_id).toBe(first?.provider_event_id);
      expect(second?.base_revision).toBe(2);
      expect(JSON.parse(String(second?.recent_write_nonces))).toHaveLength(2);
      expect((await t.google().fake.findByMetadata(dinner))?.fields.title).toBe("Late dinner");

      await setCancelled(t.inner, await t.access(dinner), { cancelled: true, now: at(3000) });
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "removed" }]);
      expect(await t.google().fake.findByMetadata(dinner)).toBeNull();
      expect(await t.rows()).toEqual([
        expect.objectContaining({
          state: "deleted",
          provider_event_id: null,
          unsubscribed_at: null,
        }),
      ]);
      const writes = t.port.writes;
      expect((await t.tick()).decisions).toEqual([]); // removed stays removed, quietly
      expect(t.port.writes).toBe(writes);

      await setCancelled(t.inner, await t.access(dinner), { cancelled: false, now: at(4000) });
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "pushed" }]);
      expect(await t.google().fake.findByMetadata(dinner)).not.toBeNull();
    });

    it("an event kept out of your calendar loses its copy; put back, it is pushed again (G3)", async () => {
      const t = await setUp(makePort, "out");
      const dinner = await t.event();
      await t.tick();
      expect(await t.google().fake.findByMetadata(dinner)).not.toBeNull();
      await setInCalendar(t.inner, await t.access(dinner), false);
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "removed" }]);
      expect(await t.google().fake.findByMetadata(dinner)).toBeNull();
      const writes = t.port.writes;
      await t.tick();
      expect(t.port.writes).toBe(writes); // out, it stays out quietly
      await setInCalendar(t.inner, await t.access(dinner), true);
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "pushed" }]);
      expect(await t.google().fake.findByMetadata(dinner)).not.toBeNull();
    });

    it("a copy deleted in Google is never put back, and is recorded on its projection (rc45)", async () => {
      const t = await setUp(makePort, "gone");
      const dinner = await t.event();
      await t.tick();
      const [row] = await t.rows();
      await t.google().fake.delete(String(row?.provider_event_id));
      await editEvent(t.inner, await t.access(dinner), {
        fields: { ...DINNER, title: "Moved" },
        actorId: t.ann,
        now: at(1000),
      });
      t.setClock(at(2000));
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "gone_in_provider" }]);
      expect(await t.rows()).toEqual([
        expect.objectContaining({
          state: "deleted",
          provider_event_id: null,
          unsubscribed_at: at(2000),
        }),
      ]);
      expect(await t.google().fake.findByMetadata(dinner)).toBeNull();
      const history = await t.inner.query(
        stmt("SELECT COUNT(*) AS n FROM change_log WHERE canonical_event_id = ?", dinner),
      );
      expect(history).toEqual([{ n: 2 }]); // the create and the edit; the deletion isn't one

      await editEvent(t.inner, await t.access(dinner), {
        fields: { ...DINNER, title: "Moved again" },
        actorId: t.ann,
        now: at(3000),
      });
      const calls = t.google().calls;
      expect((await t.tick()).decisions).toEqual([]);
      expect(t.google().calls).toBe(calls);
    });

    it("a copy already in Google, made before a crash, is taken over, not duplicated", async () => {
      const t = await setUp(makePort, "orphan");
      const dinner = await t.event();
      await t.tick(); // then forget the projection, as a write lost in a crash would
      await t.inner.batch([
        stmt("DELETE FROM projection WHERE calendar_connection_id = ?", t.connectionId),
      ]);
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "adopted_orphan" }]);
      const copies = (await t.google().fake.listChanges(null)).changes.filter((c) => !c.isDeleted);
      expect(new Set(copies.map((c) => c.id)).size).toBe(1);
      expect((await t.rows())[0]?.state).toBe("synced");
    });

    it("a failure waits a minute, then is tried again and converges", async () => {
      const t = await setUp(makePort, "retry");
      const dinner = await t.event();
      t.google().fail = new HttpError(503, "calendar event insert", "backendError");
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "retry_scheduled" }]);
      expect(await t.rows()).toEqual([
        expect.objectContaining({
          state: "error",
          last_error: "calendar event insert failed: HTTP 503 (backendError)",
          retry_at: at(RETRY_FIRST_MS),
          provider_event_id: null,
          visibility_profile: "FULL",
        }),
      ]);
      t.google().fail = null;
      t.setClock(at(RETRY_FIRST_MS - 1));
      const calls = t.google().calls;
      expect((await t.tick()).decisions).toEqual([]); // not yet
      expect(t.google().calls).toBe(calls);
      t.setClock(at(RETRY_FIRST_MS));
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "pushed" }]);
      expect(await t.rows()).toEqual([
        expect.objectContaining({ state: "synced", last_error: null, retry_at: null }),
      ]);
    });

    it("a failed update keeps its copy, waits twice as long the next time, and keeps no content", async () => {
      const t = await setUp(makePort, "update-fails");
      const dinner = await t.event();
      await t.tick();
      const [made] = await t.rows();
      await editEvent(t.inner, await t.access(dinner), {
        fields: { ...DINNER, title: "Moved" },
        actorId: t.ann,
        now: at(1000),
      });
      t.google().failUpsert = new HttpError(500, "calendar event update", "x".repeat(300));
      expect((await t.tick()).decisions).toEqual([{ eventId: dinner, reason: "retry_scheduled" }]);
      const [failed] = await t.rows();
      expect(failed?.provider_event_id).toBe(made?.provider_event_id);
      expect(String(failed?.last_error)).toHaveLength(200); // Google's detail, cut short
      t.google().failUpsert = new Error("Moved, at Ann's"); // not Google's: kept by kind only
      t.setClock(at(RETRY_FIRST_MS));
      await t.tick();
      expect(await t.rows()).toEqual([
        expect.objectContaining({
          state: "error",
          last_error: "Error",
          retry_at: at(3 * RETRY_FIRST_MS), // a minute, then two
          provider_event_id: made?.provider_event_id,
        }),
      ]);
    });

    it("decides events in id order, whatever order the feed has them in", async () => {
      const t = await setUp(makePort, "order");
      const later = await t.event();
      const sooner = await t.event({
        ...DINNER,
        startLocal: "2101-11-20T18:00",
        endLocal: "2101-11-20T20:00",
      });
      expect((await t.tick()).decisions.map((d) => d.eventId)).toEqual([later, sooner].sort());
    });

    it("a BUSY reader's copy says Busy, with no link", async () => {
      const t = await setUp(makePort, "busy");
      const dinner = await t.event();
      await t.inner.batch([
        stmt(
          "UPDATE event_participation SET visibility = 'BUSY' WHERE canonical_event_id = ?",
          dinner,
        ),
      ]);
      await t.tick();
      const copy = await t.google().fake.findByMetadata(dinner);
      expect(copy?.fields).toEqual(
        expect.objectContaining({ title: "Busy", description: null, sourceUrl: null }),
      );
    });
  });

  describe("tokens, the grant and calendar_sync (rc40, rc43)", () => {
    it.each([
      ["a minute from expiry", at(60_000)],
      ["of unknown expiry", null],
    ])("a token %s is refreshed once, and kept — only because a call was needed", async (_, expiry) => {
      const t = await setUp(makePort, `refresh-${expiry === null ? "null" : "minute"}`, { expiry });
      expect(await t.tick()).toEqual({ outcome: "done", decisions: [] }); // nothing to push
      expect(t.refreshes).toEqual([]);
      await t.event();
      await t.tick();
      expect(t.refreshes).toEqual(["refresh-1"]);
      expect(t.google().tokens).toEqual(["access-2", "access-2"]);
      const [conn] = await t.inner.query(
        stmt(
          "SELECT access_token_enc, token_expiry FROM calendar_connection WHERE id = ?",
          t.connectionId,
        ),
      );
      expect(conn?.token_expiry).toBe(FAR);
      expect(await t.ports.cipher.decrypt(String(conn?.access_token_enc))).toBe("access-2");
      expect(JSON.stringify(conn)).not.toContain("access-2"); // stored encrypted
    });

    it.each([
      400, 401,
    ])("a refresh refused with %i marks the connection auth_error and records nothing else", async (status) => {
      const t = await setUp(makePort, `refused-${status}`, { expiry: at(0) });
      await t.event();
      t.refuse(new HttpError(status, "token refresh", "invalid_grant"));
      expect(await t.tick()).toEqual({ outcome: "auth_error", decisions: [] });
      expect(await t.rows()).toEqual([]);
      const [conn] = await t.inner.query(
        stmt("SELECT status FROM calendar_connection WHERE id = ?", t.connectionId),
      );
      expect(conn?.status).toBe("auth_error");
      expect(await t.tick()).toEqual({ outcome: "skipped", decisions: [] });
    });

    it("a refresh that fails otherwise defers the tick, writing nothing", async () => {
      const t = await setUp(makePort, "down", { expiry: at(0) });
      await t.event();
      t.refuse(new HttpError(503, "token refresh", "unavailable"));
      const writes = t.port.writes;
      expect(await t.tick()).toEqual({ outcome: "deferred", decisions: [] });
      expect(t.port.writes).toBe(writes);
    });

    it("a 401 from the calendar marks the connection auth_error", async () => {
      const t = await setUp(makePort, "revoked");
      await t.event();
      await t.tick();
      await t.event({ ...DINNER, title: "Lunch" });
      t.google().fail = new HttpError(401, "calendar event lookup", "authError");
      expect((await t.tick()).outcome).toBe("auth_error");
      const [conn] = await t.inner.query(
        stmt("SELECT status FROM calendar_connection WHERE id = ?", t.connectionId),
      );
      expect(conn?.status).toBe("auth_error");
    });

    it("without calendar_sync nothing is pushed and nothing written; granted, it is", async () => {
      const t = await setUp(makePort, "gated", {
        capabilities: { default: "granted", operators: [] },
      });
      await t.event();
      const writes = t.port.writes;
      expect(await t.tick()).toEqual({ outcome: "skipped", decisions: [] });
      expect(t.port.writes).toBe(writes);
      const op = await findOrCreatePerson(t.inner, "tick-operator@example.org", { now: T0 });
      await grantCapability(t.inner, {
        email: "tick-ann-gated@example.org",
        capability: "calendar_sync",
        actorId: op.id,
        now: T0,
      });
      expect((await t.tick()).decisions).toHaveLength(1);
    });

    it("an unknown connection, or one Google stopped accepting, is skipped", async () => {
      const t = await setUp(makePort, "inactive");
      expect(await runTick(t.ports, "no-such-connection")).toEqual({
        outcome: "skipped",
        decisions: [],
      });
      await t.inner.batch([
        stmt("UPDATE calendar_connection SET status = 'auth_error' WHERE id = ?", t.connectionId),
      ]);
      await t.event();
      expect(await t.tick()).toEqual({ outcome: "skipped", decisions: [] });
    });
  });

  describe("disconnecting with Remove them (rc40, MVP-4 G3 part 2)", () => {
    const leave = (t: { inner: StoragePort; connectionId: string }) =>
      t.inner.batch([
        stmt("UPDATE calendar_connection SET status = 'disconnected' WHERE id = ?", t.connectionId),
      ]);
    const left = async (t: { inner: StoragePort }) =>
      (await t.inner.query(stmt("SELECT id FROM calendar_connection"))).map((r) => String(r.id));

    it("removes every copy, then gives the grant back and forgets the connection", async () => {
      const t = await setUp(makePort, "leave");
      const dinner = await t.event();
      const lunch = await t.event({ ...DINNER, title: "Lunch" });
      await t.tick();
      expect(t.google().fake.pendingNotifications()).toBe(2);
      await leave(t);
      const result = await t.tick();
      expect(result.outcome).toBe("disconnected");
      expect(result.decisions.map((d) => [d.eventId, d.reason]).sort()).toEqual(
        [
          [dinner, "removed"],
          [lunch, "removed"],
        ].sort(),
      );
      expect(await t.google().fake.findByMetadata(dinner)).toBeNull();
      expect(await t.google().fake.findByMetadata(lunch)).toBeNull();
      expect(t.revoked).toEqual(["refresh-1"]);
      expect(await left(t)).not.toContain(t.connectionId);
      expect(await t.rows()).toEqual([]);
      // The events themselves are untouched: only Ann's copies went.
      expect((await t.access(dinner)).event.status).toBe("scheduled");
      expect(await t.tick()).toEqual({ outcome: "skipped", decisions: [] });
    });

    it("works without calendar_sync, and with nothing to remove it finishes at once", async () => {
      const t = await setUp(makePort, "leave-gated", {
        capabilities: { default: "granted", operators: [] },
      });
      await t.event(); // never pushed: Ann can't sync
      await leave(t);
      expect(await t.tick()).toEqual({ outcome: "disconnected", decisions: [] });
      expect(t.google().calls).toBe(0);
      expect(t.revoked).toEqual(["refresh-1"]);
      expect(await left(t)).not.toContain(t.connectionId);
    });

    it("a copy deleted in Google, or kept out, doesn't hold it up", async () => {
      const t = await setUp(makePort, "leave-gone");
      const dinner = await t.event();
      const lunch = await t.event({ ...DINNER, title: "Lunch" });
      await t.tick();
      const gone = await t.google().fake.findByMetadata(dinner);
      await t.google().fake.delete(gone?.id ?? "");
      await editEvent(t.inner, await t.access(dinner), {
        fields: { ...DINNER, title: "Dinner at 7" },
        actorId: t.ann,
        now: T0,
      });
      await t.tick(); // finds Dinner gone in Google
      await setInCalendar(t.inner, await t.access(lunch), false);
      await t.tick(); // removes Lunch
      await leave(t);
      const result = await t.tick();
      expect(result.outcome).toBe("disconnected");
      expect(result.decisions.map((d) => d.eventId)).not.toContain(dinner);
      expect(result.decisions.map((d) => d.eventId)).not.toContain(lunch);
      expect(await left(t)).not.toContain(t.connectionId);
    });

    it("a removal that fails waits its retry; the connection stays until none is left", async () => {
      const t = await setUp(makePort, "leave-retry");
      const dinner = await t.event();
      await t.tick();
      await leave(t);
      t.google().fail = new HttpError(503, "calendar event delete", "backendError");
      const first = await t.tick();
      expect(first).toEqual({
        outcome: "done",
        decisions: [{ eventId: dinner, reason: "retry_scheduled" }],
      });
      expect(t.revoked).toEqual([]);
      expect(await left(t)).toContain(t.connectionId);
      t.google().fail = null;
      expect(await t.tick()).toEqual({ outcome: "done", decisions: [] }); // waiting its retry
      t.setClock(at(RETRY_FIRST_MS));
      expect((await t.tick()).outcome).toBe("disconnected");
      expect(await t.google().fake.findByMetadata(dinner)).toBeNull();
      expect(await left(t)).not.toContain(t.connectionId);
    });

    it.each([
      "refresh",
      "calendar",
    ])("a grant Google refused by then (%s): the copies stay and the connection goes", async (where) => {
      const t = await setUp(makePort, `leave-refused-${where}`);
      const dinner = await t.event();
      await t.tick();
      await leave(t);
      if (where === "refresh") {
        await t.inner.batch([
          stmt(
            "UPDATE calendar_connection SET token_expiry = ? WHERE id = ?",
            at(0),
            t.connectionId,
          ),
        ]);
        t.refuse(new HttpError(400, "token refresh", "invalid_grant"));
      } else {
        t.google().fail = new HttpError(401, "calendar event delete", "authError");
      }
      expect(await t.tick()).toEqual({ outcome: "disconnected", decisions: [] });
      expect(await t.google().fake.findByMetadata(dinner)).not.toBeNull();
      expect(t.revoked).toEqual([]); // nothing to give back
      expect(await left(t)).not.toContain(t.connectionId);
      expect(await t.rows()).toEqual([]);
    });
  });

  describe("choosing whom to tick (MVP-4 G2, part 4)", () => {
    it("every active or disconnecting connection, in id order, read without writing; past the most, a share a minute in turn", async () => {
      const t = await setUp(makePort, "fan-a");
      // One connection per account: each of these is someone else's.
      for (const [id, status] of [
        ["conn-fan-c", "active"],
        ["conn-fan-e", "active"],
        ["conn-fan-b", "disconnected"],
        ["conn-fan-d", "auth_error"],
      ] as const) {
        const owner = await findOrCreatePerson(t.inner, `${id}@example.org`, { now: T0 });
        await t.inner.batch([
          stmt(
            `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
               access_token_enc, refresh_token_enc, token_expiry, status, made_by_us, created_at, updated_at)
             VALUES (?, ?, 'google', ?, 'cal', 'x', 'x', ?, ?, 1, ?, ?)`,
            id,
            owner.id,
            `${id}@example.org`,
            FAR,
            status,
            T0,
            T0,
          ),
        ]);
      }
      const active = (
        await t.inner.query(
          stmt(
            "SELECT id FROM calendar_connection WHERE status IN ('active', 'disconnected') ORDER BY id",
          ),
        )
      ).map((r) => String(r.id));
      // A disconnected connection is ticked until its copies are removed (rc40, G3 part 2).
      expect(active).toEqual(
        expect.arrayContaining(["conn-fan-a", "conn-fan-b", "conn-fan-c", "conn-fan-e"]),
      );
      expect(active).not.toContain("conn-fan-d");

      const writes = t.port.writes;
      expect(await connectionsToTick(t.port, T0)).toEqual(active);
      expect(t.port.writes).toBe(writes);

      // One a minute: each minute takes the next, and every one comes round.
      const n = active.length;
      const minute = (k: number) => at(k * 60_000);
      const turn = (k: number) => Math.floor(Date.parse(minute(k)) / 60_000) % n;
      const seen = new Set<string>();
      for (let k = 0; k < n; k++) {
        const one = await connectionsToTick(t.port, minute(k), 1);
        expect(one).toEqual([active[turn(k)]]);
        for (const id of one) seen.add(id);
      }
      expect([...seen].sort()).toEqual([...active].sort());
      // Two a minute, of three or more: each minute's pair in turn, the last perhaps one.
      const pairs = Math.ceil(n / 2);
      const covered = new Set<string>();
      for (let k = 0; k < 2 * pairs; k++) {
        const p = Math.floor(Date.parse(minute(k)) / 60_000) % pairs;
        const two = await connectionsToTick(t.port, minute(k), 2);
        expect(two).toEqual(active.slice(p * 2, p * 2 + 2));
        expect(two.length).toBeGreaterThan(0);
        for (const id of two) covered.add(id);
      }
      expect(covered.size).toBe(n);
      // Exactly the most is everyone.
      expect(await connectionsToTick(t.port, T0, n)).toEqual(active);
      expect(t.port.writes).toBe(writes);
    });
  });

  describe("reading back from Google (rc53, MVP-5 T1b)", () => {
    const changeLog = async (t: Awaited<ReturnType<typeof setUp>>, eventId: string) =>
      t.inner.query(
        stmt(
          "SELECT revision, actor, source FROM change_log WHERE canonical_event_id = ? ORDER BY revision",
          eventId,
        ),
      );

    it("our own push read back is an echo; a quiet read then writes nothing", async () => {
      const t = await setUp(makePort, "pull-echo");
      const dinner = await t.event();
      await t.tick();
      const cursor = async () =>
        (
          await t.inner.query(
            stmt("SELECT sync_token FROM calendar_connection WHERE id = ?", t.connectionId),
          )
        )[0]?.sync_token;
      expect(await cursor()).toBeNull();
      expect((await t.read()).decisions).toEqual([{ eventId: dinner, reason: "echo_suppressed" }]);
      const kept = await cursor();
      expect(kept).toEqual(expect.any(String)); // the cursor Google gave is kept
      const writes = t.port.writes;
      expect(await t.read()).toEqual({ outcome: "done", decisions: [] });
      expect(t.port.writes).toBe(writes); // no change: no cursor to keep (§6)
      expect(await cursor()).toBe(kept);
    });

    it("an editor moves it in Google: the event follows, from Google, and the copy gets our line back", async () => {
      const t = await setUp(makePort, "pull-move");
      const dinner = await t.event();
      await t.tick();
      await t.read();
      const id = await t.copyId(dinner);
      t.google().fake.editByPerson(id, {
        startLocal: "2101-11-21T19:00:00",
        endLocal: "2101-11-21T21:00:00",
        description: "Bring wine and cheese", // our line deleted along the way
      });
      t.setClock(at(1000));
      expect((await t.read()).decisions).toEqual([
        { eventId: dinner, reason: "inbound_applied" },
        { eventId: dinner, reason: "pushed" },
      ]);
      const event = (await t.access(dinner)).event;
      expect(event).toMatchObject({
        startLocal: "2101-11-21T19:00:00",
        endLocal: "2101-11-21T21:00:00",
        description: "Bring wine and cheese",
        revision: 2,
      });
      expect(await changeLog(t, dinner)).toEqual([
        expect.objectContaining({ revision: 1, source: "ui" }),
        { revision: 2, actor: t.ann, source: "inbound_sync" },
      ]);
      // The push after it puts our line back on the copy, and that push read back is an echo.
      expect(t.google().fake.holds(id)?.fields.description).toMatch(
        /^From WhenDoWe — .*\n\nBring wine and cheese$/s,
      );
      expect((await t.read()).decisions).toEqual([{ eventId: dinner, reason: "echo_suppressed" }]);
    });

    it("two changes at once: the place set here and the time moved in Google both stay; the title both changed goes to Google", async () => {
      const t = await setUp(makePort, "pull-merge");
      const dinner = await t.event();
      await t.tick();
      await t.read();
      // Two edits here since the copy's base, the place changed in both: the base is undone
      // newest first, so it is the place the copy holds, not the one in between.
      const first = await editEvent(t.inner, await t.access(dinner), {
        fields: { ...DINNER, location: "Cy's", title: "Dinner here" },
        actorId: t.ann,
        now: at(400),
      });
      expect(first.kind).toBe("updated");
      const edited = await editEvent(t.inner, await t.access(dinner), {
        fields: { ...DINNER, location: "Ben's", title: "Dinner here" },
        actorId: t.ann,
        now: at(500),
      });
      expect(edited.kind).toBe("updated");
      t.google().fake.editByPerson(await t.copyId(dinner), {
        title: "Dinner in Google",
        startLocal: "2101-11-21T19:00:00",
        endLocal: "2101-11-21T21:00:00",
      });
      t.setClock(at(1000));
      await t.read();
      expect((await t.access(dinner)).event).toMatchObject({
        title: "Dinner in Google",
        location: "Ben's",
        startLocal: "2101-11-21T19:00:00",
        revision: 4,
      });
    });

    it("a change delivered twice, and one that changes nothing, write nothing more", async () => {
      const t = await setUp(makePort, "pull-twice");
      const dinner = await t.event();
      await t.tick();
      await t.read();
      const id = await t.copyId(dinner);
      t.google().fake.editByPerson(id, { title: "Supper" });
      const delivered = t.google().fake.holds(id);
      await t.read();
      if (delivered === null) throw new Error("held");
      // Re-delivered as it was, after our push had put the line back: nothing left to merge.
      t.google().fake.editByPerson(id, { ...delivered.fields });
      t.setClock(at(2000));
      // Exactly what we last pushed, so the content hash calls it ours (§11 layer 3).
      expect((await t.read()).decisions).not.toContainEqual({
        eventId: dinner,
        reason: "inbound_applied",
      });
      expect((await t.access(dinner)).event.revision).toBe(2);
      // A change only to what never comes back — the copy's link — merges to nothing.
      t.google().fake.editByPerson(id, { sourceUrl: null });
      expect((await t.read()).decisions).toEqual([
        { eventId: dinner, reason: "skipped_unchanged" },
      ]);
      expect((await t.access(dinner)).event.revision).toBe(2);
    });

    it("deleting the copy in Google is unsubscribing: it isn't made again", async () => {
      const t = await setUp(makePort, "pull-delete");
      const dinner = await t.event();
      await t.tick();
      await t.read();
      await t.google().fake.delete(await t.copyId(dinner));
      expect((await t.read()).decisions).toEqual([
        { eventId: dinner, reason: "inbound_delete_unsubscribed" },
      ]);
      expect(await t.rows()).toEqual([
        expect.objectContaining({ state: "deleted", provider_event_id: null, unsubscribed_at: T0 }),
      ]);
      expect(await t.tick()).toEqual({ outcome: "done", decisions: [] });
      expect(await t.google().fake.findByMetadata(dinner)).toBeNull();
    });

    it("one occurrence changed in Google changes nothing here; a viewer's change is put back (rc54)", async () => {
      const t = await setUp(makePort, "pull-skip");
      const dinner = await t.event();
      const ben = await findOrCreatePerson(t.inner, "tick-ben-pull-skip@example.org", { now: T0 });
      const bens = (
        await createEvent(t.inner, {
          creatorId: ben.id,
          group: null,
          fields: { ...DINNER, title: "Ben's dinner" },
          now: T0,
          people: [{ personId: t.ann, editTier: "view", visibility: "FULL" }],
        })
      ).id;
      await t.tick();
      await t.read();
      t.google().fake.editByPerson(await t.copyId(dinner), { title: "Just this once" }, "series-1");
      t.google().fake.editByPerson(await t.copyId(bens), { title: "Ann's idea" });
      expect((await t.read()).decisions).toEqual([
        { eventId: dinner, reason: "skipped_instance_edit" },
        { eventId: bens, reason: "inbound_put_back" },
        { eventId: bens, reason: "pushed" },
      ]);
      expect((await t.access(dinner)).event.title).toBe("Dinner");
      expect((await t.access(bens)).event.title).toBe("Ben's dinner");
      expect(t.google().fake.holds(await t.copyId(bens))?.fields.title).toBe("Ben's dinner");
    });

    it("after a full listing, a copy it doesn't hold was deleted while nobody watched: unsubscribed (T4a)", async () => {
      const t = await setUp(makePort, "pull-vanish");
      const kept = await t.event();
      const gone = await t.event({ ...DINNER, title: "Gone dinner" });
      await t.tick();
      await t.read();
      t.google().fake.vanish(await t.copyId(gone));
      // An incremental read sees nothing: no change was reported.
      expect((await t.read()).decisions).toEqual([]);
      t.google().fake.expireNext = true;
      // The full listing holds the copy still there too, which is our own write: an echo.
      expect((await t.read()).decisions).toEqual(
        expect.arrayContaining([
          { eventId: gone, reason: "inbound_delete_unsubscribed" },
          { eventId: kept, reason: "echo_suppressed" },
        ]),
      );
      const rows = await t.rows();
      expect(rows.find((r) => r.canonical_event_id === gone)).toMatchObject({
        state: "deleted",
        unsubscribed_at: T0,
      });
      expect(rows.find((r) => r.canonical_event_id === kept)).toMatchObject({ state: "synced" });
      // It isn't made again, and a second full listing finds nothing more to do.
      expect((await t.tick()).decisions).toEqual([]);
      t.google().fake.expireNext = true;
      expect((await t.read()).decisions).toEqual([{ eventId: kept, reason: "echo_suppressed" }]);
    });

    it("the first read is a full listing too, so a copy gone before it is found", async () => {
      const t = await setUp(makePort, "pull-first");
      const dinner = await t.event();
      await t.tick();
      t.google().fake.vanish(await t.copyId(dinner));
      expect((await t.read()).decisions).toEqual([
        { eventId: dinner, reason: "inbound_delete_unsubscribed" },
      ]);
    });

    it("one date of a series changed in Google is put back to what the series gives it (T4b)", async () => {
      const t = await setUp(makePort, "pull-date");
      const weekly = await t.event({ ...DINNER, rrule: "FREQ=WEEKLY;COUNT=4" });
      await t.tick();
      await t.read();
      const series = await t.copyId(weekly);
      const date = t.google().fake.editOccurrence(series, "2101-11-28T18:00:00", {
        title: "Just this once",
        startLocal: "2101-11-28T19:30:00",
        endLocal: "2101-11-28T21:00:00",
      });
      expect((await t.read()).decisions).toEqual([{ eventId: weekly, reason: "inbound_put_back" }]);
      const held = t.google().fake.holds(date)?.fields;
      expect(held).toMatchObject({
        title: "Dinner",
        startLocal: "2101-11-28T18:00:00",
        endLocal: "2101-11-28T20:00:00",
        rrule: null,
      });
      expect(held?.description).toMatch(
        /^From WhenDoWe — change it here or there: .*Changes to one date aren't kept/s,
      );
      // The event itself, and the series in Google, are untouched.
      expect((await t.access(weekly)).event).toMatchObject({ title: "Dinner", revision: 1 });
      expect(t.google().fake.holds(series)?.fields.rrule).toBe("FREQ=WEEKLY;COUNT=4");
      // Our put-back, read back, is what the series gives that date: nothing more to do.
      const writes = t.port.writes;
      expect((await t.read()).decisions).toEqual([]);
      expect(t.port.writes - writes).toBeLessThanOrEqual(1); // the cursor
    });

    it("an all-day series' date keeps its length; a date deleted in Google is left deleted", async () => {
      const t = await setUp(makePort, "pull-date-allday");
      const camp = await t.event({
        ...DINNER,
        title: "Camp",
        allDay: true,
        startLocal: "2101-11-21",
        endLocal: "2101-11-23",
        tzid: null,
        rrule: "FREQ=WEEKLY;COUNT=3",
      });
      await t.tick();
      await t.read();
      const series = await t.copyId(camp);
      const date = t.google().fake.editOccurrence(series, "2101-11-28", {
        startLocal: "2101-11-29",
        endLocal: "2101-11-30",
      });
      expect((await t.read()).decisions).toEqual([{ eventId: camp, reason: "inbound_put_back" }]);
      expect(t.google().fake.holds(date)?.fields).toMatchObject({
        startLocal: "2101-11-28",
        endLocal: "2101-11-30",
        allDay: true,
      });
      await t.read();
      await t.google().fake.delete(date);
      expect((await t.read()).decisions).toEqual([
        { eventId: camp, reason: "skipped_instance_edit" },
      ]);
      expect(t.google().fake.holds(date)?.isDeleted).toBe(true);
      // The series' own copy is still there, not unsubscribed.
      expect((await t.rows())[0]).toMatchObject({ state: "synced", unsubscribed_at: null });
    });

    it("an expired cursor reads everything, and finds the change all the same", async () => {
      const t = await setUp(makePort, "pull-expired");
      const dinner = await t.event();
      await t.tick();
      await t.read();
      t.google().fake.editByPerson(await t.copyId(dinner), { location: "Park" });
      t.google().fake.expireNext = true;
      expect((await t.read()).decisions).toContainEqual({
        eventId: dinner,
        reason: "inbound_applied",
      });
      expect((await t.access(dinner)).event.location).toBe("Park");
    });

    it("each active connection is read in its own minute of every six hours, as well as its share", async () => {
      const t = await setUp(makePort, "pull-turn");
      const turn = pullTurn(t.connectionId);
      const minute = (m: number) => new Date(m * 60_000).toISOString();
      const writes = t.port.writes;
      expect(await ticksDue(t.port, minute(turn), 0)).toContainEqual({
        connectionId: t.connectionId,
        pull: true,
      });
      expect(await ticksDue(t.port, minute(turn + PULL_EVERY_MINUTES), 0)).toContainEqual({
        connectionId: t.connectionId,
        pull: true,
      });
      const other = await ticksDue(t.port, minute(turn + 1));
      expect(other.find((d) => d.connectionId === t.connectionId)?.pull).toBe(false);
      expect(t.port.writes).toBe(writes); // scheduling reads only
    });

    it("an event as a copy made at an earlier revision holds it: every field, undone newest first", async () => {
      const t = await setUp(makePort, "pull-at");
      const dinner = await t.event();
      const original = (await t.access(dinner)).event;
      for (const [i, fields] of [
        { ...DINNER, title: "Lunch", location: null, description: null },
        {
          ...DINNER,
          title: "Picnic",
          allDay: true,
          startLocal: "2101-11-22",
          endLocal: "2101-11-23",
          tzid: null,
        },
      ].entries()) {
        const edited = await editEvent(t.inner, await t.access(dinner), {
          fields,
          actorId: t.ann,
          now: at(100 * (i + 1)),
        });
        expect(edited.kind).toBe("updated");
      }
      const now = (await t.access(dinner)).event;
      const pick = ({
        title,
        description,
        location,
        allDay,
        startLocal,
        endLocal,
        tzid,
        rrule,
      }: typeof now) => ({
        title,
        description,
        location,
        allDay,
        startLocal,
        endLocal,
        tzid,
        rrule,
      });
      expect(await fieldsAtRevision(t.inner, now, 1)).toEqual(pick(original));
      expect(await fieldsAtRevision(t.inner, now, 2)).toMatchObject({
        title: "Lunch",
        location: null,
        allDay: false,
        startLocal: original.startLocal,
        tzid: "Europe/Prague",
      });
      expect(await fieldsAtRevision(t.inner, now, 3)).toEqual(pick(now));
    });

    it("a rival edit landing while a change is merged: merged again, both kept", async () => {
      const t = await setUp(makePort, "pull-rival");
      const dinner = await t.event();
      await t.tick();
      await t.read();
      t.google().fake.editByPerson(await t.copyId(dinner), { title: "Supper" });
      t.port.beforeEdit = async () => {
        const rival = await editEvent(t.inner, await t.access(dinner), {
          fields: { ...DINNER, location: "Ben's" },
          actorId: t.ann,
          now: at(10),
        });
        expect(rival.kind).toBe("updated");
      };
      expect((await t.read()).decisions).toContainEqual({
        eventId: dinner,
        reason: "inbound_applied",
      });
      expect((await t.access(dinner)).event).toMatchObject({
        title: "Supper",
        location: "Ben's",
        revision: 3,
      });
    });

    it("a change the form would refuse is left out, and the next push puts the copy back", async () => {
      const t = await setUp(makePort, "pull-bad");
      const dinner = await t.event();
      await t.tick();
      await t.read();
      const id = await t.copyId(dinner);
      t.google().fake.editByPerson(id, { endLocal: "2101-11-21T17:00:00" }); // before it starts
      expect((await t.read()).decisions).toContainEqual({ eventId: dinner, reason: "error" });
      expect((await t.access(dinner)).event.revision).toBe(1);
    });

    it("changes to the person's own events and series in that calendar are none of ours", async () => {
      const t = await setUp(makePort, "pull-theirs");
      await t.event();
      await t.tick();
      await t.read();
      // An event of their own (no canonical id), and one occurrence of a series of their own.
      const dentist: EventFields = {
        title: "Dentist",
        description: null,
        location: null,
        startLocal: "2101-11-22T09:00:00",
        endLocal: "2101-11-22T10:00:00",
        tzid: "Europe/Prague",
        allDay: false,
        rrule: null,
        sourceUrl: null,
      };
      const own = await t.google().fake.upsert(null, dentist, { canonicalUid: "" });
      t.google().fake.editByPerson(own.id, { title: "Dentist, moved" }, "their-series");
      const writes = t.port.writes;
      const result = await t.read();
      expect(result.decisions).toEqual([]);
      expect(t.port.writes - writes).toBeLessThanOrEqual(1); // the cursor, which moved
    });

    it("a grant Google refused, or no token, during a read: as during a push", async () => {
      const refused = await setUp(makePort, "pull-refused", { expiry: at(0) });
      await refused.event();
      refused.refuse(new HttpError(400, "token refresh", "invalid_grant"));
      expect(await refused.read()).toEqual({ outcome: "auth_error", decisions: [] });
      const [conn] = await refused.inner.query(
        stmt("SELECT status FROM calendar_connection WHERE id = ?", refused.connectionId),
      );
      expect(conn?.status).toBe("auth_error");

      const down = await setUp(makePort, "pull-down", { expiry: at(0) });
      await down.event();
      down.refuse(new HttpError(503, "token refresh", "unavailable"));
      const writes = down.port.writes;
      expect(await down.read()).toEqual({ outcome: "deferred", decisions: [] });
      expect(down.port.writes).toBe(writes);
    });

    it("Google refusing the calendar during a read marks the connection; any other failure is the tick's", async () => {
      const t = await setUp(makePort, "pull-401");
      await t.event();
      t.google().fail = new HttpError(401, "events.list", "unauthorized");
      expect(await t.read()).toEqual({ outcome: "auth_error", decisions: [] });
      const [conn] = await t.inner.query(
        stmt("SELECT status, sync_token FROM calendar_connection WHERE id = ?", t.connectionId),
      );
      expect(conn).toEqual({ status: "auth_error", sync_token: null });

      const u = await setUp(makePort, "pull-500");
      await u.event();
      u.google().fail = new HttpError(500, "events.list", "backend");
      await expect(u.read()).rejects.toThrow(HttpError);
      const [kept] = await u.inner.query(
        stmt("SELECT status, sync_token FROM calendar_connection WHERE id = ?", u.connectionId),
      );
      expect(kept).toEqual({ status: "active", sync_token: null });
    });

    it("turns are spread over the six hours, and the same id always has the same one", () => {
      const turns = new Set(Array.from({ length: 200 }, (_, i) => pullTurn(`conn-${i}`)));
      expect(turns.size).toBeGreaterThan(150);
      for (const turn of turns) expect(turn >= 0 && turn < PULL_EVERY_MINUTES).toBe(true);
      expect(pullTurn("conn-7")).toBe(67); // FNV-1a of the id, mod 360: worked out by hand
      expect(pullTurn("a")).not.toBe(pullTurn("b"));
    });

    describe("people who can't edit (rc53/rc54, T2)", () => {
      const notices = async (t: Awaited<ReturnType<typeof setUp>>) =>
        (
          await t.inner.query(
            stmt(
              `SELECT actor_id, kind, args, due_at FROM held_action
                WHERE kind = 'google_notice' AND actor_id = ? ORDER BY created_at`,
              t.ann,
            ),
          )
        ).map((r) => ({ ...r, args: JSON.parse(String(r.args)) }));

      async function bensEvent(t: Awaited<ReturnType<typeof setUp>>, tier: "propose" | "view") {
        const ben = await findOrCreatePerson(
          t.inner,
          `tick-ben-${tier}-${t.connectionId}@example.org`,
          {
            now: T0,
          },
        );
        const id = (
          await createEvent(t.inner, {
            creatorId: ben.id,
            group: null,
            fields: { ...DINNER, title: "Ben's dinner" },
            now: T0,
            people: [{ personId: t.ann, editTier: tier, visibility: "FULL" }],
          })
        ).id;
        await t.tick();
        await t.read();
        return id;
      }

      it("a proposer moving it in Google makes their proposal, puts their copy back, and holds one email", async () => {
        const t = await setUp(makePort, "t2-propose");
        const bens = await bensEvent(t, "propose");
        const copy = await t.copyId(bens);
        t.google().fake.editByPerson(copy, {
          startLocal: "2101-11-21T19:00:00",
          endLocal: "2101-11-21T21:00:00",
        });
        t.setClock(at(1000));
        expect((await t.read()).decisions).toEqual([
          { eventId: bens, reason: "inbound_proposed" },
          { eventId: bens, reason: "pushed" },
        ]);
        expect((await t.access(bens)).event).toMatchObject({
          startLocal: "2101-11-21T18:00:00",
          revision: 1,
        });
        const [proposal] = await t.inner.query(
          stmt(
            "SELECT proposed_by, base_revision, status, fields FROM event_change_proposal WHERE canonical_event_id = ?",
            bens,
          ),
        );
        expect(proposal).toMatchObject({ proposed_by: t.ann, base_revision: 1, status: "pending" });
        expect(JSON.parse(String(proposal?.fields))).toMatchObject({
          startLocal: "2101-11-21T19:00:00",
          title: "Ben's dinner",
        });
        expect(t.google().fake.holds(copy)?.fields.startLocal).toBe("2101-11-21T18:00:00");
        expect(await notices(t)).toEqual([
          {
            actor_id: t.ann,
            kind: "google_notice",
            args: { outcome: "proposed", moved: true, eventId: bens },
            due_at: at(1000),
          },
        ]);
      });

      it("a rival edit landing while a change becomes a proposal: proposed again, against it", async () => {
        const t = await setUp(makePort, "t2-rival");
        const bens = await bensEvent(t, "propose");
        t.google().fake.editByPerson(await t.copyId(bens), { location: "Park" });
        const ben = await findOrCreatePerson(
          t.inner,
          `tick-ben-propose-${t.connectionId}@example.org`,
          {
            now: T0,
          },
        );
        t.port.beforeEdit = async () => {
          const access = await findEventForParticipant(t.inner, bens, ben.id);
          if (access === null) throw new Error("ben");
          const rival = await editEvent(t.inner, access, {
            fields: { ...DINNER, title: "Ben's big dinner" },
            actorId: ben.id,
            now: at(10),
          });
          expect(rival.kind).toBe("updated");
        };
        expect((await t.read()).decisions).toContainEqual({
          eventId: bens,
          reason: "inbound_proposed",
        });
        const [proposal] = await t.inner.query(
          stmt(
            "SELECT base_revision, fields FROM event_change_proposal WHERE canonical_event_id = ? AND status = 'pending'",
            bens,
          ),
        );
        expect(proposal?.base_revision).toBe(2);
        expect(JSON.parse(String(proposal?.fields))).toMatchObject({
          title: "Ben's big dinner",
          location: "Park",
        });
      });

      it("a viewer's change is put back each time, and told once a day", async () => {
        const t = await setUp(makePort, "t2-view");
        const bens = await bensEvent(t, "view");
        const copy = await t.copyId(bens);
        for (const [i, title] of ["Ann's idea", "Ann's other idea"].entries()) {
          t.google().fake.editByPerson(copy, { title });
          t.setClock(at(1000 * (i + 1)));
          expect((await t.read()).decisions).toContainEqual({
            eventId: bens,
            reason: "inbound_put_back",
          });
          expect(t.google().fake.holds(copy)?.fields.title).toBe("Ben's dinner");
          await t.read(); // our put-back, read back
        }
        expect(await notices(t)).toEqual([
          expect.objectContaining({ args: { outcome: "put_back", moved: false, eventId: bens } }),
        ]);
        // Another event the same day is told of on its own: the limit is per event.
        const other = await bensEvent(t, "view");
        t.google().fake.editByPerson(await t.copyId(other), { title: "Mine now" });
        await t.read();
        expect((await notices(t)).map((n) => n.args.eventId)).toEqual([bens, other]);
        // A day later, told again.
        t.google().fake.editByPerson(copy, { title: "A day on" });
        t.setClock(at(25 * 60 * 60 * 1000));
        await t.read();
        expect(await notices(t)).toHaveLength(3);
      });

      it("a change only to what never comes back is left alone, and nobody is told", async () => {
        const t = await setUp(makePort, "t2-link");
        const bens = await bensEvent(t, "view");
        t.google().fake.editByPerson(await t.copyId(bens), { sourceUrl: null });
        expect((await t.read()).decisions).toEqual([
          { eventId: bens, reason: "skipped_unchanged" },
        ]);
        expect(await notices(t)).toEqual([]);
      });

      it("a proposer past the most proposals one person may make is put back, and told so", async () => {
        const t = await setUp(makePort, "t2-limit");
        const bens = await bensEvent(t, "propose");
        await t.inner.batch(
          Array.from({ length: PROPOSAL_CEILING }, (_, i) =>
            stmt(
              `INSERT INTO event_change_proposal
                 (id, canonical_event_id, proposed_by, base_revision, fields, status, created_at)
               VALUES (?, ?, ?, 1, '{}', 'withdrawn', ?)`,
              `old-${i}`,
              bens,
              t.ann,
              T0,
            ),
          ),
        );
        t.google().fake.editByPerson(await t.copyId(bens), { location: "Park" });
        expect((await t.read()).decisions).toContainEqual({
          eventId: bens,
          reason: "inbound_put_back",
        });
        const pending = await t.inner.query(
          stmt(
            "SELECT id FROM event_change_proposal WHERE canonical_event_id = ? AND status = 'pending'",
            bens,
          ),
        );
        expect(pending).toEqual([]);
        expect(await notices(t)).toEqual([
          expect.objectContaining({ args: { outcome: "put_back", moved: false, eventId: bens } }),
        ]);
      });
    });
  });

  describe("push channels (rc53, T3a)", () => {
    const HOOK = "https://whendowe.example/hooks/google";
    const DAY = 24 * 60 * 60 * 1000;
    const channelRow = async (t: Awaited<ReturnType<typeof setUp>>) =>
      (
        await t.inner.query(
          stmt(
            `SELECT watch_channel, watch_token_hash, watch_resource_id, watch_expires_at
               FROM calendar_connection WHERE id = ?`,
            t.connectionId,
          ),
        )
      )[0];

    it("on, a connection gets a channel, its secret kept hashed; then a quiet tick calls and writes nothing", async () => {
      const t = await setUp(makePort, "watch-make", { hookUrl: HOOK });
      expect(await t.tick()).toEqual({ outcome: "done", decisions: [], channel: "made" });
      const row = await channelRow(t);
      const made = t.google().fake.channels.get(String(row?.watch_channel));
      expect(made).toMatchObject({ address: HOOK, resourceId: row?.watch_resource_id });
      expect(row?.watch_token_hash).toBe(await hashToken(made?.token ?? ""));
      expect(row?.watch_token_hash).not.toBe(made?.token);
      expect(row?.watch_expires_at).toBe(at(7 * DAY));

      t.setClock(at(5 * DAY));
      const calls = t.google().calls;
      const writes = t.port.writes;
      expect(await t.tick()).toEqual({ outcome: "done", decisions: [] });
      expect(t.google().calls).toBe(calls);
      expect(t.port.writes).toBe(writes);
    });

    it("within a day of expiry it is replaced: the new one first, then the old one stopped", async () => {
      const t = await setUp(makePort, "watch-renew", { hookUrl: HOOK });
      await t.tick();
      const old = String((await channelRow(t))?.watch_channel);
      t.setClock(at(6 * DAY + 60_000));
      expect((await t.tick()).channel).toBe("made");
      const row = await channelRow(t);
      expect(row?.watch_channel).not.toBe(old);
      expect([...t.google().fake.channels.keys()]).toEqual([row?.watch_channel]);
      expect(row?.watch_expires_at).toBe(at(13 * DAY + 60_000));
    });

    it("refused, there is none, and it is asked for again only after an hour", async () => {
      const t = await setUp(makePort, "watch-refused", { hookUrl: HOOK });
      t.google().fake.failWatch = new HttpError(
        400,
        "calendar watch",
        "pushNotSupportedForRequestedResource",
      );
      expect((await t.tick()).channel).toBe("failed");
      expect(await channelRow(t)).toEqual({
        watch_channel: null,
        watch_token_hash: null,
        watch_resource_id: null,
        watch_expires_at: at(60 * 60 * 1000),
      });
      t.setClock(at(59 * 60 * 1000));
      const calls = t.google().calls;
      expect((await t.tick()).channel).toBeUndefined();
      expect(t.google().calls).toBe(calls);
      t.setClock(at(60 * 60 * 1000));
      expect((await t.tick()).channel).toBe("made");
    });

    it("replaced exactly a day before it expires, and not a minute sooner", async () => {
      const t = await setUp(makePort, "watch-edge", { hookUrl: HOOK });
      await t.tick();
      t.setClock(at(6 * DAY - 60_000));
      expect((await t.tick()).channel).toBeUndefined();
      t.setClock(at(6 * DAY));
      expect((await t.tick()).channel).toBe("made");
    });

    it("no token to be had while making one: the tick waits, writing nothing", async () => {
      const t = await setUp(makePort, "watch-down", { hookUrl: HOOK, expiry: at(0) });
      t.refuse(new HttpError(503, "token refresh", "unavailable"));
      const writes = t.port.writes;
      expect(await t.tick()).toEqual({ outcome: "deferred", decisions: [] });
      expect(t.port.writes).toBe(writes);
    });

    it("refused because the grant is gone: the connection is marked, as for any call", async () => {
      const t = await setUp(makePort, "watch-401", { hookUrl: HOOK });
      t.google().fake.failWatch = new HttpError(401, "calendar watch", "unauthorized");
      expect(await t.tick()).toEqual({ outcome: "auth_error", decisions: [] });
      const [conn] = await t.inner.query(
        stmt("SELECT status, watch_channel FROM calendar_connection WHERE id = ?", t.connectionId),
      );
      expect(conn).toEqual({ status: "auth_error", watch_channel: null });
    });

    it("off, there is never a channel; disconnecting stops one", async () => {
      const off = await setUp(makePort, "watch-off");
      expect(await off.tick()).toEqual({ outcome: "done", decisions: [] });
      expect(off.google().fake.channels.size).toBe(0);

      const t = await setUp(makePort, "watch-leave", { hookUrl: HOOK });
      await t.tick();
      expect(t.google().fake.channels.size).toBe(1);
      await t.inner.batch([
        stmt("UPDATE calendar_connection SET status = 'disconnected' WHERE id = ?", t.connectionId),
      ]);
      expect((await t.tick()).outcome).toBe("disconnected");
      expect(t.google().fake.channels.size).toBe(0);
    });
  });
}
