// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  consumeLoginToken,
  issueLoginToken,
  LOGIN_REQUESTS_PER_WINDOW,
} from "../../src/people/login.js";
import {
  findOrCreatePerson,
  findPersonByEmail,
  findPersonById,
  normalizeEmail,
} from "../../src/people/person.js";
import {
  createSession,
  resolveAccounts,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  verifyCsrf,
} from "../../src/people/session.js";
import { hashToken } from "../../src/people/tokens.js";

// People, login and sessions on BOTH drivers. Every security property here leans on
// one SQL statement being atomic (ON CONFLICT, INSERT … WHERE … RETURNING,
// UPDATE … RETURNING), which is exactly what must not differ between libsql and D1.
//
// Residue-tolerant: the D1 run shares one database, so each test uses its own address.

const T0 = "2101-07-01T10:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

export function runPeopleContract(makePort: () => Promise<StoragePort>): void {
  describe("people", () => {
    it("normalises addresses and rejects junk", () => {
      expect(normalizeEmail("  Ann.Example@Mail.ORG ")).toBe("ann.example@mail.org");
      expect(() => normalizeEmail("not-an-email")).toThrow();
    });

    it("findOrCreatePerson is idempotent across case and whitespace", async () => {
      const port = await makePort();
      const a = await findOrCreatePerson(port, "idem@example.org", { now: T0 });
      const b = await findOrCreatePerson(port, " IDEM@example.org", { now: at(1) });
      expect(b.id).toBe(a.id);
      expect(b.createdAt).toBe(T0);
    });

    it("finds a person by id, and nothing for an unknown id", async () => {
      const port = await makePort();
      const created = await findOrCreatePerson(port, "byid@example.org", { now: T0 });
      expect(await findPersonById(port, created.id)).toEqual(created);
      expect(await findPersonById(port, "no-such-person")).toBeNull();
    });

    it("racing first logins for one address create exactly one person", async () => {
      const port = await makePort();
      const people = await Promise.all(
        Array.from({ length: 10 }, () => findOrCreatePerson(port, "race@example.org", { now: T0 })),
      );
      expect(new Set(people.map((p) => p.id)).size).toBe(1);
    });
  });

  describe("magic-link login", () => {
    it("stores only the token's hash, never the token", async () => {
      const port = await makePort();
      const issued = await issueLoginToken(port, "hashonly@example.org", { now: T0 });
      if (!issued.ok) throw new Error("expected issue");
      const rows = await port.query({
        sql: "SELECT token_hash FROM login_token WHERE email = ?",
        params: ["hashonly@example.org"],
      });
      expect(rows[0]?.token_hash).toBe(await hashToken(issued.token));
      expect(JSON.stringify(rows)).not.toContain(issued.token);
    });

    it("requesting a link creates no person", async () => {
      const port = await makePort();
      await issueLoginToken(port, "noperson@example.org", { now: T0 });
      expect(await findPersonByEmail(port, "noperson@example.org")).toBeNull();
    });

    it("a token is consumed exactly once", async () => {
      const port = await makePort();
      const issued = await issueLoginToken(port, "once@example.org", { now: T0 });
      if (!issued.ok) throw new Error("expected issue");
      expect(await consumeLoginToken(port, issued.token, { now: at(1) })).toBe("once@example.org");
      expect(await consumeLoginToken(port, issued.token, { now: at(2) })).toBeNull();
    });

    it("concurrent consumption succeeds for exactly one caller", async () => {
      // A double-click, or a mail scanner racing the human, must not yield two sessions.
      const port = await makePort();
      const issued = await issueLoginToken(port, "dbl@example.org", { now: T0 });
      if (!issued.ok) throw new Error("expected issue");
      const results = await Promise.all(
        Array.from({ length: 10 }, () => consumeLoginToken(port, issued.token, { now: at(1) })),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("an expired or unknown token yields nothing", async () => {
      const port = await makePort();
      const issued = await issueLoginToken(port, "late@example.org", { now: T0 });
      if (!issued.ok) throw new Error("expected issue");
      expect(await consumeLoginToken(port, issued.token, { now: at(16) })).toBeNull(); // TTL 15 min
      expect(await consumeLoginToken(port, "never-issued", { now: T0 })).toBeNull();
    });

    it("rate-limits requests per address, and the window slides", async () => {
      const port = await makePort();
      for (let i = 0; i < LOGIN_REQUESTS_PER_WINDOW; i += 1) {
        expect((await issueLoginToken(port, "flood@example.org", { now: at(i) })).ok).toBe(true);
      }
      expect(await issueLoginToken(port, "flood@example.org", { now: at(10) })).toEqual({
        ok: false,
        reason: "rate_limited",
      });
      // Another address is unaffected…
      expect((await issueLoginToken(port, "other@example.org", { now: at(10) })).ok).toBe(true);
      // …and once the oldest request leaves the 60-minute window, one more is allowed.
      expect((await issueLoginToken(port, "flood@example.org", { now: at(61) })).ok).toBe(true);
    });

    it("concurrent requests cannot exceed the rate limit", async () => {
      const port = await makePort();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => issueLoginToken(port, "burst@example.org", { now: T0 })),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(LOGIN_REQUESTS_PER_WINDOW);
    });
  });

  describe("clock validation", () => {
    it("refuses an invalid injected clock rather than writing a nonsense expiry", async () => {
      const port = await makePort();
      await expect(
        issueLoginToken(port, "clock@example.org", { now: "not-a-date" }),
      ).rejects.toThrow(/invalid `now`/);
      const person = await findOrCreatePerson(port, "clock2@example.org", { now: T0 });
      await expect(
        createSession(port, person.id, { now: "not-a-date", via: "magic" }),
      ).rejects.toThrow(/invalid `now`/);
    });
  });

  describe("sessions", () => {
    it("resolves a fresh session to its person, storing only the hash", async () => {
      const port = await makePort();
      const person = await findOrCreatePerson(port, "sess@example.org", { now: T0 });
      const s = await createSession(port, person.id, { now: T0, via: "magic" });
      expect((await resolveSession(port, s.token, { now: at(1) }))?.personId).toBe(person.id);
      const rows = await port.query({
        sql: "SELECT token_hash FROM session WHERE id = ?",
        params: [s.sessionId],
      });
      expect(rows[0]?.token_hash).toBe(await hashToken(s.token));
    });

    it("rejects unknown, expired and revoked sessions", async () => {
      const port = await makePort();
      const person = await findOrCreatePerson(port, "dead@example.org", { now: T0 });
      const s = await createSession(port, person.id, { now: T0, via: "magic" });
      expect(await resolveSession(port, "not-a-session", { now: at(1) })).toBeNull();
      expect(await resolveSession(port, s.token, { now: at(31 * 24 * 60) })).toBeNull(); // 30-day TTL
      await revokeSession(port, s.token, at(2));
      expect(await resolveSession(port, s.token, { now: at(3) })).toBeNull();
    });

    it("sign-out-everywhere revokes every session of that person only", async () => {
      const port = await makePort();
      const me = await findOrCreatePerson(port, "everywhere@example.org", { now: T0 });
      const them = await findOrCreatePerson(port, "bystander@example.org", { now: T0 });
      const a = await createSession(port, me.id, { now: T0, via: "magic" });
      const b = await createSession(port, me.id, { now: T0, via: "magic" });
      const c = await createSession(port, them.id, { now: T0, via: "magic" });
      await revokeAllSessions(port, me.id, at(1));
      expect(await resolveSession(port, a.token, { now: at(2) })).toBeNull();
      expect(await resolveSession(port, b.token, { now: at(2) })).toBeNull();
      expect(await resolveSession(port, c.token, { now: at(2) })).not.toBeNull();
    });

    it("resolves a browser's accounts in one read, in order, dropping dead ones (rc18)", async () => {
      const port = await makePort();
      const ann = await findOrCreatePerson(port, "acc-ann@example.org", { now: T0 });
      const bob = await findOrCreatePerson(port, "acc-bob@example.org", { now: T0 });
      const a = await createSession(port, ann.id, { now: T0, via: "magic" });
      const b = await createSession(port, bob.id, { now: T0, via: "magic" });
      const gone = await createSession(port, bob.id, { now: T0, via: "magic" });
      await revokeSession(port, gone.token, at(1));
      let reads = 0;
      const counting: StoragePort = {
        query: (s) => {
          reads += 1;
          return port.query(s);
        },
        batch: (stmts) => port.batch(stmts),
      };
      const accounts = await resolveAccounts(
        counting,
        [b.token, "not-a-session", gone.token, a.token],
        { now: at(2) },
      );
      expect(accounts.map((x) => [x.email, x.sessionId, x.token])).toEqual([
        ["acc-bob@example.org", b.sessionId, b.token],
        ["acc-ann@example.org", a.sessionId, a.token],
      ]);
      expect(reads).toBe(1);
      // A month on, every one has expired.
      expect(await resolveAccounts(port, [a.token, b.token], { now: at(31 * 24 * 60) })).toEqual(
        [],
      );
      expect(await resolveAccounts(port, [], { now: at(2) })).toEqual([]);
    });

    it("issues a CSRF token bound to the session", async () => {
      const port = await makePort();
      const person = await findOrCreatePerson(port, "csrf@example.org", { now: T0 });
      const s = await createSession(port, person.id, { now: T0, via: "magic" });
      const other = await createSession(port, person.id, { now: T0, via: "magic" });
      const resolved = await resolveSession(port, s.token, { now: at(1) });
      if (resolved === null) throw new Error("expected session");
      expect(await verifyCsrf(s.token, resolved.csrfToken)).toBe(true);
      // Another session's CSRF token, even the same person's, is not valid here.
      const otherResolved = await resolveSession(port, other.token, { now: at(1) });
      expect(await verifyCsrf(s.token, otherResolved?.csrfToken ?? "")).toBe(false);
      expect(await verifyCsrf(s.token, "")).toBe(false);
    });
  });
}
