// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  createGroup,
  findGroupForMember,
  listGroupsFor,
  listMembers,
  normalizeGroupName,
} from "../../src/people/group.js";
import { findOrCreatePerson } from "../../src/people/person.js";

// Groups on BOTH drivers. Residue-tolerant: the D1 run shares one database, so each
// test makes its own people (unique addresses) and only queries through them.

const T0 = "2101-08-01T10:00:00.000Z";

export function runGroupsContract(makePort: () => Promise<StoragePort>): void {
  describe("groups", () => {
    it("the creator is the organizer, created atomically with the group", async () => {
      const port = await makePort();
      const ann = await findOrCreatePerson(port, "g-ann@example.org", { now: T0 });
      const group = await createGroup(port, {
        name: "  Thursday   Table ",
        creatorId: ann.id,
        now: T0,
      });
      expect(group.name).toBe("Thursday Table");
      expect(await findGroupForMember(port, group.id, ann.id)).toEqual({
        group,
        role: "organizer",
      });
    });

    it("a non-member cannot read a group — same answer as a missing one", async () => {
      // The IDOR guard: guessing or copying a group id gets an outsider nothing.
      const port = await makePort();
      const owner = await findOrCreatePerson(port, "g-owner@example.org", { now: T0 });
      const outsider = await findOrCreatePerson(port, "g-outsider@example.org", { now: T0 });
      const group = await createGroup(port, { name: "Private", creatorId: owner.id, now: T0 });
      expect(await findGroupForMember(port, group.id, outsider.id)).toBeNull();
      expect(await findGroupForMember(port, "no-such-group", outsider.id)).toBeNull();
    });

    it("lists only the person's own groups, with member counts and role", async () => {
      const port = await makePort();
      const bob = await findOrCreatePerson(port, "g-bob@example.org", { now: T0 });
      const eve = await findOrCreatePerson(port, "g-eve@example.org", { now: T0 });
      const mine = await createGroup(port, { name: "bob's", creatorId: bob.id, now: T0 });
      await createGroup(port, { name: "eve's", creatorId: eve.id, now: T0 });
      const groups = await listGroupsFor(port, bob.id);
      expect(groups.map((g) => g.id)).toEqual([mine.id]);
      expect(groups[0]).toMatchObject({ role: "organizer", memberCount: 1 });
    });

    it("lists members only through a proven membership", async () => {
      const port = await makePort();
      const dm = await findOrCreatePerson(port, "g-dm@example.org", { now: T0 });
      const group = await createGroup(port, { name: "Table", creatorId: dm.id, now: T0 });
      const membership = await findGroupForMember(port, group.id, dm.id);
      if (membership === null) throw new Error("expected membership");
      expect(await listMembers(port, membership)).toEqual([
        { personId: dm.id, email: "g-dm@example.org", displayName: null, role: "organizer" },
      ]);
    });

    it("the schema refuses an unknown role or tier", async () => {
      const port = await makePort();
      const p = await findOrCreatePerson(port, "g-chk@example.org", { now: T0 });
      const group = await createGroup(port, { name: "Checks", creatorId: p.id, now: T0 });
      const q = await findOrCreatePerson(port, "g-chk2@example.org", { now: T0 });
      await expect(
        port.batch([
          {
            sql: "INSERT INTO group_member (group_id, person_id, role, joined_at) VALUES (?, ?, ?, ?)",
            params: [group.id, q.id, "admin", T0],
          },
        ]),
      ).rejects.toThrow();
      await expect(
        port.batch([
          {
            sql: `INSERT INTO group_member (group_id, person_id, role, default_edit_tier, joined_at)
                  VALUES (?, ?, 'member', ?, ?)`,
            params: [group.id, q.id, "superuser", T0],
          },
        ]),
      ).rejects.toThrow();
    });

    it("validates names", () => {
      expect(() => normalizeGroupName("   ")).toThrow(/name/);
      expect(() => normalizeGroupName("x".repeat(81))).toThrow(/80/);
    });
  });
}
