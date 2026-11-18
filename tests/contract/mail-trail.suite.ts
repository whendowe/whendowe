// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { createEvent, findEventForParticipant } from "../../src/events/event.js";
import { leaveEvent } from "../../src/events/participation.js";
import type { MailAbout, MailMessage } from "../../src/mail/port.js";
import { createGroup } from "../../src/people/group.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { createThread, findThreadForMember, leaveThread } from "../../src/plans/thread.js";
import { eraseAccount } from "../../src/privacy/erasure.js";
import { purgeEventStatements, purgeThreadStatements } from "../../src/privacy/purge.js";
import {
  type MailTrailEntry,
  mailTrailOf,
  mailTrailText,
  recordUnsentMail,
  suppress,
  suppressingMailPort,
  undoOptOut,
} from "../../src/privacy/suppression.js";

// Mail that stops (DESIGN §10 rc51), on BOTH drivers: in a verified event or thread of
// exactly two people, the history records when one stops the other's email or takes it back,
// and each email of the other's that then didn't go out; everywhere else, nothing. Tests in
// one file share a database: each uses its own addresses and checks only its own rows.

const T0 = "2101-11-01T10:00:00.000Z";
const at = (h: number) => `2101-11-01T${String(10 + h).padStart(2, "0")}:00:00.000Z`;
const BASE = "https://whendowe.example";

const FIELDS = {
  title: "Handover",
  description: null,
  location: null,
  allDay: false,
  startLocal: "2101-12-20T10:00",
  endLocal: "2101-12-20T11:00",
  tzid: "Europe/Prague",
};

async function two(port: StoragePort, tag: string) {
  const bob = await findOrCreatePerson(port, `bob-${tag}@example.org`, { now: T0 });
  const ann = await findOrCreatePerson(port, `ann-${tag}@example.org`, { now: T0 });
  return { bob, ann };
}

async function eventOf(
  port: StoragePort,
  creatorId: string,
  others: readonly string[],
  opts: { verified?: boolean; editTier?: "edit" | "view" } = {},
) {
  return createEvent(port, {
    creatorId,
    group: null,
    fields: FIELDS,
    now: T0,
    verified: opts.verified ?? true,
    people: others.map((personId) => ({
      personId,
      editTier: opts.editTier ?? "view",
      visibility: "FULL",
    })),
  });
}

/** The trail, as [kind, what] pairs, oldest first. */
const kinds = (entries: readonly MailTrailEntry[]) =>
  entries.map((e) => (e.kind === "unsent" ? `unsent:${e.what}` : e.kind));

