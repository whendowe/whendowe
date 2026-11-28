// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { EVERYTHING } from "../../src/people/capability.js";
import { consumeLoginLink } from "../../src/people/login.js";
import { findOrCreatePerson, findPersonByEmail } from "../../src/people/person.js";
import {
  claimInstance,
  hasOperator,
  isKeptOperator,
  listKeptOperators,
  makeSetupLink,
  SETUP_TOKEN_TTL_MS,
  setupLinkWorks,
  shellSignInLink,
} from "../../src/people/setup.js";

// The setup link and the shell's sign-in links (DESIGN §10 rc60 *Running without email*) on
// BOTH drivers: claiming leans on one batch whose statements each run only if the one before
// changed a row, which is exactly what must not differ between libsql and D1.
//
// "No operator yet" is a fact about the whole database, and the D1 run shares one, so each test
// starts by clearing the two tables it is about. Addresses are still per test.

const T0 = "2101-09-01T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const NAMED = { default: "all", operators: ["named@setup.example"] } as const;

export function runSetupContract(makePort: () => Promise<StoragePort>): void {
  async function fresh(): Promise<StoragePort> {
    const port = await makePort();
    await port.batch([
      { sql: "DELETE FROM instance_operator", params: [] },
      { sql: "DELETE FROM setup_token", params: [] },
    ]);
    return port;
  }

  describe("setup", () => {
    it("a setup link makes one owner, once, and then no other link is made", async () => {
      const port = await fresh();
      expect(await hasOperator(port, EVERYTHING)).toBe(false);
      const link = await makeSetupLink(port, EVERYTHING, { now: T0 });
      if (!link.ok) throw new Error("no link");
      expect(link.expiresAt).toBe(at(SETUP_TOKEN_TTL_MS));
      // Looking does not use it.
      expect(await setupLinkWorks(port, EVERYTHING, link.token, { now: T0 })).toBe(true);
      expect(await setupLinkWorks(port, EVERYTHING, link.token, { now: T0 })).toBe(true);

      const claimed = await claimInstance(port, EVERYTHING, {
        token: link.token,
        email: " Owner.A@Setup.Example ",
        name: "  Ann  ",
        now: at(1000),
      });
      if (!claimed.ok) throw new Error(claimed.reason);
      const person = await findPersonByEmail(port, "owner.a@setup.example");
      expect(person?.id).toBe(claimed.personId);
      expect(person?.displayName).toBe("Ann");
      expect(await isKeptOperator(port, claimed.personId)).toBe(true);
      expect(await listKeptOperators(port)).toEqual(["owner.a@setup.example"]);
      expect(await hasOperator(port, EVERYTHING)).toBe(true);

      // Used: neither it nor a new one works, for anyone.
      expect(
        await claimInstance(port, EVERYTHING, {
          token: link.token,
          email: "owner.b@setup.example",
          name: "Bob",
          now: at(2000),
        }),
      ).toEqual({ ok: false, reason: "expired" });
      expect(await setupLinkWorks(port, EVERYTHING, link.token, { now: at(2000) })).toBe(false);
      expect(await makeSetupLink(port, EVERYTHING, { now: at(2000) })).toEqual({
        ok: false,
        reason: "has_operator",
      });
      expect(await findPersonByEmail(port, "owner.b@setup.example")).toBeNull();
    });

    it("a link lasts 30 minutes, and a new one ends the old", async () => {
      const port = await fresh();
      const first = await makeSetupLink(port, EVERYTHING, { now: T0 });
      if (!first.ok) throw new Error("no link");
      const last = at(SETUP_TOKEN_TTL_MS - 1);
      expect(await setupLinkWorks(port, EVERYTHING, first.token, { now: last })).toBe(true);
      expect(
        await setupLinkWorks(port, EVERYTHING, first.token, { now: at(SETUP_TOKEN_TTL_MS) }),
      ).toBe(false);
      expect(
        await claimInstance(port, EVERYTHING, {
          token: first.token,
          email: "late@setup.example",
          name: "Late",
          now: at(SETUP_TOKEN_TTL_MS),
        }),
      ).toEqual({ ok: false, reason: "expired" });

      const second = await makeSetupLink(port, EVERYTHING, { now: at(1000) });
      const third = await makeSetupLink(port, EVERYTHING, { now: at(2000) });
      if (!second.ok || !third.ok) throw new Error("no link");
      expect(await setupLinkWorks(port, EVERYTHING, second.token, { now: at(3000) })).toBe(false);
      expect(await setupLinkWorks(port, EVERYTHING, third.token, { now: at(3000) })).toBe(true);
      expect(await hasOperator(port, EVERYTHING)).toBe(false);
      expect(await findPersonByEmail(port, "late@setup.example")).toBeNull();
    });

    it("two claims at once make one owner", async () => {
      const port = await fresh();
      const link = await makeSetupLink(port, EVERYTHING, { now: T0 });
      if (!link.ok) throw new Error("no link");
      const results = await Promise.all(
        ["race.a@setup.example", "race.b@setup.example"].map((email) =>
          claimInstance(port, EVERYTHING, { token: link.token, email, name: "Racer", now: at(1) }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await listKeptOperators(port)).toHaveLength(1);
      const made = await Promise.all(
        ["race.a@setup.example", "race.b@setup.example"].map((e) => findPersonByEmail(port, e)),
      );
      expect(made.filter((p) => p !== null)).toHaveLength(1);
    });

    it("an address someone has is refused, and the link still works for another", async () => {
      const port = await fresh();
      await findOrCreatePerson(port, "taken@setup.example", { now: T0 });
      const link = await makeSetupLink(port, EVERYTHING, { now: T0 });
      if (!link.ok) throw new Error("no link");
      expect(
        await claimInstance(port, EVERYTHING, {
          token: link.token,
          email: "TAKEN@setup.example",
          name: "Thief",
          now: at(1),
        }),
      ).toEqual({ ok: false, reason: "address_taken" });
      expect(await hasOperator(port, EVERYTHING)).toBe(false);
      expect((await findPersonByEmail(port, "taken@setup.example"))?.displayName).toBeNull();
      const claimed = await claimInstance(port, EVERYTHING, {
        token: link.token,
        email: "untaken@setup.example",
        name: "Owner",
        now: at(2),
      });
      expect(claimed.ok).toBe(true);
    });

    it("a link made before the instance had an operator stops working once it has one", async () => {
      const port = await fresh();
      const link = await makeSetupLink(port, EVERYTHING, { now: T0 });
      if (!link.ok) throw new Error("no link");
      const other = await findOrCreatePerson(port, "kept.op@setup.example", { now: T0 });
      await port.batch([
        {
          sql: "INSERT INTO instance_operator (person_id, added_at) VALUES (?, ?)",
          params: [other.id, T0],
        },
      ]);
      expect(await setupLinkWorks(port, EVERYTHING, link.token, { now: at(1) })).toBe(false);
      expect(
        await claimInstance(port, EVERYTHING, {
          token: link.token,
          email: "second.owner@setup.example",
          name: "Second",
          now: at(1),
        }),
      ).toEqual({ ok: false, reason: "expired" });
      expect(await listKeptOperators(port)).toEqual(["kept.op@setup.example"]);
      expect(await findPersonByEmail(port, "second.owner@setup.example")).toBeNull();
    });

    it("with no capability configuration at all, setup works; a bad clock is refused", async () => {
      const port = await fresh();
      expect(await hasOperator(port, undefined)).toBe(false);
      await expect(makeSetupLink(port, undefined, { now: "not a time" })).rejects.toThrow(
        "invalid `now`",
      );
      const link = await makeSetupLink(port, undefined, { now: T0 });
      if (!link.ok) throw new Error("no link");
      expect(await setupLinkWorks(port, undefined, link.token, { now: at(1) })).toBe(true);
      const claimed = await claimInstance(port, undefined, {
        token: link.token,
        email: "bare@setup.example",
        name: "Bare",
        now: at(1),
      });
      expect(claimed.ok).toBe(true);
      expect(await hasOperator(port, undefined)).toBe(true);
    });

    it("a used link stays used, even once the instance has no operator again", async () => {
      const port = await fresh();
      const link = await makeSetupLink(port, EVERYTHING, { now: T0 });
      if (!link.ok) throw new Error("no link");
      const first = await claimInstance(port, EVERYTHING, {
        token: link.token,
        email: "gone.owner@setup.example",
        name: "Gone",
        now: at(1),
      });
      if (!first.ok) throw new Error(first.reason);
      // The owner's account erased: its operator row goes with it (ON DELETE CASCADE).
      await port.batch([
        { sql: "DELETE FROM instance_operator WHERE person_id = ?", params: [first.personId] },
      ]);
      expect(await hasOperator(port, EVERYTHING)).toBe(false);
      expect(await setupLinkWorks(port, EVERYTHING, link.token, { now: at(2) })).toBe(false);
      expect(
        await claimInstance(port, EVERYTHING, {
          token: link.token,
          email: "reuser@setup.example",
          name: "Reuser",
          now: at(2),
        }),
      ).toEqual({ ok: false, reason: "expired" });
      expect(await findPersonByEmail(port, "reuser@setup.example")).toBeNull();
    });

    it("the kept operators are listed in the order they were added, not made", async () => {
      const port = await fresh();
      const z = await findOrCreatePerson(port, "z.first@setup.example", { now: T0 });
      const a = await findOrCreatePerson(port, "a.second@setup.example", { now: T0 });
      await port.batch([
        {
          sql: "INSERT INTO instance_operator (person_id, added_at) VALUES (?, ?), (?, ?)",
          // Inserted, and made, in the other order, so neither the id nor the row decides.
          params: [z.id, at(2), a.id, at(1)],
        },
      ]);
      expect(await listKeptOperators(port)).toEqual([
        "a.second@setup.example",
        "z.first@setup.example",
      ]);
      expect(await isKeptOperator(port, z.id)).toBe(true);
      const other = await findOrCreatePerson(port, "not.op@setup.example", { now: T0 });
      expect(await isKeptOperator(port, other.id)).toBe(false);
    });

    it("operators in the configuration mean there is never a setup link", async () => {
      const port = await fresh();
      expect(await hasOperator(port, NAMED)).toBe(true);
      expect(await makeSetupLink(port, NAMED, { now: T0 })).toEqual({
        ok: false,
        reason: "has_operator",
      });
      // A link made before they were named stops working once they are.
      const link = await makeSetupLink(port, EVERYTHING, { now: T0 });
      if (!link.ok) throw new Error("no link");
      expect(await setupLinkWorks(port, NAMED, link.token, { now: at(1) })).toBe(false);
      expect(
        await claimInstance(port, NAMED, {
          token: link.token,
          email: "named.late@setup.example",
          name: "Late",
          now: at(1),
        }),
      ).toEqual({ ok: false, reason: "expired" });
      expect(await findPersonByEmail(port, "named.late@setup.example")).toBeNull();
    });

    it("the shell's sign-in link opens only an account that exists, once, recorded as console", async () => {
      const port = await fresh();
      expect(await shellSignInLink(port, "nobody@setup.example", { now: T0 })).toEqual({
        ok: false,
        reason: "no_account",
      });
      expect(await findPersonByEmail(port, "nobody@setup.example")).toBeNull();

      const person = await findOrCreatePerson(port, "lost@setup.example", { now: T0 });
      const link = await shellSignInLink(port, "Lost@Setup.Example", { now: T0 });
      if (!link.ok) throw new Error(link.reason);
      expect(await consumeLoginLink(port, link.token, { now: at(1) })).toEqual({
        email: "lost@setup.example",
        guestId: null,
        next: null,
        via: "console",
      });
      expect(await consumeLoginLink(port, link.token, { now: at(2) })).toBeNull();

      await port.batch([
        { sql: "UPDATE person SET erased_at = ? WHERE id = ?", params: [T0, person.id] },
      ]);
      expect(await shellSignInLink(port, "lost@setup.example", { now: at(3) })).toEqual({
        ok: false,
        reason: "no_account",
      });
    });
  });
}
