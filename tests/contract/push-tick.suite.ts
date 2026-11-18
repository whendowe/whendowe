// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createTokenCipher, type TokenCipher } from "../../src/crypto/tokens.js";
import { type SqlStatement, type StoragePort, stmt } from "../../src/db/port.js";
import {
  createEvent,
  type EventAccess,
  type EventFieldsInput,
  editEvent,
  findEventForParticipant,
  setCancelled,
} from "../../src/events/event.js";
import { setInCalendar } from "../../src/events/participation.js";
import { HttpError } from "../../src/oauth/http.js";
import { type CapabilityConfig, EVERYTHING, grantCapability } from "../../src/people/capability.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import type {
  CalendarProvider,
  EventFields,
  ProviderMetadata,
  UpsertResult,
} from "../../src/providers/base.js";
import { FakeCalendarProvider } from "../../src/providers/fake.js";
import { RETRY_FIRST_MS } from "../../src/reconcile/decide.js";
import { connectionsToTick, runTick, type TickPorts } from "../../src/reconcile/tick.js";

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
function counting(port: StoragePort): StoragePort & { writes: number } {
  const counted = {
    writes: 0,
    query: (s: SqlStatement) => {
      if (!/^\s*SELECT/i.test(s.sql)) counted.writes += 1;
      return port.query(s);
    },
    batch: (s: readonly SqlStatement[]) => {
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
  listChanges = (t: string | null) => this.fake.listChanges(t);
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
}

async function setUp(
  makePort: () => Promise<StoragePort>,
  tag: string,
  opts: { readonly expiry?: string | null; readonly capabilities?: CapabilityConfig } = {},
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
  const refreshes: string[] = [];
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
    now: () => clock,
    newNonce: () => `nonce-${++n}`,
    newId: () => `${tag}-id-${++n}`,
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
    refuse: (e: Error | null) => {
      refusal = e;
    },
    setClock: (t: string) => {
      clock = t;
    },
    google: () => google,
    tick: () => runTick(ports, connectionId),
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
}
