// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  type CapabilityConfig,
  EVERYTHING,
  grantCapability,
  hasCapability,
  isOperator,
  listCapabilityChanges,
  listGrants,
  revokeCapability,
} from "../../src/people/capability.js";
import { findOrCreatePerson, findPersonByEmail } from "../../src/people/person.js";
import { eraseAccount } from "../../src/privacy/erasure.js";

// Capabilities (DESIGN §10 rc43) on BOTH drivers. Residue-tolerant: each test uses its own
// addresses, and never assumes the grant list holds only its own rows.

const T0 = "2101-09-01T10:00:00.000Z";
const T1 = "2101-09-01T11:00:00.000Z";
const GRANTED: CapabilityConfig = { default: "granted", operators: ["op@example.org"] };

export function runCapabilitiesContract(makePort: () => Promise<StoragePort>): void {
  describe("capabilities (rc43)", () => {
    it("with `all` everyone has everything; with `granted` only what an operator granted", async () => {
      const port = await makePort();
      const op = await findOrCreatePerson(port, "cap-op-a@example.org", { now: T0 });
      const ann = await findOrCreatePerson(port, "cap-ann-a@example.org", { now: T0 });
      expect(await hasCapability(port, EVERYTHING, ann.id, "verify")).toBe(true);
      expect(await hasCapability(port, GRANTED, ann.id, "verify")).toBe(false);
      expect(
        await grantCapability(port, {
          email: ann.email,
          capability: "verify",
          actorId: op.id,
          now: T0,
        }),
      ).toBe("granted");
      expect(await hasCapability(port, GRANTED, ann.id, "verify")).toBe(true);
      expect(await hasCapability(port, GRANTED, ann.id, "calendar_sync")).toBe(false);
      // Granting again changes nothing and logs nothing.
      expect(
        await grantCapability(port, {
          email: ann.email,
          capability: "verify",
          actorId: op.id,
          now: T1,
        }),
      ).toBe("already");
      expect(
        await revokeCapability(port, {
          personId: ann.id,
          capability: "verify",
          actorId: op.id,
          now: T1,
        }),
      ).toBe("revoked");
      expect(await hasCapability(port, GRANTED, ann.id, "verify")).toBe(false);
      expect(
        await revokeCapability(port, {
          personId: ann.id,
          capability: "verify",
          actorId: op.id,
          now: T1,
        }),
      ).toBe("absent");
      const mine = (await listCapabilityChanges(port)).filter((x) => x.email === ann.email);
      expect(mine.map((x) => [x.action, x.capability, x.actorEmail, x.at])).toEqual([
        ["revoked", "verify", op.email, T1],
        ["granted", "verify", op.email, T0],
      ]);
    });

    it("granting to an address with no account creates the person; the list groups by account", async () => {
      const port = await makePort();
      const op = await findOrCreatePerson(port, "cap-op-b@example.org", { now: T0 });
      expect(await findPersonByEmail(port, "cap-new-b@example.org")).toBeNull();
      await grantCapability(port, {
        email: "Cap-New-B@Example.org",
        capability: "long_history",
        actorId: op.id,
        now: T0,
      });
      await grantCapability(port, {
        email: "cap-new-b@example.org",
        capability: "calendar_sync",
        actorId: op.id,
        now: T0,
      });
      const person = await findPersonByEmail(port, "cap-new-b@example.org");
      if (person === null) throw new Error("expected a person");
      expect(await hasCapability(port, GRANTED, person.id, "long_history")).toBe(true);
      expect((await listGrants(port)).find((g) => g.personId === person.id)).toEqual({
        personId: person.id,
        email: "cap-new-b@example.org",
        capabilities: ["calendar_sync", "long_history"],
      });
    });

    it("erasing an account takes its grants; the log keeps the change, without the address", async () => {
      const port = await makePort();
      const op = await findOrCreatePerson(port, "cap-op-c@example.org", { now: T0 });
      const ann = await findOrCreatePerson(port, "cap-ann-c@example.org", { now: T0 });
      await grantCapability(port, {
        email: ann.email,
        capability: "verify",
        actorId: op.id,
        now: T0,
      });
      await eraseAccount(port, ann.id, { now: T1 });
      expect((await listGrants(port)).some((g) => g.personId === ann.id)).toBe(false);
      expect((await listCapabilityChanges(port)).some((x) => x.email === ann.email)).toBe(false);
    });

    it("operators are the configured addresses, however they are written", () => {
      const config: CapabilityConfig = { default: "granted", operators: ["op@example.org"] };
      expect(isOperator(config, "Op@Example.org ")).toBe(true);
      expect(isOperator(config, "someone@example.org")).toBe(false);
      expect(isOperator(EVERYTHING, "op@example.org")).toBe(false);
    });
  });
}
