// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { findEventForParticipant, listHistory } from "../../src/events/event.js";
import { SHARED_LINK, SIGNED_IN } from "../../src/events/response.js";
import {
  createGroup,
  findGroupForMember,
  setDefaultOwnAnswersOnly,
  setGroupDefaultVerified,
} from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { hashToken } from "../../src/people/tokens.js";
import {
  acceptPlan,
  addDraftEvent,
  castVote,
  createPollThread,
  listPlans,
  sendDraft,
  startDraft,
  suggestTime,
} from "../../src/plans/plan.js";
import {
  claimName,
  issueShareLink,
  joinByShareLink,
  removeGuest,
  resolveClaim,
  resolveShareLink,
} from "../../src/plans/share.js";
import {
  createThread,
  findThreadForMember,
  leaveThread,
  listUnsentThreadReceipts,
  recordUnsentThreadReceipt,
  setThreadVerified,
} from "../../src/plans/thread.js";
import {
  issueVoteLinks,
  resolveVoteLink,
  revokeUndeliveredVoteLink,
  setThreadOwnAnswersOnly,
} from "../../src/plans/vote-link.js";
import { eraseAccount } from "../../src/privacy/erasure.js";
import { purgeThreadStatements, retentionPass } from "../../src/privacy/purge.js";

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

