// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { consumeLoginLink, issueLoginToken } from "../../src/people/login.js";
import { findOrCreatePerson, setAccountHandle } from "../../src/people/person.js";
import { addVoteNote } from "../../src/plans/note.js";
import { acceptPlan, castVote, createPollThread, listPlans } from "../../src/plans/plan.js";
import {
  claimName,
  GUESTS_PER_DAY,
  issueShareLink,
  joinByShareLink,
  moveGuest,
  removeGuest,
  resolveClaim,
  resolveShareLink,
  type SharedQuestion,
  shareLinkExpiry,
  turnOffShareLink,
} from "../../src/plans/share.js";
import {
  decidesByConsensus,
  findThreadForMember,
  leaveThread,
  MAX_MEMBERS,
  ThreadInputError,
} from "../../src/plans/thread.js";
import { issueVoteLinks } from "../../src/plans/vote-link.js";
import { retentionPass } from "../../src/privacy/purge.js";

// Shared links (DESIGN §10 rc25, rc29) on BOTH drivers: the link and its replacement, the
// organizer deciding once a thread is shared, joining signed in, claiming a name, and every
// way a link stops working. Residue-tolerant: every test uses its own people.

const T0 = "2101-10-01T10:00:00.000Z";
const LATER = "2101-10-01T10:30:00.000Z";
const EXPIRED = "2101-10-31T10:00:00.001Z"; // 30 days on
const SWEPT = "2101-11-01T10:00:00.002Z"; // and a day more

async function poll(port: StoragePort, tag: string) {
  const [mara, david] = await Promise.all(
    ["mara", "david"].map((n) =>
      findOrCreatePerson(port, `share-${n}-${tag}@example.org`, { now: T0 }),
    ),
  );
  if (mara === undefined || david === undefined) throw new Error("people");
  const { threadId, planIds } = await createPollThread(port, {
    creatorId: mara.id,
    group: null,
    fields: { title: "Picnic", description: null, location: null, allDay: true, tzid: null },
    candidates: [
      { startLocal: "2101-11-21", endLocal: "2101-11-22" },
      { startLocal: "2101-11-14", endLocal: "2101-11-15" },
    ],
    people: [david.id],
    now: T0,
  });
  const as = async (personId: string) => {
    const a = await findThreadForMember(port, threadId, personId);
    if (a === null) throw new Error("expected membership");
    return a;
  };
  return { mara, david, threadId, planIds, as };
}

type Poll = Awaited<ReturnType<typeof poll>>;

async function shared(port: StoragePort, f: Poll, now = T0) {
  const r = await issueShareLink(port, await f.as(f.mara.id), { now });
  if (r.kind !== "issued") throw new Error(r.kind);
  const q = await resolveShareLink(port, r.token, now);
  if (q === null) throw new Error("expected the link to open");
  return { token: r.token, q };
}

async function claimed(port: StoragePort, q: SharedQuestion, name: string, now = LATER) {
  const r = await claimName(port, q, { name, now });
  if (r.kind !== "claimed") throw new Error(r.kind);
  return r;
}

