// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  createEvent,
  type EventAccess,
  type EventFieldsInput,
  findEventForParticipant,
  listHistory,
} from "../../src/events/event.js";
import { addParticipant, listParticipants } from "../../src/events/participation.js";
import { createPoll, vote } from "../../src/events/poll.js";
import { proposeChange } from "../../src/events/proposal.js";
import { addFeedback, issueResponseLinks } from "../../src/events/response.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { issueLoginToken } from "../../src/people/login.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { createSession, resolveAccounts } from "../../src/people/session.js";
import { addDraftEvent, castVote, sendDraft, startDraft } from "../../src/plans/plan.js";
import { createThread, findThreadForMember } from "../../src/plans/thread.js";
import {
  DELETION_WAIT_MS,
  deleteNow,
  eraseAccount,
  eraseDue,
  erasePreview,
  FORMER_MEMBER,
  keepAccount,
  peekDeletion,
  pendingDeletion,
  reapplyErasures,
  requestDeletion,
} from "../../src/privacy/erasure.js";

// Deleting an account (DESIGN §10 rc21, WORKFLOWS US-20) on BOTH drivers. The test that
// matters scans EVERY table afterwards: not one row anywhere may still hold the person's
// id or address — except the erasure ledger's own entry, which is the id alone.

const T0 = "2101-11-01T10:00:00.000Z";
const T1 = "2101-11-02T10:00:00.000Z";

const DINNER: EventFieldsInput = {
  title: "Rope jam",
  description: null,
  location: "The studio",
  allDay: false,
  startLocal: "2101-11-20T18:00",
  endLocal: "2101-11-20T21:00",
  tzid: "Europe/Prague",
};

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("expected access");
  return a;
}

/** Every row of every table, as text, but the ledger: where else might they be? */
async function everywhere(port: StoragePort): Promise<string> {
  const tables = (
    await port.query({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'erasure_ledger'",
      params: [],
    })
  ).map((r) => String(r.name));
  expect(tables).toContain("person");
  const all: unknown[] = [];
  // Table names come from sqlite_master itself, in a test.
  for (const t of tables)
    all.push(t, await port.query({ sql: `SELECT * FROM "${t}"`, params: [] }));
  return JSON.stringify(all);
}

