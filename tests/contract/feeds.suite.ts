// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createTokenCipher } from "../../src/crypto/tokens.js";
import type { StoragePort } from "../../src/db/port.js";
import {
  createEvent,
  type EventAccess,
  type EventFieldsInput,
  findEventForParticipant,
  setCancelled,
} from "../../src/events/event.js";
import { removeParticipant } from "../../src/events/participation.js";
import {
  FEED_CANCELLED_DAYS,
  feedEntries,
  issueFeedLink,
  listFeeds,
  resolveFeed,
  shownFeedLink,
} from "../../src/feeds/feed.js";
import { createGroup, findGroupForMember, leaveGroup } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { eraseAccount } from "../../src/privacy/erasure.js";
import { exportPerson } from "../../src/privacy/export.js";

// Calendar feeds (DESIGN §10 rc34) on BOTH drivers: making and replacing a link, every
// way one stops working, and what a feed holds — agreed events at your tier, the
// recently cancelled, a group's own events — worked out on every read.

const T0 = "2101-10-01T10:00:00.000Z";
const T1 = "2101-10-02T10:00:00.000Z";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes: a test key
const url = (id: string) => `https://whendowe.example/events/${id}`;

const DINNER: EventFieldsInput = {
  title: "Dinner",
  description: "Bring wine",
  location: "Ann's",
  allDay: false,
  startLocal: "2101-11-21T18:00",
  endLocal: "2101-11-21T20:00",
  tzid: "Europe/Prague",
};

async function table(port: StoragePort, tag: string) {
  const ann = await findOrCreatePerson(port, `feed-ann-${tag}@example.org`, { now: T0 });
  const group = await createGroup(port, { name: `Jam ${tag}`, creatorId: ann.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, ann.id);
  if (membership === null) throw new Error("membership");
  const join = async (who: string, visibility: "FULL" | "DETAILS" | "BUSY" | "HIDDEN") => {
    const invite = await createInvite(port, membership, {
      email: `feed-${who}-${tag}@example.org`,
      invitedBy: ann.id,
      editTier: "view",
      visibility,
      now: T0,
    });
    if (!invite.ok) throw new Error(invite.reason);
    const accepted = await acceptInvite(port, invite.token, T0);
    if (accepted === null) throw new Error("accept");
    return accepted.personId;
  };
  return { ann: ann.id, group: group.id, membership, join };
}

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("access");
  return a;
}

