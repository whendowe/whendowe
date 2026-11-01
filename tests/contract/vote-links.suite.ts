// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { acceptPlan, createPollThread, listPlans } from "../../src/plans/plan.js";
import { createThread, findThreadForMember, leaveThread } from "../../src/plans/thread.js";
import {
  issueVoteLinks,
  resolveVoteLink,
  revokeUndeliveredVoteLink,
} from "../../src/plans/vote-link.js";
import { eraseAccount } from "../../src/privacy/erasure.js";
import { retentionPass } from "../../src/privacy/purge.js";

// A thread's vote links (DESIGN §10 rc26) on BOTH drivers: the upsert that rotates on
// resend but throttles within the hour, and every way a link stops working. Residue-
// tolerant: every test uses its own people.

const T0 = "2101-10-01T10:00:00.000Z";
const LATER = "2101-10-01T10:30:00.000Z"; // within the resend hour
const HOUR = "2101-10-01T11:00:00.000Z";
const EXPIRED = "2101-10-15T10:00:00.001Z"; // 14 days on
const SWEPT = "2101-10-16T10:00:00.002Z"; // and a day more

async function poll(port: StoragePort, tag: string) {
  const [mara, david, ana] = await Promise.all(
    ["mara", "david", "ana"].map((n) =>
      findOrCreatePerson(port, `vote-${n}-${tag}@example.org`, { now: T0 }),
    ),
  );
  if (mara === undefined || david === undefined || ana === undefined) throw new Error("people");
  const { threadId } = await createPollThread(port, {
    creatorId: mara.id,
    group: null,
    fields: { title: "Picnic", description: null, location: null, allDay: true, tzid: null },
    candidates: [
      { startLocal: "2101-11-21", endLocal: "2101-11-22" },
      { startLocal: "2101-11-14", endLocal: "2101-11-15" },
    ],
    people: [david.id, ana.id],
    now: T0,
  });
  const as = async (personId: string) => {
    const a = await findThreadForMember(port, threadId, personId);
    if (a === null) throw new Error("expected membership");
    return a;
  };
  return { mara, david, ana, threadId, as };
}

async function issued(port: StoragePort, access: Parameters<typeof issueVoteLinks>[1], now = T0) {
  const r = await issueVoteLinks(port, access, { now });
  if (r.kind !== "issued") throw new Error(r.kind);
  return r;
}

export function runVoteLinksContract(makePort: () => Promise<StoragePort>): void {
  describe("a thread's vote links (rc26)", () => {
    it("the organizer sends one to everyone else; it opens the thread as that person", async () => {
      const port = await makePort();
      const f = await poll(port, "a");
      const r = await issued(port, await f.as(f.mara.id));
      expect(r.links.map((l) => l.email).sort()).toEqual([f.ana.email, f.david.email].sort());
      expect(r.throttled).toBe(0);
      const david = r.links.find((l) => l.personId === f.david.id);
      const access = await resolveVoteLink(port, david?.token ?? "", LATER);
      expect(access?.personId).toBe(f.david.id);
      expect(access?.thread.id).toBe(f.threadId);
      expect(await resolveVoteLink(port, "not-a-token", LATER)).toBeNull();
      expect(await resolveVoteLink(port, "", LATER)).toBeNull();
      // Only the hash is kept.
      const rows = await port.query({
        sql: "SELECT token_hash FROM plan_vote_token WHERE thread_id = ?",
        params: [f.threadId],
      });
      expect(rows.some((row) => row.token_hash === david?.token)).toBe(false);
    });

    it("only the organizer sends them, and only while something is on the table", async () => {
      const port = await makePort();
      const f = await poll(port, "b");
      expect(await issueVoteLinks(port, await f.as(f.david.id), { now: T0 })).toEqual({
        kind: "forbidden",
      });
      const empty = await createThread(port, {
        name: "Nothing yet",
        tzid: "UTC",
        creatorId: f.mara.id,
        memberIds: [f.david.id],
        groupId: null,
        now: T0,
      });
      const access = await findThreadForMember(port, empty.id, f.mara.id);
      if (access === null) throw new Error("expected membership");
      expect(await issueVoteLinks(port, access, { now: T0 })).toEqual({ kind: "closed" });
      // Decided: nothing left on the table.
      const mara = await f.as(f.mara.id);
      const [first] = await listPlans(port, mara);
      await acceptPlan(port, mara, { planId: first?.id ?? "", now: T0 });
      expect(await issueVoteLinks(port, mara, { now: T0 })).toEqual({ kind: "closed" });
    });

    it("re-sending within the hour is throttled; after it, the new link replaces the old", async () => {
      const port = await makePort();
      const f = await poll(port, "c");
      const mara = await f.as(f.mara.id);
      const first = await issued(port, mara);
      expect(await issued(port, mara, LATER)).toMatchObject({ links: [], throttled: 2 });
      const second = await issued(port, mara, HOUR);
      expect(second.links).toHaveLength(2);
      const old = first.links[0]?.token ?? "";
      const fresh = second.links.find((l) => l.personId === first.links[0]?.personId)?.token ?? "";
      expect(await resolveVoteLink(port, old, HOUR)).toBeNull();
      expect(await resolveVoteLink(port, fresh, HOUR)).not.toBeNull();
    });

    it("an undelivered link is withdrawn, so a retry isn't throttled", async () => {
      const port = await makePort();
      const f = await poll(port, "d");
      const mara = await f.as(f.mara.id);
      const r = await issued(port, mara);
      const [lost, kept] = r.links;
      if (lost === undefined || kept === undefined) throw new Error("two links");
      await revokeUndeliveredVoteLink(port, lost);
      expect(await resolveVoteLink(port, lost.token, LATER)).toBeNull();
      expect(await resolveVoteLink(port, kept.token, LATER)).not.toBeNull();
      expect(await issued(port, mara, LATER)).toMatchObject({ throttled: 1 });
    });

    it("a link stops working on expiry, on leaving, and on erasure, and is swept a day on", async () => {
      const port = await makePort();
      const f = await poll(port, "e");
      const r = await issued(port, await f.as(f.mara.id));
      const token = (id: string) => r.links.find((l) => l.personId === id)?.token ?? "";
      const count = async (id: string) =>
        (
          await port.query({
            sql: "SELECT count(*) AS n FROM plan_vote_token WHERE person_id = ?",
            params: [id],
          })
        )[0]?.n;

      await leaveThread(port, await f.as(f.david.id), LATER);
      expect(await resolveVoteLink(port, token(f.david.id), LATER)).toBeNull();
      expect(await count(f.david.id)).toBe(0);

      await eraseAccount(port, f.ana.id, { now: LATER });
      expect(await count(f.ana.id)).toBe(0);

      // Mara's own link, from a member who stays: lives 14 days, then a day in the table.
      const g = await poll(port, "f");
      const kept = await issued(port, await g.as(g.mara.id));
      const t = kept.links[0]?.token ?? "";
      const id = kept.links[0]?.personId ?? "";
      expect(await resolveVoteLink(port, t, EXPIRED)).toBeNull();
      await retentionPass(port, EXPIRED);
      expect(await count(id)).toBe(1);
      await retentionPass(port, SWEPT);
      expect(await count(id)).toBe(0);
    });
  });
}
