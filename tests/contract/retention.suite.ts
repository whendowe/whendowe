// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import {
  createEvent,
  type EventAccess,
  type EventFieldsInput,
  findEventForParticipant,
  setCancelled,
} from "../../src/events/event.js";
import { issueResponseLinks } from "../../src/events/response.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { createInvite } from "../../src/people/invite.js";
import { issueLoginToken } from "../../src/people/login.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { createSession } from "../../src/people/session.js";
import { addDraftEvent, castVote, sendDraft, startDraft } from "../../src/plans/plan.js";
import { createThread, findThreadForMember } from "../../src/plans/thread.js";
import { retentionPass } from "../../src/privacy/purge.js";

// Retention (DESIGN §10 rc21 *Retention*) on BOTH drivers: the date arithmetic that
// narrows candidates runs in SQL, which is exactly what must agree on D1 and libsql.
// Tests in one file share a database: each checks only its own rows.

const T0 = "2101-11-01T10:00:00.000Z";

const DINNER: EventFieldsInput = {
  title: "Rope jam",
  description: null,
  location: "The studio",
  allDay: false,
  startLocal: "2101-11-20T18:00",
  endLocal: "2101-11-20T20:00",
  tzid: "Europe/Prague",
};

async function access(port: StoragePort, eventId: string, personId: string): Promise<EventAccess> {
  const a = await findEventForParticipant(port, eventId, personId);
  if (a === null) throw new Error("expected access");
  return a;
}

async function exists(port: StoragePort, sql: string, id: string): Promise<boolean> {
  return (await port.query({ sql, params: [id] })).length > 0;
}
const eventExists = (port: StoragePort, id: string) =>
  exists(port, "SELECT 1 FROM canonical_event WHERE id = ?", id);

/** A port that counts every statement that could write. */
function counting(port: StoragePort): { port: StoragePort; writes: () => number } {
  let writes = 0;
  return {
    port: {
      query: (s) => {
        if (!/^\s*SELECT/i.test(s.sql)) writes += 1;
        return port.query(s);
      },
      batch: (stmts) => {
        writes += stmts.length;
        return port.batch(stmts);
      },
    },
    writes: () => writes,
  };
}