export function runFeedsContract(makePort: () => Promise<StoragePort>): void {
  describe("calendar feeds (rc34)", () => {
    it("a link opens its person's feed; a new one replaces it; it shows again, decrypted", async () => {
      const port = await makePort();
      const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
      const { ann } = await table(port, "link");
      const first = await issueFeedLink(port, cipher, { personId: ann, groupId: null, now: T0 });
      if (first === null) throw new Error("issued");
      expect(await resolveFeed(port, first)).toEqual({
        personId: ann,
        groupId: null,
        groupName: null,
      });
      expect(await shownFeedLink(port, cipher, { personId: ann, groupId: null })).toBe(first);

      const second = await issueFeedLink(port, cipher, { personId: ann, groupId: null, now: T1 });
      expect(second).not.toBe(first);
      expect(await resolveFeed(port, first)).toBeNull(); // dead at once
      expect(await resolveFeed(port, second ?? "")).not.toBeNull();
      expect(await shownFeedLink(port, cipher, { personId: ann, groupId: null })).toBe(second);
      const stored = await port.query({
        sql: "SELECT token_hash, token_enc FROM feed_token WHERE person_id = ?",
        params: [ann],
      });
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(second ?? "?"); // never in the clear
      expect(await resolveFeed(port, "not-a-token")).toBeNull();
    });

    it("a group's feed is a member's own link; leaving the group ends it", async () => {
      const port = await makePort();
      const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
      const { ann, group, join } = await table(port, "group");
      const bob = await join("bob", "FULL");
      const stranger = await findOrCreatePerson(port, "feed-stranger@example.org", { now: T0 });
      expect(
        await issueFeedLink(port, cipher, { personId: stranger.id, groupId: group, now: T0 }),
      ).toBeNull();
      const own = await issueFeedLink(port, cipher, { personId: bob, groupId: null, now: T0 });
      const bobs = await issueFeedLink(port, cipher, { personId: bob, groupId: group, now: T0 });
      const anns = await issueFeedLink(port, cipher, { personId: ann, groupId: group, now: T0 });
      expect(new Set([own, bobs, anns]).size).toBe(3);
      expect(await resolveFeed(port, bobs ?? "")).toEqual({
        personId: bob,
        groupId: group,
        groupName: "Jam group",
      });
      expect((await listFeeds(port, bob)).map((f) => f.group)).toEqual([null, "Jam group"]);
      // The export says which feeds, never the links themselves.
      const exported = await exportPerson(port, bob, T0);
      expect(exported.calendar_feeds).toEqual([
        { feed: "your events", made_at: T0 },
        { feed: "events from Jam group", made_at: T0 },
      ]);
      expect(JSON.stringify(exported)).not.toContain(bobs ?? "?");

      const membership = await findGroupForMember(port, group, bob);
      if (membership === null) throw new Error("membership");
      await leaveGroup(port, membership, bob, T1);
      expect(await resolveFeed(port, bobs ?? "")).toBeNull();
      // Deleted, not just refused: resolveFeed's membership check alone would hide it.
      expect(
        await port.query({
          sql: "SELECT 1 AS present FROM feed_token WHERE person_id = ? AND group_id = ?",
          params: [bob, group],
        }),
      ).toEqual([]);
      expect(await resolveFeed(port, own ?? "")).not.toBeNull(); // his own feed stays
      expect(await resolveFeed(port, anns ?? "")).not.toBeNull();

      // However a membership ends, the link ends with it: the lookup checks it too.
      await port.batch([
        {
          sql: "DELETE FROM group_member WHERE group_id = ? AND person_id = ?",
          params: [group, ann],
        },
      ]);
      expect(await resolveFeed(port, anns ?? "")).toBeNull();
    });

    it("holds agreed events at each tier, the recently cancelled, and never HIDDEN", async () => {
      const port = await makePort();
      const { ann, membership, join } = await table(port, "tiers");
      const full = await join("full", "FULL");
      const details = await join("details", "DETAILS");
      const busy = await join("busy", "BUSY");
      const hidden = await join("hidden", "HIDDEN");
      const dinner = await createEvent(port, {
        creatorId: ann,
        group: membership,
        fields: DINNER,
        now: T0,
      });
      const cancelled = await createEvent(port, {
        creatorId: ann,
        group: membership,
        fields: {
          ...DINNER,
          title: "Off",
          startLocal: "2101-11-22T18:00",
          endLocal: "2101-11-22T20:00",
        },
        now: T0,
      });
      await setCancelled(port, await access(port, cancelled.id, ann), { cancelled: true, now: T1 });
      // Waiting for agreement: an open question, not in any feed.
      await createEvent(port, {
        creatorId: ann,
        group: membership,
        fields: { ...DINNER, title: "Maybe" },
        requests: new Map([[full, "accept"]]),
        now: T0,
      });

      const feed = (personId: string, now = T1) =>
        feedEntries(port, { personId, groupId: null }, { now, eventUrl: url });
      const titles = async (personId: string, now = T1) =>
        (await feed(personId, now)).map((e) => [e.title, e.status, e.visibility]);
      expect(await titles(full)).toEqual([
        ["Dinner", "scheduled", "FULL"],
        ["Off", "cancelled", "FULL"],
      ]);
      expect((await feed(details))[0]).toMatchObject({
        visibility: "DETAILS",
        url: url(dinner.id),
        allDay: false,
        startLocal: "2101-11-21T18:00:00",
        tzid: "Europe/Prague",
      });
      expect((await feed(busy))[0]).toMatchObject({ visibility: "BUSY", url: null });
      expect(await feed(hidden)).toEqual([]);
      // Still there 29 days on, so calendars that have it learn it was cancelled…
      const soon = new Date(Date.parse(T1) + (FEED_CANCELLED_DAYS - 1) * 86_400_000).toISOString();
      expect((await titles(full, soon)).map(([t]) => t)).toEqual(["Dinner", "Off"]);
      // …and left out a month on.
      const later = new Date(Date.parse(T1) + (FEED_CANCELLED_DAYS + 1) * 86_400_000).toISOString();
      expect(await titles(full, later)).toEqual([["Dinner", "scheduled", "FULL"]]);

      // Removed from it, it's gone on the next read: nothing was written to any feed.
      await removeParticipant(port, await access(port, dinner.id, ann), {
        personId: full,
        now: T1,
      });
      expect((await titles(full)).map(([t]) => t)).toEqual(["Off"]);
    });

    it("a group's feed holds only that group's events; yours holds them all", async () => {
      const port = await makePort();
      const a = await table(port, "ga");
      const b = await table(port, "gb");
      const bob = await a.join("bob", "FULL");
      // Bob is in b's group too: the same person, invited by address.
      const invite = await createInvite(port, b.membership, {
        email: "feed-bob-ga@example.org",
        invitedBy: b.ann,
        editTier: "view",
        visibility: "FULL",
        now: T0,
      });
      if (!invite.ok) throw new Error(invite.reason);
      await acceptInvite(port, invite.token, T0);
      await createEvent(port, {
        creatorId: a.ann,
        group: a.membership,
        fields: { ...DINNER, title: "A" },
        now: T0,
      });
      await createEvent(port, {
        creatorId: b.ann,
        group: b.membership,
        fields: { ...DINNER, title: "B" },
        now: T0,
      });
      const titles = async (groupId: string | null) =>
        (await feedEntries(port, { personId: bob, groupId }, { now: T1, eventUrl: url })).map(
          (e) => e.title,
        );
      await createEvent(port, {
        creatorId: a.ann,
        group: a.membership,
        fields: {
          ...DINNER,
          title: "A2",
          allDay: true,
          startLocal: "2101-11-25",
          endLocal: "2101-11-26",
          tzid: null,
        },
        now: T0,
      });
      const a2 = (
        await feedEntries(port, { personId: bob, groupId: a.group }, { now: T1, eventUrl: url })
      ).find((e) => e.title === "A2");
      expect(a2).toMatchObject({
        allDay: true,
        startLocal: "2101-11-25",
        endLocal: "2101-11-26",
        tzid: null,
      });
      expect((await titles(a.group)).filter((t) => t !== "A2")).toEqual(["A"]);
      expect(await titles(b.group)).toEqual(["B"]);
      expect((await titles(null)).sort()).toEqual(["A", "A2", "B"]);
    });

    it("deleting an account deletes its feed links", async () => {
      const port = await makePort();
      const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
      const { group, join } = await table(port, "erase");
      const bob = await join("bob", "FULL");
      const own = await issueFeedLink(port, cipher, { personId: bob, groupId: null, now: T0 });
      const grp = await issueFeedLink(port, cipher, { personId: bob, groupId: group, now: T0 });
      await eraseAccount(port, bob, { now: T1 });
      expect(await resolveFeed(port, own ?? "")).toBeNull();
      expect(await resolveFeed(port, grp ?? "")).toBeNull();
      expect(
        await port.query({
          sql: "SELECT 1 AS present FROM feed_token WHERE person_id = ?",
          params: [bob],
        }),
      ).toEqual([]);
    });
  });
}