/** Each person's own-answers switch on the event a plan's acceptance made. */
async function ownOnEvent(port: StoragePort, planId: string) {
  const rows = await port.query({
    sql: `SELECT ep.person_id, ep.own_answers_only FROM event_participation ep
          JOIN plan_event pe ON pe.canonical_event_id = ep.canonical_event_id WHERE pe.plan_id = ?`,
    params: [planId],
  });
  return Object.fromEntries(rows.map((r) => [String(r.person_id), Number(r.own_answers_only)]));
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
      expect(access?.access.personId).toBe(f.david.id);
      expect(access?.access.thread.id).toBe(f.threadId);
      expect(await resolveVoteLink(port, "not-a-token", LATER)).toBeNull();
      expect(await resolveVoteLink(port, "", LATER)).toBeNull();
      // Only the hash is kept.
      const rows = await port.query({
        sql: "SELECT token_hash FROM plan_vote_token WHERE thread_id = ?",
        params: [f.threadId],
      });
      expect(rows.some((row) => row.token_hash === david?.token)).toBe(false);
    });

    it("copying (rc36): just that member's link, replaced even within the resend hour", async () => {
      const port = await makePort();
      const f = await poll(port, "copy");
      const mara = await f.as(f.mara.id);
      const sent = await issued(port, mara);
      const before = sent.links.find((l) => l.personId === f.david.id)?.token ?? "";
      // Within the hour an email resend is throttled…
      expect((await issued(port, mara, LATER)).links).toEqual([]);
      // …a copy is not, and it is David's alone.
      const copied = await issueVoteLinks(port, mara, { now: LATER, only: f.david.id, copy: true });
      if (copied.kind !== "issued") throw new Error(copied.kind);
      expect(copied.links.map((l) => l.personId)).toEqual([f.david.id]);
      expect(await resolveVoteLink(port, before, LATER)).toBeNull();
      expect(
        (await resolveVoteLink(port, copied.links[0]?.token ?? "", LATER))?.access.personId,
      ).toBe(f.david.id);
      // Ana's link is untouched.
      const ana = sent.links.find((l) => l.personId === f.ana.id)?.token ?? "";
      expect((await resolveVoteLink(port, ana, LATER))?.access.personId).toBe(f.ana.id);
    });

    it("only my own email (rc42): no copied vote link, set only by the person, kept on the agreed event", async () => {
      const port = await makePort();
      const f = await poll(port, "own");
      const mara = await f.as(f.mara.id);
      const tokenOf = (links: readonly { personId: string; token: string }[], who: string) =>
        links.find((l) => l.personId === who)?.token ?? "";
      const mailed = await issued(port, mara);

      // David's link is copied. From it he can't turn the switch on: that is what it guards.
      const copied = await issueVoteLinks(port, mara, { now: LATER, only: f.david.id, copy: true });
      if (copied.kind !== "issued") throw new Error(copied.kind);
      const davidCopied = await resolveVoteLink(port, tokenOf(copied.links, f.david.id), LATER);
      if (davidCopied === null) throw new Error("expected link");
      for (const arrival of [davidCopied.arrival, null])
        expect(await setThreadOwnAnswersOnly(port, davidCopied.access, { on: true, arrival })).toBe(
          "forbidden",
        );

      // Ana turns hers on from her mailed link: nobody copies hers now.
      const anaMailed = await resolveVoteLink(port, tokenOf(mailed.links, f.ana.id), LATER);
      if (anaMailed === null) throw new Error("expected link");
      expect(
        await setThreadOwnAnswersOnly(port, anaMailed.access, {
          on: true,
          arrival: anaMailed.arrival,
        }),
      ).toBe("saved");
      expect(
        (await f.as(f.mara.id)).members.find((m) => m.personId === f.ana.id)?.ownAnswersOnly,
      ).toBe(true);
      const copyAna = await issueVoteLinks(port, mara, { now: LATER, only: f.ana.id, copy: true });
      expect(copyAna).toMatchObject({ kind: "issued", links: [] });
      expect(await resolveVoteLink(port, tokenOf(mailed.links, f.ana.id), LATER)).not.toBeNull();

      // As a backstop, a vote that came any other way doesn't count for her.
      expect(
        await castVote(port, await f.as(f.ana.id), {
          planId: (await listPlans(port, mara))[0]?.id ?? "",
          answer: "no",
          now: LATER,
          arrival: { via: "copied", by: f.mara.id },
        }),
      ).toEqual({ kind: "forbidden" });

      // David, signed in, turns his on and off: his copied link is gone for good.
      const david = await f.as(f.david.id);
      expect(await setThreadOwnAnswersOnly(port, david, { on: true, arrival: SIGNED_IN })).toBe(
        "saved",
      );
      expect(await resolveVoteLink(port, tokenOf(copied.links, f.david.id), LATER)).toBeNull();
      await setThreadOwnAnswersOnly(port, david, { on: false, arrival: SIGNED_IN });
      expect(await resolveVoteLink(port, tokenOf(copied.links, f.david.id), LATER)).toBeNull();
      expect(
        (await f.as(f.mara.id)).members.find((m) => m.personId === f.david.id)?.ownAnswersOnly,
      ).toBe(false);

      // A link from before rc42 recorded its origin doesn't vote as Ana while hers is on.
      await port.batch([
        {
          sql: "UPDATE plan_vote_token SET origin = NULL WHERE thread_id = ? AND person_id = ?",
          params: [f.threadId, f.ana.id],
        },
      ]);
      expect(await resolveVoteLink(port, tokenOf(mailed.links, f.ana.id), LATER)).toBeNull();
      // Off, that link works again; on and off once more, it was withdrawn and stays dead.
      const asAna = await f.as(f.ana.id);
      await setThreadOwnAnswersOnly(port, asAna, { on: false, arrival: SIGNED_IN });
      expect(await resolveVoteLink(port, tokenOf(mailed.links, f.ana.id), LATER)).not.toBeNull();
      await setThreadOwnAnswersOnly(port, asAna, { on: true, arrival: SIGNED_IN });
      await setThreadOwnAnswersOnly(port, asAna, { on: false, arrival: SIGNED_IN });
      expect(await resolveVoteLink(port, tokenOf(mailed.links, f.ana.id), LATER)).toBeNull();
      await setThreadOwnAnswersOnly(port, asAna, { on: true, arrival: SIGNED_IN });

      // The agreed time's event carries each member's switch.
      const [plan = ""] = (await listPlans(port, mara)).map((p) => p.id);
      expect(
        (await acceptPlan(port, await f.as(f.mara.id), { planId: plan, now: LATER })).kind,
      ).toBe("accepted");
      expect(await ownOnEvent(port, plan)).toEqual({
        [f.mara.id]: 0,
        [f.david.id]: 0,
        [f.ana.id]: 1,
      });
    });

    it("a verified thread (rc42): mailed or signed in only, no shared link, guests kept but silent", async () => {
      const port = await makePort();
      const f = await poll(port, "ver");
      const mara = await f.as(f.mara.id);
      const [plan = ""] = (await listPlans(port, mara)).map((p) => p.id);
      const tokenOf = (links: readonly { personId: string; token: string }[], who: string) =>
        links.find((l) => l.personId === who)?.token ?? "";
      // Before: a guest joins by the shared link and votes; David's link is copied; Ana's mailed.
      const share = await issueShareLink(port, mara, { now: T0 });
      if (share.kind !== "issued") throw new Error(share.kind);
      const q = await resolveShareLink(port, share.token, T0);
      if (q === null) throw new Error("link");
      const kestrel = await claimName(port, q, { name: "Kestrel", now: T0 });
      if (kestrel.kind !== "claimed") throw new Error(kestrel.kind);
      const mailed = await issued(port, await f.as(f.mara.id));
      const copied = await issueVoteLinks(port, await f.as(f.mara.id), {
        now: LATER,
        only: f.david.id,
        copy: true,
      });
      if (copied.kind !== "issued") throw new Error(copied.kind);

      // A vote link from before rc42 recorded how links were made (the organizer's, standing in).
      await port.batch([
        {
          sql: `INSERT INTO plan_vote_token (token_hash, thread_id, person_id, expires_at, created_at)
                VALUES ('pre-rc42', ?, ?, ?, ?)`,
          params: [f.threadId, f.mara.id, HOUR, T0],
        },
      ]);
      const left = async () => ({
        origins: (
          await port.query({
            sql: "SELECT origin FROM plan_vote_token WHERE thread_id = ? ORDER BY origin",
            params: [f.threadId],
          })
        ).map((r) => r.origin),
        shareLinks: (
          await port.query({
            sql: "SELECT 1 AS n FROM share_link WHERE thread_id = ?",
            params: [f.threadId],
          })
        ).length,
      });
      expect(await left()).toEqual({
        origins: [null, "copied", "mailed"],
        shareLinks: 1,
      });

      // Only whoever decides verifies it (here the organizer: there are four in it).
      expect(await setThreadVerified(port, await f.as(f.david.id), LATER)).toBe("forbidden");
      expect(await setThreadVerified(port, await f.as(f.mara.id), LATER)).toBe("verified");
      expect(await setThreadVerified(port, await f.as(f.mara.id), HOUR)).toBe("already");
      const after = await f.as(f.mara.id);
      expect(after.thread.verifiedAt).toBe(LATER);
      // What could come back if it were ever turned off is deleted, not just refused.
      expect(await left()).toEqual({ origins: ["mailed"], shareLinks: 0 });
      // A shared link that somehow still existed wouldn't open it either.
      await port.batch([
        {
          sql: `INSERT INTO share_link (token_hash, thread_id, created_by, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?)`,
          params: [await hashToken(share.token), f.threadId, f.mara.id, HOUR, T0],
        },
      ]);
      expect(await resolveShareLink(port, share.token, LATER)).toBeNull();
      await port.batch([
        { sql: "DELETE FROM share_link WHERE thread_id = ?", params: [f.threadId] },
      ]);

      // The shared link is gone, and can't be made again; the guest is listed, can't answer,
      // and isn't removed.
      expect(await resolveShareLink(port, share.token, LATER)).toBeNull();
      expect(await issueShareLink(port, after, { now: LATER })).toEqual({ kind: "verified" });
      expect(await resolveClaim(port, kestrel.token, f.threadId)).toBeNull();
      expect(after.members.some((m) => m.personId === kestrel.access.personId && m.guest)).toBe(
        true,
      );
      expect(await removeGuest(port, after, kestrel.access.personId)).toEqual({ kind: "verified" });
      // Her page from before can't vote (the statement checks), and as she is now, she's refused.
      const noVote = { planId: plan, answer: "no", now: LATER, arrival: SHARED_LINK } as const;
      expect((await castVote(port, kestrel.access, noVote)).kind).toBe("closed");
      const asNow = await f.as(kestrel.access.personId);
      expect(await castVote(port, asNow, noVote)).toEqual({ kind: "forbidden" });

      // Vote links: the copied one is gone, nobody's is copied, the mailed one works.
      expect(await resolveVoteLink(port, tokenOf(copied.links, f.david.id), LATER)).toBeNull();
      expect(
        await issueVoteLinks(port, after, { now: LATER, only: f.ana.id, copy: true }),
      ).toMatchObject({
        kind: "issued",
        links: [],
      });
      const ana = await resolveVoteLink(port, tokenOf(mailed.links, f.ana.id), LATER);
      expect(ana?.arrival).toEqual({ via: "mailed", by: null });
      if (ana === null) throw new Error("link");
      for (const arrival of [{ via: "copied", by: f.mara.id } as const, null])
        expect(
          await castVote(port, ana.access, { planId: plan, answer: "yes", now: LATER, arrival }),
        ).toEqual({
          kind: "forbidden",
        });
      expect(
        (
          await castVote(port, ana.access, {
            planId: plan,
            answer: "yes",
            now: LATER,
            arrival: ana.arrival,
          })
        ).kind,
      ).toBe("recorded");
      // A vote link from before rc42 recorded its origin doesn't vote here either.
      await port.batch([
        {
          sql: "UPDATE plan_vote_token SET origin = NULL WHERE thread_id = ? AND person_id = ?",
          params: [f.threadId, f.ana.id],
        },
      ]);
      expect(await resolveVoteLink(port, tokenOf(mailed.links, f.ana.id), LATER)).toBeNull();

      // Everyone's address shows; what it agrees is a verified event, and its history says so.
      expect(
        (await f.as(f.david.id)).members.find((m) => m.personId === f.mara.id)?.shown.email,
      ).toBe(f.mara.email);
      expect(
        (await acceptPlan(port, await f.as(f.mara.id), { planId: plan, now: HOUR })).kind,
      ).toBe("accepted");
      const [row] = await port.query({
        sql: "SELECT canonical_event_id FROM plan_event WHERE plan_id = ?",
        params: [plan],
      });
      const event = await findEventForParticipant(port, String(row?.canonical_event_id), f.ana.id);
      expect(event?.event.verifiedAt).toBe(HOUR);
      if (event === null) throw new Error("event");
      expect((await listHistory(port, event))[0]?.change).toMatchObject({
        verified: { before: null, after: 1 },
      });
    });

    it("vote receipts that didn't go out (rc42): listed in order, gone with the person or the thread", async () => {
      const port = await makePort();
      const f = await poll(port, "unsent");
      await recordUnsentThreadReceipt(port, {
        threadId: f.threadId,
        personId: f.ana.id,
        reason: "capped",
        now: T0,
      });
      await recordUnsentThreadReceipt(port, {
        threadId: f.threadId,
        personId: f.david.id,
        reason: "failed",
        now: LATER,
      });
      expect(await listUnsentThreadReceipts(port, await f.as(f.mara.id))).toEqual([
        { personId: f.ana.id, reason: "capped", at: T0 },
        { personId: f.david.id, reason: "failed", at: LATER },
      ]);
      await eraseAccount(port, f.ana.id, { now: HOUR });
      expect(
        (await listUnsentThreadReceipts(port, await f.as(f.mara.id))).map((u) => u.personId),
      ).toEqual([f.david.id]);
      await port.batch(purgeThreadStatements(f.threadId, HOUR));
      expect(
        await port.query({
          sql: "SELECT 1 AS n FROM receipt_unsent WHERE thread_id = ?",
          params: [f.threadId],
        }),
      ).toEqual([]);
    });

    it("a thread starts verified when asked, or from its group's default; otherwise not (rc42)", async () => {
      const port = await makePort();
      const people = await Promise.all(
        ["mara", "ana"].map((n) =>
          findOrCreatePerson(port, `vote-${n}-vbirth@example.org`, { now: T0 }),
        ),
      );
      const [mara, ana] = people;
      if (mara === undefined || ana === undefined) throw new Error("people");
      const group = await createGroup(port, { name: "Board", creatorId: mara.id, now: T0 });
      const membership = await findGroupForMember(port, group.id, mara.id);
      if (membership === null) throw new Error("membership");
      const plain = await createThread(port, {
        name: "Plain",
        tzid: "UTC",
        creatorId: mara.id,
        memberIds: [ana.id],
        now: T0,
      });
      expect(plain.verifiedAt).toBeNull();
      const asked = await createThread(port, {
        name: "Asked",
        tzid: "UTC",
        creatorId: mara.id,
        memberIds: [ana.id],
        verified: true,
        now: T0,
      });
      expect(asked.verifiedAt).toBe(T0);
      expect((await findThreadForMember(port, asked.id, mara.id))?.thread.verifiedAt).toBe(T0);
      const fromGroupOff = await createThread(port, {
        name: "Off",
        tzid: "UTC",
        creatorId: mara.id,
        memberIds: [ana.id],
        groupId: group.id,
        now: T0,
      });
      expect(fromGroupOff.verifiedAt).toBeNull();
      await setGroupDefaultVerified(port, membership, true);
      const fromGroup = await createThread(port, {
        name: "On",
        tzid: "UTC",
        creatorId: mara.id,
        memberIds: [ana.id],
        groupId: group.id,
        now: T0,
      });
      expect(fromGroup.verifiedAt).toBe(T0);
      const poll = await createPollThread(port, {
        creatorId: mara.id,
        group: membership,
        fields: {
          title: "Board meeting",
          description: null,
          location: null,
          allDay: true,
          tzid: null,
        },
        candidates: [{ startLocal: "2101-11-21", endLocal: "2101-11-22" }],
        now: T0,
      });
      expect((await findThreadForMember(port, poll.threadId, mara.id))?.thread.verifiedAt).toBe(T0);
      const loose = await createPollThread(port, {
        creatorId: mara.id,
        group: null,
        fields: { title: "Lunch", description: null, location: null, allDay: true, tzid: null },
        candidates: [{ startLocal: "2101-11-21", endLocal: "2101-11-22" }],
        verified: true,
        now: T0,
      });
      expect((await findThreadForMember(port, loose.threadId, mara.id))?.thread.verifiedAt).toBe(
        T0,
      );
    });

    it("a group's default for their own answers comes with its members into a thread (rc42)", async () => {
      const port = await makePort();
      const people = await Promise.all(
        ["mara", "ana", "bea", "carl", "dora"].map((n) =>
          findOrCreatePerson(port, `vote-${n}-gdef@example.org`, { now: T0 }),
        ),
      );
      const [mara, ana, bea, carl, dora] = people;
      if (
        mara === undefined ||
        ana === undefined ||
        bea === undefined ||
        carl === undefined ||
        dora === undefined
      )
        throw new Error("people");
      const group = await createGroup(port, { name: "Climbers", creatorId: mara.id, now: T0 });
      const membership = await findGroupForMember(port, group.id, mara.id);
      if (membership === null) throw new Error("membership");
      const join = async (p: { id: string; email: string }, visibility: "FULL" | "BUSY") => {
        const invite = await createInvite(port, membership, {
          email: p.email,
          invitedBy: mara.id,
          editTier: "view",
          visibility,
          now: T0,
        });
        if (!invite.ok) throw new Error(invite.reason);
        await acceptInvite(port, invite.token, T0);
        // Everyone's default is on but Dora's.
        if (p !== dora) await setDefaultOwnAnswersOnly(port, membership, p.id, true);
      };
      await join(ana, "FULL");
      await join(bea, "BUSY");
      await join(dora, "FULL");
      const { threadId, planIds } = await createPollThread(port, {
        creatorId: mara.id,
        group: membership,
        fields: { title: "Crag day", description: null, location: null, allDay: true, tzid: null },
        candidates: [{ startLocal: "2101-11-21", endLocal: "2101-11-22" }],
        people: [ana.id, dora.id],
        now: T0,
      });
      const as = async (id: string) => {
        const a = await findThreadForMember(port, threadId, id);
        if (a === null) throw new Error("member");
        return a;
      };
      const own = async () =>
        Object.fromEntries((await as(mara.id)).members.map((m) => [m.personId, m.ownAnswersOnly]));
      expect(await own()).toEqual({ [mara.id]: false, [ana.id]: true, [dora.id]: false });

      // Carl joins the group afterwards, then the thread by its shared link, signed in: his
      // default comes with him.
      await join(carl, "FULL");
      const share = await issueShareLink(port, await as(mara.id), { now: T0 });
      if (share.kind !== "issued") throw new Error(share.kind);
      const q = await resolveShareLink(port, share.token, T0);
      if (q === null) throw new Error("link");
      expect((await joinByShareLink(port, q, carl.id, T0)).kind).toBe("joined");
      expect((await own())[carl.id]).toBe(true);

      // Bea sees only busy time: she wasn't asked, and her event takes her default (rc27).
      const [plan = ""] = planIds;
      expect((await acceptPlan(port, await as(mara.id), { planId: plan, now: LATER })).kind).toBe(
        "accepted",
      );
      expect(await ownOnEvent(port, plan)).toEqual({
        [mara.id]: 0,
        [ana.id]: 1,
        [dora.id]: 0,
        [carl.id]: 1,
        [bea.id]: 1,
      });
    });

    it("how a vote arrived (rc42): signed in, the emailed link, a copied link and who, or a shared link", async () => {
      const port = await makePort();
      const f = await poll(port, "arr");
      const mara = await f.as(f.mara.id);
      const [plan = ""] = (await listPlans(port, mara)).map((p) => p.id);
      const arrivals = async () =>
        Object.fromEntries(
          ((await listPlans(port, mara)).find((p) => p.id === plan)?.votes ?? []).map((v) => [
            v.personId,
            v.arrival,
          ]),
        );
      // The organizer's own yes, given by making the poll, was given signed in.
      expect(await arrivals()).toEqual({ [f.mara.id]: { via: "session", by: null } });

      // David votes with the link mailed to him; Ana with one Mara copied for her.
      const sent = await issued(port, mara);
      const davids = await resolveVoteLink(
        port,
        sent.links.find((l) => l.personId === f.david.id)?.token ?? "",
        LATER,
      );
      const copied = await issueVoteLinks(port, mara, { now: LATER, only: f.ana.id, copy: true });
      if (copied.kind !== "issued") throw new Error(copied.kind);
      const anas = await resolveVoteLink(port, copied.links[0]?.token ?? "", LATER);
      if (davids === null || anas === null) throw new Error("expected links");
      expect(davids.arrival).toEqual({ via: "mailed", by: null });
      expect(anas.arrival).toEqual({ via: "copied", by: f.mara.id });
      for (const link of [davids, anas])
        await castVote(port, link.access, {
          planId: plan,
          answer: "ifneedbe",
          now: LATER,
          arrival: link.arrival,
        });
      expect(await arrivals()).toEqual({
        [f.mara.id]: { via: "session", by: null },
        [f.david.id]: { via: "mailed", by: null },
        [f.ana.id]: { via: "copied", by: f.mara.id },
      });

      // A new vote replaces the label with its own: Ana signed in, David as a shared link's guest would.
      await castVote(port, await f.as(f.ana.id), {
        planId: plan,
        answer: "no",
        now: LATER,
        arrival: SIGNED_IN,
      });
      await castVote(port, davids.access, {
        planId: plan,
        answer: "no",
        now: LATER,
        arrival: SHARED_LINK,
      });
      expect(await arrivals()).toMatchObject({
        [f.ana.id]: { via: "session", by: null },
        [f.david.id]: { via: "shared", by: null },
      });

      // Mailing Ana a link after the hour makes hers a mailed one, naming nobody.
      const NOON = "2101-10-01T12:00:00.000Z"; // past the resend hour since the copy
      const again = await issueVoteLinks(port, mara, { now: NOON, only: f.ana.id });
      if (again.kind !== "issued") throw new Error(again.kind);
      expect((await resolveVoteLink(port, again.links[0]?.token ?? "", NOON))?.arrival).toEqual({
        via: "mailed",
        by: null,
      });

      // A link from before rc42 has no origin: a vote by it stores that nothing was recorded.
      await port.batch([
        {
          sql: "UPDATE plan_vote_token SET origin = NULL WHERE thread_id = ? AND person_id = ?",
          params: [f.threadId, f.ana.id],
        },
      ]);
      const old = await resolveVoteLink(port, again.links[0]?.token ?? "", NOON);
      if (old === null) throw new Error("expected link");
      expect(old.arrival).toBeNull();
      await castVote(port, old.access, { planId: plan, answer: "yes", now: NOON, arrival: null });
      expect((await arrivals())[f.ana.id]).toBeNull();
    });

    it("a time someone suggests, and a draft someone sends, carry their signed-in yes (rc42)", async () => {
      const port = await makePort();
      const f = await poll(port, "arr2");
      const david = await f.as(f.david.id);
      const [first] = await listPlans(port, david);
      const suggested = await suggestTime(port, david, {
        planId: first?.id ?? "",
        startLocal: "2101-11-28",
        endLocal: "2101-11-29",
        now: LATER,
      });
      if (suggested.kind !== "suggested") throw new Error(suggested.kind);
      await startDraft(port, david, { fromId: null, rest: false, replace: false, now: LATER });
      await addDraftEvent(port, david, {
        title: "Walk",
        allDay: true,
        startLocal: "2101-12-05",
        endLocal: "2101-12-06",
        who: [],
        now: LATER,
      });
      const sentDraft = await sendDraft(port, david, { now: LATER });
      if (sentDraft.kind !== "sent") throw new Error(sentDraft.kind);
      const plans = await listPlans(port, david);
      for (const id of [suggested.planId, sentDraft.planId])
        expect(plans.find((p) => p.id === id)?.votes).toMatchObject([
          { personId: f.david.id, answer: "yes", arrival: { via: "session", by: null } },
        ]);
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