export function runShareLinksContract(makePort: () => Promise<StoragePort>): void {
  describe("shared links (rc25, rc29)", () => {
    it("the organizer makes one; it opens the question with names, never addresses", async () => {
      const port = await makePort();
      const f = await poll(port, "a");
      expect(await issueShareLink(port, await f.as(f.david.id), { now: T0 })).toEqual({
        kind: "forbidden",
      });
      const { token, q } = await shared(port, f);
      expect(q.thread.id).toBe(f.threadId);
      expect(q.open).toBe(true);
      expect(q.names).toHaveLength(2);
      expect(q.names.join(" ")).not.toContain("@");
      expect(await shareLinkExpiry(port, await f.as(f.mara.id), LATER)).toBe(
        "2101-10-31T10:00:00.000Z",
      );
      expect(await resolveShareLink(port, "", T0)).toBeNull();
      expect(await resolveShareLink(port, "not-a-token", T0)).toBeNull();
      expect(await resolveShareLink(port, token, EXPIRED)).toBeNull();
      const rows = await port.query({
        sql: "SELECT token_hash FROM share_link WHERE thread_id = ?",
        params: [f.threadId],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).not.toBe(token);
    });

    it("re-issuing kills the old link, and turning it off kills the new one", async () => {
      const port = await makePort();
      const f = await poll(port, "b");
      const first = await shared(port, f);
      const second = await shared(port, f, LATER);
      expect(await resolveShareLink(port, first.token, LATER)).toBeNull();
      // Someone already in is in, whatever the link.
      expect((await joinByShareLink(port, first.q, f.mara.id, LATER)).kind).toBe("joined");
      const ana = await findOrCreatePerson(port, "share-ana-b@example.org", { now: T0 });
      expect(await joinByShareLink(port, first.q, ana.id, LATER)).toEqual({ kind: "gone" });
      expect(await turnOffShareLink(port, await f.as(f.david.id))).toEqual({ kind: "forbidden" });
      expect(await turnOffShareLink(port, await f.as(f.mara.id))).toEqual({ kind: "off" });
      expect(await resolveShareLink(port, second.token, LATER)).toBeNull();
      expect(await joinByShareLink(port, second.q, ana.id, LATER)).toEqual({ kind: "gone" });
      expect((await claimName(port, second.q, { name: "Kestrel", now: LATER })).kind).toBe("gone");
      expect(await shareLinkExpiry(port, await f.as(f.mara.id), LATER)).toBeNull();
    });

    it("once shared, the organizer decides even with two members, and it stays so", async () => {
      const port = await makePort();
      const f = await poll(port, "c");
      expect(decidesByConsensus(await f.as(f.mara.id))).toBe(true);
      await shared(port, f);
      await turnOffShareLink(port, await f.as(f.mara.id));
      const david = await f.as(f.david.id);
      expect(david.thread.sharedAt).toBe(T0);
      expect(decidesByConsensus(david)).toBe(false);
      // David's yes would have agreed the time with two members; now it is only a vote.
      const [plan] = f.planIds;
      expect(
        await castVote(port, david, { planId: plan ?? "", answer: "yes", now: LATER }),
      ).toEqual({ kind: "recorded" });
      expect((await acceptPlan(port, david, { planId: plan ?? "", now: LATER })).kind).toBe(
        "forbidden",
      );
      expect(
        (await acceptPlan(port, await f.as(f.mara.id), { planId: plan ?? "", now: LATER })).kind,
      ).toBe("accepted");
    });

    it("nothing on the table: no link, and a live one takes no one", async () => {
      const port = await makePort();
      const f = await poll(port, "d");
      const { token, q } = await shared(port, f);
      await acceptPlan(port, await f.as(f.mara.id), { planId: f.planIds[0] ?? "", now: LATER });
      expect((await resolveShareLink(port, token, LATER))?.open).toBe(false);
      const ana = await findOrCreatePerson(port, "share-ana-d@example.org", { now: T0 });
      expect(await joinByShareLink(port, q, ana.id, LATER)).toEqual({ kind: "gone" });
      expect((await claimName(port, q, { name: "Kestrel", now: LATER })).kind).toBe("gone");
      expect(await issueShareLink(port, await f.as(f.mara.id), { now: LATER })).toEqual({
        kind: "closed",
      });
    });

    it("a page opened before the link expired can't join after it", async () => {
      const port = await makePort();
      const f = await poll(port, "m");
      const { q } = await shared(port, f);
      const ana = await findOrCreatePerson(port, "share-ana-m@example.org", { now: T0 });
      expect(await joinByShareLink(port, q, ana.id, EXPIRED)).toEqual({ kind: "gone" });
      expect((await claimName(port, q, { name: "Kestrel", now: EXPIRED })).kind).toBe("gone");
    });

    it("signed in, opening the link joins the thread once", async () => {
      const port = await makePort();
      const f = await poll(port, "e");
      const { q } = await shared(port, f);
      const ana = await findOrCreatePerson(port, "share-ana-e@example.org", { now: T0 });
      const joined = await joinByShareLink(port, q, ana.id, LATER);
      if (joined.kind !== "joined") throw new Error(joined.kind);
      // Joined last, so listed last (mara and david joined together, in id order).
      expect(joined.access.members.map((m) => m.personId).at(-1)).toBe(ana.id);
      expect(joined.access.members).toHaveLength(3);
      const again = await joinByShareLink(port, q, ana.id, LATER);
      expect(again.kind === "joined" && again.access.members).toHaveLength(3);
      expect(await listPlans(port, joined.access)).toHaveLength(2);
    });

    it("a thread at the member cap takes no one more", async () => {
      const port = await makePort();
      const f = await poll(port, "f");
      const { q } = await shared(port, f);
      for (let i = 2; i < MAX_MEMBERS; i++) await claimed(port, q, `Guest name ${i}`);
      const late = await findOrCreatePerson(port, "share-late-f@example.org", { now: T0 });
      expect(await joinByShareLink(port, q, late.id, LATER)).toEqual({ kind: "full" });
      expect((await claimName(port, q, { name: "One more", now: LATER })).kind).toBe("full");
    });

    it("claiming a name makes a guest with that handle and an address that can't be mailed", async () => {
      const port = await makePort();
      const f = await poll(port, "g");
      const { q } = await shared(port, f);
      const r = await claimed(port, q, "  Kestrel   the  Bold ");
      const me = r.access.members.find((m) => m.personId === r.access.personId);
      expect(me?.shown).toEqual({ name: "Kestrel the Bold", email: null });
      const [row] = await port.query({
        sql: "SELECT email, guest_at FROM person WHERE id = ?",
        params: [r.access.personId],
      });
      expect(row).toEqual({ email: `${r.access.personId}@guest.invalid`, guest_at: LATER });
      // Only the hash of the claim is kept, and it opens this thread, no other.
      const claims = await port.query({
        sql: "SELECT token_hash FROM guest_claim WHERE person_id = ?",
        params: [r.access.personId],
      });
      expect(claims).toHaveLength(1);
      expect(claims[0]?.token_hash).not.toBe(r.token);
      expect((await resolveClaim(port, r.token, f.threadId))?.personId).toBe(r.access.personId);
      expect(await resolveClaim(port, r.token, "another-thread")).toBeNull();
      expect(await resolveClaim(port, "", f.threadId)).toBeNull();
      // A guest votes like anyone; the organizer still decides.
      expect(
        await castVote(port, r.access, { planId: f.planIds[0] ?? "", answer: "yes", now: LATER }),
      ).toEqual({ kind: "recorded" });
      // And gets no vote link: there is no address to send it to.
      const links = await issueVoteLinks(port, await f.as(f.mara.id), { now: LATER });
      expect(links.kind === "issued" && links.links.map((l) => l.personId)).toEqual([f.david.id]);
    });

    it("a name already in the thread can't be claimed again, however it is written", async () => {
      const port = await makePort();
      const f = await poll(port, "h");
      await setAccountHandle(port, f.david.id, "David");
      const { q } = await shared(port, f);
      await claimed(port, q, "Kestrel");
      for (const name of ["kestrel", " KESTREL ", "david", "  DAVID  "]) {
        expect((await claimName(port, q, { name, now: LATER })).kind).toBe("taken");
      }
      // Spaces separate words, so a name without them is another name.
      await claimed(port, q, "Kestrel Bold");
      expect((await claimName(port, q, { name: "KestrelBold", now: LATER })).kind).toBe("claimed");
      await expect(claimName(port, q, { name: "   ", now: LATER })).rejects.toThrow(
        ThreadInputError,
      );
      await expect(claimName(port, q, { name: "x".repeat(41), now: LATER })).rejects.toThrow(
        ThreadInputError,
      );
    });

    it("two guests racing for one name: only one has it", async () => {
      const port = await makePort();
      const f = await poll(port, "i");
      const { q } = await shared(port, f);
      // Both read the names before either writes, as two phones at once would.
      const results = await Promise.all([
        claimName(port, q, { name: "Mara Two", now: LATER }),
        claimName(port, q, { name: "mara two", now: LATER }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["claimed", "taken"]);
      const guests = await port.query({
        sql: "SELECT count(*) AS n FROM plan_thread_member WHERE thread_id = ?",
        params: [f.threadId],
      });
      expect(Number(guests[0]?.n)).toBe(3);
    });

    it(`at most ${GUESTS_PER_DAY} guests a day`, async () => {
      const port = await makePort();
      const f = await poll(port, "j");
      const { q } = await shared(port, f);
      const now = "2101-10-01T11:00:00.000Z";
      await port.batch(
        Array.from({ length: GUESTS_PER_DAY }, (_, i) => ({
          sql: "INSERT INTO guest_claim (token_hash, person_id, thread_id, created_at) VALUES (?, ?, ?, ?)",
          params: [`hash-${i}`, f.david.id, f.threadId, LATER],
        })),
      );
      expect((await claimName(port, q, { name: "Kestrel", now })).kind).toBe("busy");
      const tomorrow = "2101-10-02T10:30:00.001Z";
      expect((await claimName(port, q, { name: "Kestrel", now: tomorrow })).kind).toBe("claimed");
    });

    it("leaving takes a guest's claim and the organizer's link with it", async () => {
      const port = await makePort();
      const f = await poll(port, "k");
      const { token, q } = await shared(port, f);
      const r = await claimed(port, q, "Kestrel");
      await leaveThread(port, r.access, LATER);
      expect(await resolveClaim(port, r.token, f.threadId)).toBeNull();
      const claims = await port.query({
        sql: "SELECT 1 AS ok FROM guest_claim WHERE thread_id = ?",
        params: [f.threadId],
      });
      expect(claims).toHaveLength(0);
      expect(await resolveShareLink(port, token, LATER)).not.toBeNull();
      await leaveThread(port, await f.as(f.mara.id), LATER);
      expect(await resolveShareLink(port, token, LATER)).toBeNull();
    });

    it("an expired link is swept a day after it expires", async () => {
      const port = await makePort();
      const f = await poll(port, "l");
      await shared(port, f);
      const count = async () =>
        (
          await port.query({
            sql: "SELECT 1 AS ok FROM share_link WHERE thread_id = ?",
            params: [f.threadId],
          })
        ).length;
      await retentionPass(port, EXPIRED);
      expect(await count()).toBe(1);
      await retentionPass(port, SWEPT);
      expect(await count()).toBe(0);
    });
  });

  describe("moving a guest's answers (rc30)", () => {
    const voteOf = async (port: StoragePort, planId: string, personId: string) =>
      (
        await port.query({
          sql: "SELECT answer FROM plan_vote WHERE plan_id = ? AND person_id = ?",
          params: [planId, personId],
        })
      )[0]?.answer;
    const exists = async (port: StoragePort, personId: string) =>
      (await port.query({ sql: "SELECT 1 AS ok FROM person WHERE id = ?", params: [personId] }))
        .length > 0;

    it("an account not in the thread takes the guest's place, name and answers", async () => {
      const port = await makePort();
      const f = await poll(port, "n");
      const { q } = await shared(port, f);
      const r = await claimed(port, q, "Kestrel");
      const [p0 = ""] = f.planIds;
      await castVote(port, r.access, { planId: p0, answer: "yes", now: LATER });
      await addVoteNote(port, r.access, { body: "Bringing a kite", now: LATER });
      const ana = await findOrCreatePerson(port, "share-ana-n@example.org", { now: T0 });
      const guest = r.access.personId;

      expect(await moveGuest(port, { guestId: guest, personId: ana.id })).toEqual({
        kind: "moved",
        threadIds: [f.threadId],
      });
      const access = await f.as(ana.id);
      expect(access.members).toHaveLength(3);
      const me = access.members.find((m) => m.personId === ana.id);
      expect(me?.shown.name).toBe("Kestrel");
      expect(await voteOf(port, p0, ana.id)).toBe("yes");
      const notes = await port.query({
        sql: "SELECT body FROM plan_note WHERE thread_id = ? AND author_id = ?",
        params: [f.threadId, ana.id],
      });
      expect(notes.map((n) => n.body)).toEqual(["Bringing a kite"]);
      expect(await exists(port, guest)).toBe(false);
      expect(await resolveClaim(port, r.token, f.threadId)).toBeNull();
      // At most once.
      expect(await moveGuest(port, { guestId: guest, personId: ana.id })).toEqual({ kind: "gone" });
    });

    it("where both answered, the later answer is kept; a member keeps its own name (rc32)", async () => {
      const port = await makePort();
      const f = await poll(port, "o");
      const { q } = await shared(port, f);
      const [p0 = "", p1 = ""] = f.planIds;
      const david = await f.as(f.david.id);
      const r = await claimed(port, q, "Kestrel");
      // p0: David first, the guest later. p1: the guest first, David later.
      await castVote(port, david, { planId: p0, answer: "no", now: T0 });
      await castVote(port, r.access, { planId: p0, answer: "yes", now: LATER });
      await castVote(port, r.access, { planId: p1, answer: "no", now: T0 });
      await castVote(port, david, { planId: p1, answer: "yes", now: LATER });

      expect(
        (await moveGuest(port, { guestId: r.access.personId, personId: f.david.id })).kind,
      ).toBe("moved");
      expect(await voteOf(port, p0, f.david.id)).toBe("yes");
      expect(await voteOf(port, p1, f.david.id)).toBe("yes");
      expect(await exists(port, r.access.personId)).toBe(false);
      const after = await f.as(f.david.id);
      expect(after.members).toHaveLength(2);
      expect(after.members.find((m) => m.personId === f.david.id)?.shown.name).not.toBe("Kestrel");
      // The guest's name is free again.
      expect((await claimName(port, q, { name: "Kestrel", now: LATER })).kind).toBe("claimed");
    });

    it("a tie goes to the guest, and answers only one of them gave are all kept (rc32)", async () => {
      const port = await makePort();
      const f = await poll(port, "o2");
      const { q } = await shared(port, f);
      const [p0 = "", p1 = ""] = f.planIds;
      const david = await f.as(f.david.id);
      const r = await claimed(port, q, "Kestrel");
      await castVote(port, david, { planId: p0, answer: "no", now: T0 });
      await castVote(port, r.access, { planId: p0, answer: "ifneedbe", now: T0 });
      await castVote(port, r.access, { planId: p1, answer: "no", now: T0 });

      await moveGuest(port, { guestId: r.access.personId, personId: f.david.id });
      expect(await voteOf(port, p0, f.david.id)).toBe("ifneedbe");
      expect(await voteOf(port, p1, f.david.id)).toBe("no");
      // And the other way round: only David answered p1 here.
      const g = await poll(port, "o3");
      const s = await shared(port, g);
      const [g0 = "", g1 = ""] = g.planIds;
      const k = await claimed(port, s.q, "Wren");
      await castVote(port, await g.as(g.david.id), { planId: g1, answer: "yes", now: T0 });
      await castVote(port, k.access, { planId: g0, answer: "no", now: LATER });
      await moveGuest(port, { guestId: k.access.personId, personId: g.david.id });
      expect(await voteOf(port, g0, g.david.id)).toBe("no");
      expect(await voteOf(port, g1, g.david.id)).toBe("yes");
    });

    it("only a guest moves, and only to an account", async () => {
      const port = await makePort();
      const f = await poll(port, "p");
      const { q } = await shared(port, f);
      const r = await claimed(port, q, "Kestrel");
      const other = await claimed(port, q, "Wren");
      const guest = r.access.personId;
      const gone = { kind: "gone" };
      expect(await moveGuest(port, { guestId: f.david.id, personId: f.mara.id })).toEqual(gone);
      expect(await moveGuest(port, { guestId: guest, personId: other.access.personId })).toEqual(
        gone,
      );
      expect(await moveGuest(port, { guestId: guest, personId: guest })).toEqual(gone);
      expect(await moveGuest(port, { guestId: guest, personId: "nobody" })).toEqual(gone);
      const erased = await findOrCreatePerson(port, "share-gone-p@example.org", { now: T0 });
      await port.query({
        sql: "UPDATE person SET erased_at = ? WHERE id = ?",
        params: [T0, erased.id],
      });
      expect(await moveGuest(port, { guestId: guest, personId: erased.id })).toEqual(gone);
      expect((await f.as(f.david.id)).members).toHaveLength(4);
      expect(await exists(port, guest)).toBe(true);
    });

    it("a guest that became the organizer passes it on", async () => {
      const port = await makePort();
      const mara = await findOrCreatePerson(port, "share-mara-q@example.org", { now: T0 });
      const { threadId } = await createPollThread(port, {
        creatorId: mara.id,
        group: null,
        fields: { title: "Picnic", description: null, location: null, allDay: true, tzid: null },
        candidates: [
          { startLocal: "2101-11-21", endLocal: "2101-11-22" },
          { startLocal: "2101-11-14", endLocal: "2101-11-15" },
        ],
        people: [],
        now: T0,
      });
      const own = await findThreadForMember(port, threadId, mara.id);
      if (own === null) throw new Error("expected membership");
      const issued = await issueShareLink(port, own, { now: T0 });
      if (issued.kind !== "issued") throw new Error(issued.kind);
      const q = await resolveShareLink(port, issued.token, T0);
      if (q === null) throw new Error("expected the link to open");
      const r = await claimed(port, q, "Kestrel");
      await leaveThread(port, own, LATER);
      const ana = await findOrCreatePerson(port, "share-ana-q@example.org", { now: T0 });
      await moveGuest(port, { guestId: r.access.personId, personId: ana.id });
      expect((await findThreadForMember(port, threadId, ana.id))?.thread.organizerId).toBe(ana.id);
    });

    it("a guest in the agreed event passes it on, and a member keeps its own", async () => {
      const port = await makePort();
      const f = await poll(port, "r");
      const { q } = await shared(port, f);
      const kestrel = await claimed(port, q, "Kestrel");
      const wren = await claimed(port, q, "Wren");
      await acceptPlan(port, await f.as(f.mara.id), { planId: f.planIds[0] ?? "", now: LATER });
      const ana = await findOrCreatePerson(port, "share-ana-r@example.org", { now: T0 });
      await moveGuest(port, { guestId: kestrel.access.personId, personId: ana.id });
      await moveGuest(port, { guestId: wren.access.personId, personId: f.david.id });
      const rows = async (personId: string) =>
        (
          await port.query({
            sql: "SELECT canonical_event_id FROM event_participation WHERE person_id = ?",
            params: [personId],
          })
        ).length;
      expect(await rows(ana.id)).toBe(1);
      expect(await rows(f.david.id)).toBe(1);
      expect(await exists(port, wren.access.personId)).toBe(false);
    });

    it("a sign-in link can carry a guest, and loses it when the guest goes", async () => {
      const port = await makePort();
      const f = await poll(port, "s");
      const { q } = await shared(port, f);
      const r = await claimed(port, q, "Kestrel");
      const guestId = r.access.personId;
      const carrying = await issueLoginToken(port, "share-ana-s@example.org", { now: T0, guestId });
      const plain = await issueLoginToken(port, "share-bo-s@example.org", { now: T0 });
      const stale = await issueLoginToken(port, "share-cy-s@example.org", { now: T0, guestId });
      if (!carrying.ok || !plain.ok || !stale.ok) throw new Error("rate limited");
      expect(await consumeLoginLink(port, carrying.token, { now: T0 })).toEqual({
        email: "share-ana-s@example.org",
        guestId,
      });
      expect(await consumeLoginLink(port, plain.token, { now: T0 })).toEqual({
        email: "share-bo-s@example.org",
        guestId: null,
      });
      await leaveThread(port, r.access, LATER);
      await port.query({ sql: "DELETE FROM person WHERE id = ?", params: [guestId] });
      expect(await consumeLoginLink(port, stale.token, { now: T0 })).toEqual({
        email: "share-cy-s@example.org",
        guestId: null,
      });
    });
  });

  describe("removing a guest (rc30)", () => {
    const exists = async (port: StoragePort, personId: string) =>
      (await port.query({ sql: "SELECT 1 AS ok FROM person WHERE id = ?", params: [personId] }))
        .length > 0;

    it("the organizer removes a guest; its answers go, and the name is free again", async () => {
      const port = await makePort();
      const f = await poll(port, "t");
      const { q } = await shared(port, f);
      const r = await claimed(port, q, "Kestrel");
      const [p0 = ""] = f.planIds;
      await castVote(port, r.access, { planId: p0, answer: "yes", now: LATER });
      await addVoteNote(port, r.access, { body: "Bringing a kite", now: LATER });
      const own = await f.as(f.mara.id);
      expect(own.members.map((m) => m.guest)).toEqual([false, false, true]);

      expect(await removeGuest(port, own, r.access.personId)).toEqual({
        kind: "removed",
        name: "Kestrel",
      });
      expect(await exists(port, r.access.personId)).toBe(false);
      expect(await resolveClaim(port, r.token, f.threadId)).toBeNull();
      const left = await port.query({
        sql: `SELECT (SELECT count(*) FROM plan_vote WHERE person_id = ?) AS votes,
                     (SELECT count(*) FROM plan_note WHERE author_id = ?) AS notes`,
        params: [r.access.personId, r.access.personId],
      });
      expect(left[0]).toEqual({ votes: 0, notes: 0 });
      expect((await f.as(f.mara.id)).members).toHaveLength(2);
      expect(await removeGuest(port, own, r.access.personId)).toEqual({ kind: "gone" });
      expect((await claimName(port, q, { name: "Kestrel", now: LATER })).kind).toBe("claimed");
    });

    it("removes the guest it names, and only one the organizer's page knew of", async () => {
      const port = await makePort();
      const f = await poll(port, "w");
      const { q } = await shared(port, f);
      const seen = await f.as(f.mara.id);
      // Wren joined after the organizer's page was drawn: not removed from that page.
      const wren = (await claimed(port, q, "Wren")).access.personId;
      expect(await removeGuest(port, seen, wren)).toEqual({ kind: "gone" });
      expect(await exists(port, wren)).toBe(true);
      const kestrel = (await claimed(port, q, "Kestrel")).access.personId;
      expect(await removeGuest(port, await f.as(f.mara.id), kestrel)).toEqual({
        kind: "removed",
        name: "Kestrel",
      });
      expect(await exists(port, wren)).toBe(true);
    });

    it("only the organizer, only a guest, only of this thread", async () => {
      const port = await makePort();
      const f = await poll(port, "u");
      const { q } = await shared(port, f);
      const k = (await claimed(port, q, "Kestrel")).access.personId;
      const other = await poll(port, "u2");
      const elsewhere = (await claimed(port, (await shared(port, other)).q, "Wren")).access
        .personId;
      const own = await f.as(f.mara.id);
      expect(await removeGuest(port, await f.as(f.david.id), k)).toEqual({ kind: "forbidden" });
      expect(await removeGuest(port, own, f.david.id)).toEqual({ kind: "gone" });
      expect(await removeGuest(port, own, elsewhere)).toEqual({ kind: "gone" });
      // The statement checks again, whatever the page that asked believed.
      const believed = (personId: string) => ({
        ...own,
        members: [...own.members, { personId, shown: { name: "x", email: null }, guest: true }],
      });
      const asGuests = { ...own, members: own.members.map((m) => ({ ...m, guest: true })) };
      expect(await removeGuest(port, asGuests, f.david.id)).toEqual({ kind: "gone" });
      expect(await removeGuest(port, believed(elsewhere), elsewhere)).toEqual({ kind: "gone" });
      expect(await exists(port, f.david.id)).toBe(true);
      expect(await exists(port, elsewhere)).toBe(true);
      // Organizer no more: Mara left, and David organizes it now.
      await leaveThread(port, own, LATER);
      expect(await removeGuest(port, own, k)).toEqual({ kind: "gone" });
      expect(await exists(port, k)).toBe(true);
    });

    it("a guest that organizes a thread isn't deleted with it", async () => {
      const port = await makePort();
      const solo = await findOrCreatePerson(port, "share-solo-v@example.org", { now: T0 });
      const { threadId } = await createPollThread(port, {
        creatorId: solo.id,
        group: null,
        fields: { title: "Kites", description: null, location: null, allDay: true, tzid: null },
        candidates: [
          { startLocal: "2101-11-21", endLocal: "2101-11-22" },
          { startLocal: "2101-11-14", endLocal: "2101-11-15" },
        ],
        people: [],
        now: T0,
      });
      const soloAccess = await findThreadForMember(port, threadId, solo.id);
      if (soloAccess === null) throw new Error("expected membership");
      const issued = await issueShareLink(port, soloAccess, { now: T0 });
      if (issued.kind !== "issued") throw new Error(issued.kind);
      const kites = await resolveShareLink(port, issued.token, T0);
      if (kites === null) throw new Error("expected the link to open");
      const k = (await claimed(port, kites, "Kestrel")).access.personId;
      await leaveThread(port, soloAccess, LATER);
      // Kestrel organizes Kites now, and is in Mara's thread too.
      const f = await poll(port, "v");
      const { q } = await shared(port, f);
      expect((await joinByShareLink(port, q, k, LATER)).kind).toBe("joined");
      expect(await removeGuest(port, await f.as(f.mara.id), k)).toEqual({ kind: "gone" });
      expect((await findThreadForMember(port, threadId, k))?.thread.organizerId).toBe(k);
    });
  });
}