/** Tom, busy everywhere: what deleting his account must clean up. */
async function busyTom(port: StoragePort, tag: string) {
  const person = (who: string) =>
    findOrCreatePerson(port, `er-${who}-${tag}@example.org`, { now: T0 });
  const tom = await person("tom");
  const mara = await person("mara");
  const lena = await person("lena");
  const adam = await person("adam");

  // Mara's jam: Tom proposes a change and leaves a note; she asks him to agree to another.
  const jam = await createEvent(port, {
    creatorId: mara.id,
    group: null,
    fields: DINNER,
    now: T0,
    people: [{ personId: tom.id, editTier: "propose", visibility: "FULL" }],
  });
  await addFeedback(port, await access(port, jam.id, tom.id), { body: "bringing rope", now: T0 });
  await proposeChange(port, await access(port, jam.id, tom.id), {
    fields: { ...DINNER, location: "Tom's place" },
    now: T0,
  });
  await issueResponseLinks(port, await access(port, jam.id, mara.id), { now: T0 });
  const asked = await createEvent(port, {
    creatorId: mara.id,
    group: null,
    fields: { ...DINNER, title: "Workshop" },
    now: T0,
    people: [{ personId: tom.id, editTier: "view", visibility: "FULL" }],
    requests: new Map([[tom.id, "accept" as const]]),
  });
  // Tom's own event with Mara as a second editor (it stays, by "a former member") and
  // one only he edits (it goes, for Lena too).
  const shared = await createEvent(port, {
    creatorId: tom.id,
    group: null,
    fields: { ...DINNER, title: "Shared" },
    now: T0,
    people: [{ personId: mara.id, editTier: "edit", visibility: "FULL" }],
  });
  const alone = await createEvent(port, {
    creatorId: tom.id,
    group: null,
    fields: { ...DINNER, title: "Alone" },
    now: T0,
  });
  await addParticipant(port, await access(port, alone.id, tom.id), {
    email: lena.email,
    editTier: "view",
    visibility: "FULL",
    now: T0,
  });
  // A poll Tom voted in.
  const poll = await createPoll(port, {
    creatorId: mara.id,
    group: null,
    fields: {
      title: "When?",
      description: null,
      location: null,
      allDay: false,
      tzid: "Europe/Prague",
    },
    candidates: [
      { startLocal: "2101-11-21T18:00", endLocal: "2101-11-21T20:00" },
      { startLocal: "2101-11-22T18:00", endLocal: "2101-11-22T20:00" },
    ],
    people: [{ personId: tom.id, editTier: "view", visibility: "FULL" }],
    now: T0,
  });
  await vote(port, await access(port, poll.id, tom.id), {
    answers: new Map([[0, "yes"]]),
    now: T0,
  });

  // A group Tom organizes with Lena in it, and a pending invite he sent.
  const group = await createGroup(port, { name: "Jam crew", creatorId: tom.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, tom.id);
  if (membership === null) throw new Error("membership");
  const invite = await createInvite(port, membership, {
    email: lena.email,
    invitedBy: tom.id,
    editTier: "view",
    visibility: "FULL",
    now: T0,
  });
  if (!invite.ok) throw new Error(invite.reason);
  await acceptInvite(port, invite.token, T0);
  await createInvite(port, membership, {
    email: `er-later-${tag}@example.org`,
    invitedBy: tom.id,
    editTier: "view",
    visibility: "FULL",
    now: T0,
  });

  // A plan thread Tom organizes with Adam: a plan of Tom's for Tom, Adam's vote on it,
  // Tom's vote on Adam's, and a draft.
  const thread = await createThread(port, {
    name: "Season",
    tzid: "Europe/Prague",
    creatorId: tom.id,
    memberIds: [adam.id],
    now: T0,
  });
  const gate = async (id: string) => {
    const a = await findThreadForMember(port, thread.id, id);
    if (a === null) throw new Error("member");
    return a;
  };
  const week = (title: string, who: string[]) => ({
    title,
    allDay: true,
    startLocal: "2101-11-07",
    endLocal: "2101-11-14",
    who,
    now: T0,
  });
  for (const [author, voter, title] of [
    [tom.id, adam.id, "Tom's"],
    [adam.id, tom.id, "Adam's"],
  ] as const) {
    await startDraft(port, await gate(author), {
      fromId: null,
      rest: false,
      replace: false,
      now: T0,
    });
    await addDraftEvent(port, await gate(author), week(title, [tom.id]));
    const sent = await sendDraft(port, await gate(author), { now: T0 });
    if (sent.kind !== "sent") throw new Error(sent.kind);
    await castVote(port, await gate(voter), { planId: sent.planId, answer: "ifneedbe", now: T0 });
  }
  await startDraft(port, await gate(tom.id), {
    fromId: null,
    rest: false,
    replace: false,
    now: T0,
  });

  // Mara invited Tom's address to her own group; he hasn't answered.
  const maras = await createGroup(port, { name: "Mara's", creatorId: mara.id, now: T0 });
  const maraMember = await findGroupForMember(port, maras.id, mara.id);
  if (maraMember === null) throw new Error("membership");
  await createInvite(port, maraMember, {
    email: tom.email,
    invitedBy: mara.id,
    editTier: "view",
    visibility: "FULL",
    now: T0,
  });

  await createSession(port, tom.id, { now: T0 });
  await issueLoginToken(port, tom.email, { now: T0 });
  return { tom, mara, lena, adam, jam, asked, shared, alone, poll, group, thread };
}

export function runErasureContract(makePort: () => Promise<StoragePort>): void {
  describe("deleting an account (DESIGN §10 rc21)", () => {
    it("leaves nothing of the person anywhere, and 'a former member' in others' history", async () => {
      const port = await makePort();
      const f = await busyTom(port, "all");
      expect(await everywhere(port)).toContain(f.tom.id);

      expect(await erasePreview(port, f.tom.id)).toEqual({
        eventsDeleted: 1, // "Alone"
        peopleAffected: 1, // Lena
        groupsDeleted: 0, // Lena stays
        threadsDeleted: 0, // Adam stays
      });
      const gone = await eraseAccount(port, f.tom.id, { now: T1 });
      expect(gone.events).toEqual([f.alone.id]);

      const after = await everywhere(port);
      expect(after).not.toContain(f.tom.id);
      expect(after).not.toContain(f.tom.email);
      // Only the ledger knows, and only the id.
      const ledger = await port.query({
        sql: "SELECT kind FROM erasure_ledger WHERE id = ?",
        params: [f.tom.id],
      });
      expect(ledger.map((r) => r.kind)).toEqual(["person"]);

      // Others keep their things; Tom's part in them is a former member, a different one
      // in each.
      const shared = await access(port, f.shared.id, f.mara.id);
      const [created] = (await listHistory(port, shared)).slice(-1);
      expect(created?.actor?.name).toBe(FORMER_MEMBER);
      const jam = await access(port, f.jam.id, f.mara.id);
      const proposal = await port.query({
        sql: "SELECT proposed_by, status FROM event_change_proposal WHERE canonical_event_id = ?",
        params: [f.jam.id],
      });
      expect(proposal.map((r) => r.status)).toEqual(["withdrawn"]);
      expect(proposal[0]?.proposed_by).not.toBe(created?.actorId);
      // He's no longer on it; Mara is.
      expect((await listParticipants(port, jam.event.id)).map((p) => p.personId)).toEqual([
        f.mara.id,
      ]);

      // The workshop waited for Tom's agreement: it can't happen now, and says who declined.
      const asked = await access(port, f.asked.id, f.mara.id);
      expect(asked.event.status).toBe("declined");
      expect((await listHistory(port, asked))[0]?.actor?.name).toBe(FORMER_MEMBER);

      // The group and the thread go on, organized by the ones left.
      expect((await findGroupForMember(port, f.group.id, f.lena.id))?.role).toBe("organizer");
      const season = await findThreadForMember(port, f.thread.id, f.adam.id);
      expect(season?.thread.organizerId).toBe(f.adam.id);
      expect(season?.members.map((m) => m.personId)).toEqual([f.adam.id]);

      // The address is free again: signing up with it is a new person, with nothing.
      const again = await findOrCreatePerson(port, f.tom.email, { now: T1 });
      expect(again.id).not.toBe(f.tom.id);
      expect(await findEventForParticipant(port, f.shared.id, again.id)).toBeNull();
    });

    it("a restore from backup is undone: the person is erased again", async () => {
      const port = await makePort();
      const f = await busyTom(port, "restore");
      await eraseAccount(port, f.tom.id, { now: T1 });
      // The backup brings Tom's person row back.
      await port.batch([
        {
          sql: "INSERT INTO person (id, email, created_at) VALUES (?, ?, ?)",
          params: [f.tom.id, f.tom.email, T0],
        },
      ]);
      expect(await reapplyErasures(port, T1)).toBeGreaterThanOrEqual(1);
      expect(await everywhere(port)).not.toContain(f.tom.email);
    });

    it("asking signs out everywhere and waits 7 days; the pass erases it on the day (rc22)", async () => {
      const port = await makePort();
      const f = await busyTom(port, "wait");
      const first = await createSession(port, f.tom.id, { now: T0 });
      const asked = await requestDeletion(port, f.tom.id, T0);
      expect(Date.parse(asked.eraseAfter) - Date.parse(T0)).toBe(DELETION_WAIT_MS);
      // Every session is gone, the asking one included.
      expect(await resolveAccounts(port, [first.token], { now: T0 })).toEqual([]);
      // Asking again (signed in during the wait) keeps the day and replaces the link.
      const again = await requestDeletion(port, f.tom.id, T1);
      expect(again.eraseAfter).toBe(asked.eraseAfter);
      expect(await peekDeletion(port, asked.token)).toBeNull();
      expect((await peekDeletion(port, again.token))?.email).toBe(f.tom.email);

      // Signed in during the wait, the session knows the day.
      const during = await createSession(port, f.tom.id, { now: T1 });
      const [account] = await resolveAccounts(port, [during.token], { now: T1 });
      expect(account?.deletesAt).toBe(asked.eraseAfter);

      // Not yet: the pass does nothing.
      const justBefore = new Date(Date.parse(asked.eraseAfter) - 1).toISOString();
      expect(await eraseDue(port, { now: justBefore })).toBe(0);
      expect(await everywhere(port)).toContain(f.tom.email);
      // On the day, exactly what deleting at once did.
      expect(await eraseDue(port, { now: asked.eraseAfter })).toBe(1);
      const after = await everywhere(port);
      expect(after).not.toContain(f.tom.id);
      expect(after).not.toContain(f.tom.email);
      expect(await eraseDue(port, { now: asked.eraseAfter })).toBe(0);
    });

    it("the emailed link keeps the account, or deletes it now, once (rc22)", async () => {
      const port = await makePort();
      const f = await busyTom(port, "link");
      const revoked: string[] = [];
      const revokeCalendars = (cs: readonly { id: string }[]) => {
        for (const c of cs) revoked.push(c.id);
        return Promise.resolve();
      };

      const kept = await requestDeletion(port, f.tom.id, T0);
      expect(await keepAccount(port, kept.token)).toBe(true);
      expect(await keepAccount(port, kept.token)).toBe(false); // single-use
      expect(await pendingDeletion(port, f.tom.id)).toBeNull();
      expect(await deleteNow(port, kept.token, { now: T1, revokeCalendars })).toBe(false);
      expect(await eraseDue(port, { now: "2999-01-01T00:00:00.000Z" })).toBe(0);
      expect(await everywhere(port)).toContain(f.tom.email);

      const now = await requestDeletion(port, f.tom.id, T0);
      expect(await deleteNow(port, now.token, { now: T1, revokeCalendars })).toBe(true);
      expect(await everywhere(port)).not.toContain(f.tom.id);
      // Clicked twice: the link is gone with the account.
      expect(await deleteNow(port, now.token, { now: T1, revokeCalendars })).toBe(false);
    });

    it("the pass writes nothing when nothing is due (§16), and erases a bounded number per run", async () => {
      const port = await makePort();
      let writes = 0;
      const counting: StoragePort = {
        query: (s) => {
          if (!/^\s*SELECT/i.test(s.sql)) writes += 1;
          return port.query(s);
        },
        batch: (stmts) => {
          writes += stmts.length;
          return port.batch(stmts);
        },
      };
      const f = await busyTom(port, "pass");
      expect(await eraseDue(counting, { now: T1 })).toBe(0);
      const asked = await requestDeletion(port, f.tom.id, T0);
      const other = await requestDeletion(port, f.adam.id, T0);
      expect(other.eraseAfter).toBe(asked.eraseAfter);
      writes = 0;
      expect(await eraseDue(counting, { now: T0 })).toBe(0);
      expect(writes).toBe(0);
      // Two due, one per run.
      expect(await eraseDue(port, { now: asked.eraseAfter })).toBe(1);
      expect(await eraseDue(port, { now: asked.eraseAfter })).toBe(1);
      expect(await eraseDue(port, { now: asked.eraseAfter })).toBe(0);
    });

    it("nobody can sign in as, invite or add a tombstone's address", async () => {
      const port = await makePort();
      await expect(findOrCreatePerson(port, "x@erased.invalid", { now: T0 })).rejects.toThrow();
    });
  });
}