export function runMailTrailContract(makePort: () => Promise<StoragePort>): void {
  describe("mail that stops (DESIGN §10 rc51)", () => {
    it("in a verified event of two: stopping and starting again, only as changes", async () => {
      const port = await makePort();
      const { bob, ann } = await two(port, "ev");
      const event = await eventOf(port, bob.id, [ann.id]);
      const trail = () => mailTrailOf(port, { kind: "event", id: event.id });

      await suppress(port, ann.email, { kind: "person", id: bob.id }, at(1));
      expect(await trail()).toEqual([{ personId: ann.id, kind: "stopped", at: at(1) }]);
      // A second opt-out covering the same mail adds nothing; undoing one of two leaves her
      // stopped; undoing the last is "again".
      await suppress(port, ann.email, { kind: "all" }, at(2));
      await undoOptOut(port, ann.email, "person", bob.id, at(3));
      expect(kinds(await trail())).toEqual(["stopped"]);
      await undoOptOut(port, ann.email, "all", "", at(4));
      expect(await trail()).toEqual([
        { personId: ann.id, kind: "stopped", at: at(1) },
        { personId: ann.id, kind: "again", at: at(4) },
      ]);
      // Undoing an opt-out from someone else leaves the one from Bob standing.
      await suppress(port, ann.email, { kind: "person", id: bob.id }, at(4));
      await suppress(port, ann.email, { kind: "person", id: "someone-else" }, at(4));
      await undoOptOut(port, ann.email, "person", "someone-else", at(4));
      expect(kinds(await trail())).toEqual(["stopped", "again", "stopped"]);
      await undoOptOut(port, ann.email, "person", bob.id, at(4));
      // Undoing what isn't there, or opting out from someone else, records nothing.
      await undoOptOut(port, ann.email, "all", "", at(5));
      await suppress(port, ann.email, { kind: "person", id: ann.id }, at(6));
      expect(kinds(await trail())).toEqual(["stopped", "again", "stopped", "again"]);
      // Bob stopping Ann's is his row, not hers.
      await suppress(port, bob.email, { kind: "person", id: ann.id }, at(7));
      expect((await trail()).at(-1)).toEqual({ personId: bob.id, kind: "stopped", at: at(7) });
    });

    it("an email the seam drops is recorded in a verified event of two, and only there", async () => {
      const port = await makePort();
      const { bob, ann } = await two(port, "drop");
      const cat = await findOrCreatePerson(port, "cat-drop@example.org", { now: T0 });
      const event = await eventOf(port, bob.id, [ann.id]);
      const plain = await eventOf(port, bob.id, [ann.id], { verified: false });
      const sent: MailMessage[] = [];
      const mail = suppressingMailPort(
        {
          send: (m) => {
            sent.push(m);
            return Promise.resolve();
          },
        },
        port,
        { publicBaseUrl: BASE, now: () => at(2) },
      );
      const send = (to: string, senderId: string, about?: MailAbout) =>
        mail.send({
          to,
          subject: "s",
          text: "t",
          cause: { kind: "from", senderId, groupId: null, why: "w", ...(about ? { about } : {}) },
        });
      const about = { kind: "event", id: event.id, what: "answer_link" } as const;
      await suppress(port, ann.email, { kind: "all" }, at(1));

      await send(ann.email, bob.id, about);
      await send(ann.email, bob.id, { ...about, id: plain.id }); // not verified
      await send(ann.email, bob.id); // about nothing
      await send(ann.email, ann.id, about); // her own receipt: receipt_unsent's, not this
      await send(ann.email, cat.id, about); // Cat isn't on it
      await send(cat.email, bob.id, about); // nor is the address
      // Asked directly, as the senders that check first do: Cat is no one's pair here.
      await recordUnsentMail(port, { to: cat.email, senderId: bob.id, about, now: at(2) });
      expect(sent.map((m) => m.to)).toEqual([cat.email]); // the rest were dropped, silently
      expect(await mailTrailOf(port, { kind: "event", id: event.id })).toEqual([
        { personId: ann.id, kind: "stopped", at: at(1) },
        { personId: ann.id, kind: "unsent", what: "answer_link", at: at(2) },
      ]);
      expect(await mailTrailOf(port, { kind: "event", id: plain.id })).toEqual([]);
      // Mail that isn't dropped records nothing.
      await undoOptOut(port, ann.email, "all", "", at(3));
      await send(ann.email, bob.id, about);
      expect(kinds(await mailTrailOf(port, { kind: "event", id: event.id }))).toEqual([
        "stopped",
        "unsent:answer_link",
        "again",
      ]);
    });

    it("exactly two, counted at the moment: a third stops it, and the third leaving brings it back", async () => {
      const port = await makePort();
      const { bob, ann } = await two(port, "three");
      const cat = await findOrCreatePerson(port, "cat-three@example.org", { now: T0 });
      const event = await eventOf(port, bob.id, [ann.id, cat.id]);
      const trail = () => mailTrailOf(port, { kind: "event", id: event.id });
      const about = { kind: "event", id: event.id, what: "request" } as const;

      await suppress(port, ann.email, { kind: "all" }, at(1));
      await recordUnsentMail(port, { to: ann.email, senderId: bob.id, about, now: at(1) });
      expect(await trail()).toEqual([]);

      const asCat = await findEventForParticipant(port, event.id, cat.id);
      if (asCat === null) throw new Error("expected Cat on it");
      await leaveEvent(port, asCat, { now: at(2) });
      await recordUnsentMail(port, { to: ann.email, senderId: bob.id, about, now: at(3) });
      await undoOptOut(port, ann.email, "all", "", at(4));
      expect(kinds(await trail())).toEqual(["unsent:request", "again"]);
    });

    it("an opt-out from the group counts where the event is the group's, and no other group's does", async () => {
      const port = await makePort();
      const { bob, ann } = await two(port, "grp");
      const ours = await createGroup(port, { name: "Ours grp", creatorId: bob.id, now: T0 });
      const theirs = await createGroup(port, { name: "Theirs grp", creatorId: bob.id, now: T0 });
      await port.batch([
        {
          sql: "UPDATE canonical_event SET group_id = ? WHERE id = ?",
          params: [ours.id, (await eventOf(port, bob.id, [ann.id])).id],
        },
      ]);
      const [row] = await port.query({
        sql: "SELECT id FROM canonical_event WHERE group_id = ?",
        params: [ours.id],
      });
      const eventId = String(row?.id);
      await suppress(port, ann.email, { kind: "group", id: theirs.id }, at(1));
      expect(await mailTrailOf(port, { kind: "event", id: eventId })).toEqual([]);
      await suppress(port, ann.email, { kind: "group", id: ours.id }, at(2));
      expect(await mailTrailOf(port, { kind: "event", id: eventId })).toEqual([
        { personId: ann.id, kind: "stopped", at: at(2) },
      ]);
    });

    it("a guest or a former member listed is not one of the two", async () => {
      const port = await makePort();
      const { bob, ann } = await two(port, "listed");
      const thread = await createThread(port, {
        name: "Listed",
        tzid: "Europe/Prague",
        creatorId: bob.id,
        memberIds: [ann.id],
        verified: true,
        now: T0,
      });
      const event = await eventOf(port, bob.id, [ann.id]);
      for (const [id, column] of [
        ["guest-listed", "guest_at"],
        ["former-listed", "erased_at"],
      ] as const) {
        await port.batch([
          {
            sql:
              column === "guest_at"
                ? "INSERT INTO person (id, email, created_at, guest_at) VALUES (?, ?, ?, ?)"
                : "INSERT INTO person (id, email, created_at, erased_at) VALUES (?, ?, ?, ?)",
            params: [id, `${id}@guest.invalid`, T0, T0],
          },
          {
            sql: "INSERT INTO plan_thread_member (thread_id, person_id, created_at) VALUES (?, ?, ?)",
            params: [thread.id, id, T0],
          },
          {
            sql: `INSERT INTO event_participation
                    (canonical_event_id, person_id, edit_tier, visibility, created_at)
                  VALUES (?, ?, 'view', 'FULL', ?)`,
            params: [event.id, id, T0],
          },
        ]);
      }
      await suppress(port, ann.email, { kind: "all" }, at(1));
      for (const about of [
        { kind: "event", id: event.id, what: "answer_link" },
        { kind: "thread", id: thread.id, what: "vote_link" },
      ] as const)
        await recordUnsentMail(port, { to: ann.email, senderId: bob.id, about, now: at(2) });
      expect(kinds(await mailTrailOf(port, { kind: "event", id: event.id }))).toEqual([
        "stopped",
        "unsent:answer_link",
      ]);
      expect(kinds(await mailTrailOf(port, { kind: "thread", id: thread.id }))).toEqual([
        "stopped",
        "unsent:vote_link",
      ]);
    });

    it("not verified, nothing is recorded: the opt-out stays silent", async () => {
      const port = await makePort();
      const { bob, ann } = await two(port, "plain");
      const event = await eventOf(port, bob.id, [ann.id], { verified: false });
      await suppress(port, ann.email, { kind: "all" }, at(1));
      await undoOptOut(port, ann.email, "all", "", at(2));
      expect(await mailTrailOf(port, { kind: "event", id: event.id })).toEqual([]);
    });

    it("a verified thread of two records the same, and its vote links that didn't go out", async () => {
      const port = await makePort();
      const { bob, ann } = await two(port, "th");
      const thread = await createThread(port, {
        name: "Holidays",
        tzid: "Europe/Prague",
        creatorId: bob.id,
        memberIds: [ann.id],
        verified: true,
        now: T0,
      });
      const plain = await createThread(port, {
        name: "Other",
        tzid: "Europe/Prague",
        creatorId: bob.id,
        memberIds: [ann.id],
        now: T0,
      });
      const about = { kind: "thread", id: thread.id, what: "vote_link" } as const;
      await suppress(port, ann.email, { kind: "person", id: bob.id }, at(1));
      await recordUnsentMail(port, { to: ann.email, senderId: bob.id, about, now: at(2) });
      await recordUnsentMail(port, {
        to: ann.email,
        senderId: bob.id,
        about: { ...about, id: plain.id },
        now: at(2),
      });
      // Neither an address nor a sender outside it is recorded.
      const dan = await findOrCreatePerson(port, "dan-th@example.org", { now: T0 });
      await recordUnsentMail(port, { to: dan.email, senderId: bob.id, about, now: at(2) });
      await recordUnsentMail(port, { to: ann.email, senderId: dan.id, about, now: at(2) });
      await undoOptOut(port, ann.email, "person", bob.id, at(3));
      expect(await mailTrailOf(port, { kind: "thread", id: thread.id })).toEqual([
        { personId: ann.id, kind: "stopped", at: at(1) },
        { personId: ann.id, kind: "unsent", what: "vote_link", at: at(2) },
        { personId: ann.id, kind: "again", at: at(3) },
      ]);
      expect(await mailTrailOf(port, { kind: "thread", id: plain.id })).toEqual([]);
      // Three in it: nothing; the event trail never holds a thread's.
      const cat = await findOrCreatePerson(port, "cat-th@example.org", { now: T0 });
      const three = await createThread(port, {
        name: "Three",
        tzid: "Europe/Prague",
        creatorId: bob.id,
        memberIds: [ann.id, cat.id],
        verified: true,
        now: T0,
      });
      await suppress(port, ann.email, { kind: "all" }, at(4));
      await recordUnsentMail(port, {
        to: ann.email,
        senderId: bob.id,
        about: { ...about, id: three.id },
        now: at(4),
      });
      expect(await mailTrailOf(port, { kind: "thread", id: three.id })).toEqual([]);
      expect(kinds(await mailTrailOf(port, { kind: "thread", id: thread.id }))).toEqual([
        "stopped",
        "unsent:vote_link",
        "again",
        "stopped",
      ]);
      expect(await mailTrailOf(port, { kind: "event", id: thread.id })).toEqual([]);
      // Leaving a thread leaves its trail as it was.
      const asCat = await findThreadForMember(port, three.id, cat.id);
      if (asCat === null) throw new Error("expected Cat in it");
      await leaveThread(port, asCat, at(5));
      await undoOptOut(port, ann.email, "all", "", at(6));
      expect(kinds(await mailTrailOf(port, { kind: "thread", id: three.id }))).toEqual(["again"]);
    });

    it("erasure takes the rows about a person, leaves their mail's unnamed; purging takes all", async () => {
      const port = await makePort();
      const { bob, ann } = await two(port, "erase");
      // Ann may edit, so the event outlives Bob (rc21: what nobody can edit goes).
      const event = await eventOf(port, bob.id, [ann.id], { editTier: "edit" });
      const thread = await createThread(port, {
        name: "Holidays erase",
        tzid: "Europe/Prague",
        creatorId: bob.id,
        memberIds: [ann.id],
        verified: true,
        now: T0,
      });
      await suppress(port, ann.email, { kind: "all" }, at(1));
      await suppress(port, bob.email, { kind: "all" }, at(1));
      for (const about of [
        { kind: "event", id: event.id, what: "answer_link" },
        { kind: "thread", id: thread.id, what: "vote_link" },
      ] as const)
        await recordUnsentMail(port, { to: ann.email, senderId: bob.id, about, now: at(2) });
      const causedBy = (sql: string, id: string) =>
        port.query({ sql, params: [id] }).then((rows) => rows.map((r) => r.caused_by ?? null));

      await eraseAccount(port, bob.id, { now: at(3) });
      for (const of of [
        { kind: "event", id: event.id },
        { kind: "thread", id: thread.id },
      ] as const)
        expect((await mailTrailOf(port, of)).map((e) => [e.personId, e.kind])).toEqual([
          [ann.id, "stopped"],
          [ann.id, "unsent"],
        ]);
      expect(
        await causedBy(
          "SELECT caused_by FROM mail_trail WHERE canonical_event_id = ? AND kind = 'unsent'",
          event.id,
        ),
      ).toEqual([null]);
      expect(
        await causedBy(
          "SELECT caused_by FROM mail_trail WHERE thread_id = ? AND kind = 'unsent'",
          thread.id,
        ),
      ).toEqual([null]);

      await port.batch([
        ...purgeEventStatements(event.id, at(4)),
        ...purgeThreadStatements(thread.id, at(4)),
      ]);
      expect(
        await port.query({
          sql: "SELECT 1 AS n FROM mail_trail WHERE canonical_event_id = ? OR thread_id = ?",
          params: [event.id, thread.id],
        }),
      ).toEqual([]);
    });

    it("erasing the person whose email stopped takes their rows", async () => {
      const port = await makePort();
      const { bob, ann } = await two(port, "erase2");
      const event = await eventOf(port, bob.id, [ann.id]);
      await suppress(port, ann.email, { kind: "all" }, at(1));
      await eraseAccount(port, ann.id, { now: at(2) });
      expect(await mailTrailOf(port, { kind: "event", id: event.id })).toEqual([]);
    });

    it("the history's words never say which opt-out it was", () => {
      const e = (entry: MailTrailEntry) => mailTrailText(entry, "Ann");
      const base = { personId: "p", at: T0 };
      expect(e({ ...base, kind: "stopped" })).toBe("Ann stopped emails about this.");
      expect(e({ ...base, kind: "stopped_links" })).toBe(
        "Ann stopped emails about this, and asked for the link instead.",
      );
      expect(e({ ...base, kind: "again" })).toBe("Ann gets emails about this again.");
      const unsent = (what: "answer_link" | "vote_link" | "request" | "result") =>
        e({ ...base, kind: "unsent", what });
      const tail = "to Ann didn't go out: Ann isn't receiving email about this.";
      expect(unsent("answer_link")).toBe(`An answer link ${tail}`);
      expect(unsent("vote_link")).toBe(`A vote link ${tail}`);
      expect(unsent("request")).toBe(`A request to agree ${tail}`);
      expect(unsent("result")).toBe(`The email saying what was agreed ${tail}`);
    });
  });
}
