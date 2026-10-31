// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { createGroup, findGroupForMember, type GroupMembership } from "../../src/people/group.js";
import {
  acceptInvite,
  createInvite,
  type EditTier,
  INVITES_PER_GROUP_PER_DAY,
  peekInvite,
  type Visibility,
} from "../../src/people/invite.js";
import { findOrCreatePerson, findPersonByEmail, guestName } from "../../src/people/person.js";

// Invites on BOTH drivers. Residue-tolerant: each test uses its own addresses.

const T0 = "2101-09-01T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

async function groupOf(
  port: StoragePort,
  organizerEmail: string,
): Promise<{ membership: GroupMembership; organizerId: string }> {
  const organizer = await findOrCreatePerson(port, organizerEmail, { now: T0 });
  const group = await createGroup(port, { name: "Table", creatorId: organizer.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, organizer.id);
  if (membership === null) throw new Error("expected membership");
  return { membership, organizerId: organizer.id };
}

const viewFull: { editTier: EditTier; visibility: Visibility } = {
  editTier: "view",
  visibility: "FULL",
};

export function runInvitesContract(makePort: () => Promise<StoragePort>): void {
  describe("invites", () => {
    it("an invited newcomer becomes a person and a member, with the chosen tiers", async () => {
      const port = await makePort();
      const { membership, organizerId } = await groupOf(port, "i-dm@example.org");
      const invite = await createInvite(port, membership, {
        email: "I-New@Example.org",
        invitedBy: organizerId,
        now: T0,
        ...viewFull,
      });
      if (!invite.ok) throw new Error(invite.reason);
      expect(invite.email).toBe("i-new@example.org");
      // No person exists until the invite is USED.
      expect(await findPersonByEmail(port, "i-new@example.org")).toBeNull();

      const accepted = await acceptInvite(port, invite.token, at(1));
      if (accepted === null) throw new Error("expected accept");
      expect(await findGroupForMember(port, membership.group.id, accepted.personId)).toMatchObject({
        role: "member",
      });
      const rows = await port.query({
        sql: "SELECT default_edit_tier, default_visibility FROM group_member WHERE group_id = ? AND person_id = ?",
        params: [membership.group.id, accepted.personId],
      });
      expect(rows[0]).toEqual({ default_edit_tier: "view", default_visibility: "FULL" });
    });

    it("only an organizer can invite", async () => {
      const port = await makePort();
      const { membership, organizerId } = await groupOf(port, "i-dm2@example.org");
      const asMember: GroupMembership = { ...membership, role: "member" };
      expect(
        await createInvite(port, asMember, {
          email: "x@example.org",
          invitedBy: organizerId,
          now: T0,
          ...viewFull,
        }),
      ).toEqual({
        ok: false,
        reason: "not_organizer",
      });
    });

    it("refuses to invite someone already in the group", async () => {
      const port = await makePort();
      const { membership, organizerId } = await groupOf(port, "i-dm3@example.org");
      expect(
        await createInvite(port, membership, {
          email: "i-dm3@example.org",
          invitedBy: organizerId,
          now: T0,
          ...viewFull,
        }),
      ).toEqual({ ok: false, reason: "already_member" });
    });

    it("peeking never uses the invite; accepting works exactly once", async () => {
      const port = await makePort();
      const { membership, organizerId } = await groupOf(port, "i-dm4@example.org");
      const invite = await createInvite(port, membership, {
        email: "i-once@example.org",
        invitedBy: organizerId,
        now: T0,
        ...viewFull,
      });
      if (!invite.ok) throw new Error(invite.reason);
      for (let i = 0; i < 3; i += 1) {
        expect(await peekInvite(port, invite.token, at(1))).toEqual({
          groupName: "Table",
          // Named as the group sees them, never by address (§10 rc21).
          inviter: { name: guestName(membership.group.id, organizerId), email: null },
          email: "i-once@example.org",
        });
      }
      expect(await acceptInvite(port, invite.token, at(2))).not.toBeNull();
      expect(await acceptInvite(port, invite.token, at(3))).toBeNull();
      expect(await peekInvite(port, invite.token, at(3))).toBeNull();
    });

    it("concurrent accepts succeed exactly once", async () => {
      const port = await makePort();
      const { membership, organizerId } = await groupOf(port, "i-dm5@example.org");
      const invite = await createInvite(port, membership, {
        email: "i-race@example.org",
        invitedBy: organizerId,
        now: T0,
        ...viewFull,
      });
      if (!invite.ok) throw new Error(invite.reason);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => acceptInvite(port, invite.token, at(1))),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("an invite expires after 7 days", async () => {
      const port = await makePort();
      const { membership, organizerId } = await groupOf(port, "i-dm6@example.org");
      const invite = await createInvite(port, membership, {
        email: "i-late@example.org",
        invitedBy: organizerId,
        now: T0,
        ...viewFull,
      });
      if (!invite.ok) throw new Error(invite.reason);
      const eightDays = at(8 * 24 * 60);
      expect(await peekInvite(port, invite.token, eightDays)).toBeNull();
      expect(await acceptInvite(port, invite.token, eightDays)).toBeNull();
    });

    it("re-joining keeps an existing membership and role as they were", async () => {
      // Two invites to the same newcomer (a redundant one is possible by design);
      // the second accept must not duplicate or demote anything.
      const port = await makePort();
      const { membership, organizerId } = await groupOf(port, "i-dm7@example.org");
      const a = await createInvite(port, membership, {
        email: "i-twice@example.org",
        invitedBy: organizerId,
        now: T0,
        ...viewFull,
      });
      const b = await createInvite(port, membership, {
        email: "i-twice@example.org",
        invitedBy: organizerId,
        now: T0,
        ...viewFull,
      });
      if (!a.ok || !b.ok) throw new Error("expected invites");
      const first = await acceptInvite(port, a.token, at(1));
      const second = await acceptInvite(port, b.token, at(2));
      expect(second?.personId).toBe(first?.personId);
      const rows = await port.query({
        sql: "SELECT count(*) AS n FROM group_member WHERE group_id = ?",
        params: [membership.group.id],
      });
      expect(rows[0]?.n).toBe(2); // organizer + one member, not three
    });

    it("rate-limits invites per group per day, even concurrently", async () => {
      const port = await makePort();
      const { membership, organizerId } = await groupOf(port, "i-dm8@example.org");
      const results = await Promise.all(
        Array.from({ length: INVITES_PER_GROUP_PER_DAY + 10 }, (_, i) =>
          createInvite(port, membership, {
            email: `i-bulk${i}@example.org`,
            invitedBy: organizerId,
            now: T0,
            ...viewFull,
          }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(INVITES_PER_GROUP_PER_DAY);
    });
  });
}