export function runRetentionContract(makePort: () => Promise<StoragePort>): void {
  describe("retention (DESIGN §10 rc21)", () => {
    it("past events go after their period — a group's own, or twelve months — and no sooner", async () => {
      const port = await makePort();
      const mara = await findOrCreatePerson(port, "ret-mara@example.org", { now: T0 });
      const group = await createGroup(port, { name: "Jams", creatorId: mara.id, now: T0 });
      // The group keeps a month (R4b gives organizers the setting).
      await port.batch([
        { sql: "UPDATE person_group SET retain_days = 30 WHERE id = ?", params: [group.id] },
      ]);
      const membership = await findGroupForMember(port, group.id, mara.id);
      const make = (fields: EventFieldsInput, inGroup: boolean) =>
        createEvent(port, {
          creatorId: mara.id,
          group: inGroup ? membership : null,
          fields,
          now: T0,
        });
      const monthly = await make(DINNER, true); // copies 30 days
      const yearly = await make(DINNER, false);
      const series = await make({ ...DINNER, rrule: "FREQ=WEEKLY;COUNT=3" }, false); // to Dec 4
      const endless = await make({ ...DINNER, rrule: "FREQ=WEEKLY" }, false);
      const stopped = await make({ ...DINNER, rrule: "FREQ=WEEKLY" }, false);
      await setCancelled(port, await access(port, stopped.id, mara.id), {
        cancelled: true,
        now: T0,
      });

      const at = async (now: string) => {
        await retentionPass(port, now);
        return {
          monthly: await eventExists(port, monthly.id),
          yearly: await eventExists(port, yearly.id),
          series: await eventExists(port, series.id),
          endless: await eventExists(port, endless.id),
          stopped: await eventExists(port, stopped.id),
        };
      };
      const all = { monthly: true, yearly: true, series: true, endless: true, stopped: true };
      expect(await at("2101-12-21T23:00:00.000Z")).toEqual(all);
      expect(await at("2101-12-22T00:00:00.000Z")).toEqual({ ...all, monthly: false });
      // Cancelled Nov 1: a year and a day later. The one-off a year after Nov 20.
      expect(await at("2102-11-03T00:00:00.000Z")).toEqual({
        ...all,
        monthly: false,
        stopped: false,
      });
      expect(await at("2102-11-22T00:00:00.000Z")).toEqual({
        ...all,
        monthly: false,
        stopped: false,
        yearly: false,
      });
      expect(await at("2102-12-06T00:00:00.000Z")).toEqual({
        monthly: false,
        stopped: false,
        yearly: false,
        series: false,
        endless: true, // never, until it's cancelled or given an end
      });
      // Purged events go through the pipeline: the ledger knows them.
      expect(
        await exists(
          port,
          "SELECT 1 FROM erasure_ledger WHERE kind = 'event' AND id = ?",
          yearly.id,
        ),
      ).toBe(true);
    });

    it("a plan that was never accepted goes twelve months after its last day", async () => {
      const port = await makePort();
      const tom = await findOrCreatePerson(port, "ret-tom@example.org", { now: T0 });
      const ada = await findOrCreatePerson(port, "ret-ada@example.org", { now: T0 });
      const thread = await createThread(port, {
        name: "Season",
        tzid: "Europe/Prague",
        creatorId: tom.id,
        memberIds: [ada.id],
        now: T0,
      });
      const gate = await findThreadForMember(port, thread.id, tom.id);
      if (gate === null) throw new Error("member");
      await startDraft(port, gate, { fromId: null, rest: false, replace: false, now: T0 });
      await addDraftEvent(port, gate, {
        title: "Week away",
        allDay: true,
        startLocal: "2101-11-07",
        endLocal: "2101-11-14",
        who: [tom.id],
        now: T0,
      });
      const sent = await sendDraft(port, gate, { now: T0 });
      if (sent.kind !== "sent") throw new Error(sent.kind);
      const planExists = () => exists(port, "SELECT 1 FROM plan WHERE id = ?", sent.planId);

      await retentionPass(port, "2102-11-14T12:00:00.000Z");
      expect(await planExists()).toBe(true);
      await retentionPass(port, "2102-11-15T00:00:00.000Z");
      expect(await planExists()).toBe(false);
      expect(await exists(port, "SELECT 1 FROM plan_event WHERE plan_id = ?", sent.planId)).toBe(
        false,
      );
      // The thread and its people stay: retention takes old proposals, not the group.
      expect(await findThreadForMember(port, thread.id, ada.id)).not.toBeNull();
    });

    it("an accepted plan stays while its events do, however old the plan", async () => {
      const port = await makePort();
      const tom = await findOrCreatePerson(port, "ret-tom2@example.org", { now: T0 });
      const ada = await findOrCreatePerson(port, "ret-ada2@example.org", { now: T0 });
      const thread = await createThread(port, {
        name: "Agreed",
        tzid: "Europe/Prague",
        creatorId: tom.id,
        memberIds: [ada.id],
        now: T0,
      });
      const t = await findThreadForMember(port, thread.id, tom.id);
      const a = await findThreadForMember(port, thread.id, ada.id);
      if (t === null || a === null) throw new Error("member");
      await startDraft(port, t, { fromId: null, rest: false, replace: false, now: T0 });
      await addDraftEvent(port, t, {
        title: "Week away",
        allDay: true,
        startLocal: "2101-11-07",
        endLocal: "2101-11-14",
        who: [tom.id],
        now: T0,
      });
      const sent = await sendDraft(port, t, { now: T0 });
      if (sent.kind !== "sent") throw new Error(sent.kind);
      const voted = await castVote(port, a, { planId: sent.planId, answer: "yes", now: T0 });
      expect(voted.kind).toBe("accepted");
      // Its event is kept two years (an editor's choice, R4b).
      await port.batch([
        {
          sql: `UPDATE canonical_event SET retain_days = 730
                WHERE id IN (SELECT canonical_event_id FROM plan_event WHERE plan_id = ?)`,
          params: [sent.planId],
        },
      ]);
      const planExists = () => exists(port, "SELECT 1 FROM plan WHERE id = ?", sent.planId);
      await retentionPass(port, "2102-11-15T00:00:00.000Z");
      expect(await planExists()).toBe(true); // a year on, but its event is still here
      await retentionPass(port, "2103-11-15T00:00:00.000Z");
      expect(await planExists()).toBe(false); // the event went, and the plan with it
    });

    it("expired links, sessions and invites go a day after they expire; this month's mail counts stay", async () => {
      const port = await makePort();
      const lena = await findOrCreatePerson(port, "ret-lena@example.org", { now: T0 });
      const group = await createGroup(port, { name: "Picnic", creatorId: lena.id, now: T0 });
      const membership = await findGroupForMember(port, group.id, lena.id);
      if (membership === null) throw new Error("membership");
      await issueLoginToken(port, lena.email, { now: T0 });
      // Older rows elsewhere, so each sweep runs while Lena's are still too new for it.
      await issueLoginToken(port, "ret-old@example.org", { now: "2101-10-30T10:00:00.000Z" });
      await createSession(port, lena.id, { now: T0 });
      const invite = await createInvite(port, membership, {
        email: "ret-guest@example.org",
        invitedBy: lena.id,
        editTier: "view",
        visibility: "FULL",
        now: T0,
      });
      if (!invite.ok) throw new Error(invite.reason);
      const event = await createEvent(port, {
        creatorId: lena.id,
        group: null,
        fields: DINNER,
        now: T0,
        people: [
          {
            personId: (await findOrCreatePerson(port, "ret-ana@example.org", { now: T0 })).id,
            editTier: "view",
            visibility: "FULL",
          },
        ],
      });
      await issueResponseLinks(port, await access(port, event.id, lena.id), { now: T0 });
      await port.batch([
        {
          sql: "INSERT INTO mail_send (day, month, created_at, anonymous) VALUES (?, ?, ?, 0)",
          params: ["2101-11-01", "2101-11", T0],
        },
        {
          sql: "INSERT INTO mail_send (day, month, created_at, anonymous) VALUES (?, ?, ?, 0)",
          params: ["2101-10-31", "2101-10", "2101-10-31T10:00:00.000Z"],
        },
      ]);
      const count = async (table: string, sql: string, id: string) => {
        const rows = await port.query({ sql, params: [id] });
        return { [table]: rows.length };
      };
      const left = async () => ({
        ...(await count("login", "SELECT 1 FROM login_token WHERE email = ?", lena.email)),
        ...(await count("session", "SELECT 1 FROM session WHERE person_id = ?", lena.id)),
        ...(await count("invite", "SELECT 1 FROM group_invite WHERE group_id = ?", group.id)),
        ...(await count(
          "answer",
          "SELECT 1 FROM response_token WHERE canonical_event_id = ?",
          event.id,
        )),
        ...(await count("mail", "SELECT 1 FROM mail_send WHERE month = ?", "2101-11")),
      });

      // Two hours on, the sign-in link has expired but still counts towards the hour's
      // limit on links to that address: it stays.
      await retentionPass(port, "2101-11-01T12:00:00.000Z");
      expect(await left()).toEqual({ login: 1, session: 1, invite: 1, answer: 1, mail: 1 });
      // The older ones went in that pass.
      expect(
        await exists(port, "SELECT 1 FROM login_token WHERE email = ?", "ret-old@example.org"),
      ).toBe(false);
      expect(await exists(port, "SELECT 1 FROM mail_send WHERE month = ?", "2101-10")).toBe(false);
      // A day after it expired, it goes; the rest are still live.
      await retentionPass(port, "2101-11-02T10:16:00.000Z");
      expect(await left()).toEqual({ login: 0, session: 1, invite: 1, answer: 1, mail: 1 });
      // Invites last 7 days, answer links 14, sessions 30; November's mail count, until December.
      await retentionPass(port, "2101-11-09T10:01:00.000Z");
      expect(await left()).toEqual({ login: 0, session: 1, invite: 0, answer: 1, mail: 1 });
      await retentionPass(port, "2101-11-30T10:01:00.000Z");
      expect(await left()).toEqual({ login: 0, session: 1, invite: 0, answer: 0, mail: 1 });
      await retentionPass(port, "2101-12-02T10:01:00.000Z");
      expect(await left()).toEqual({ login: 0, session: 0, invite: 0, answer: 0, mail: 0 });
    });

    it("the erasure ledger is kept 35 days", async () => {
      const port = await makePort();
      await port.batch([
        {
          sql: "INSERT INTO erasure_ledger (kind, id, erased_at) VALUES ('person', ?, ?)",
          params: ["ret-ledger", T0],
        },
      ]);
      const kept = () => exists(port, "SELECT 1 FROM erasure_ledger WHERE id = ?", "ret-ledger");
      await retentionPass(port, "2101-12-05T09:00:00.000Z"); // 34 days, 23 hours
      expect(await kept()).toBe(true);
      await retentionPass(port, "2101-12-06T11:00:00.000Z");
      expect(await kept()).toBe(false);
    });

    it("with nothing due, a pass writes nothing (§16), and a second pass after a busy one neither", async () => {
      const port = await makePort();
      const zed = await findOrCreatePerson(port, "ret-zed@example.org", { now: T0 });
      await createEvent(port, { creatorId: zed.id, group: null, fields: DINNER, now: T0 });
      await issueLoginToken(port, zed.email, { now: T0 });
      const quiet = counting(port);
      await retentionPass(quiet.port, T0);
      expect(quiet.writes()).toBe(0);

      const later = "2999-01-01T10:07:00.000Z";
      // Everything this file made is long due; a pass takes at most a chunk, so run to empty.
      for (let i = 0; i < 20; i += 1) {
        const r = await retentionPass(port, later);
        if (r.events + r.plans + r.sweeps === 0) break;
      }
      const after = counting(port);
      await retentionPass(after.port, later);
      expect(after.writes()).toBe(0);
    });
  });
}
