// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { canSee } from "../events/participation.js";
import { visibilitySchema } from "../people/invite.js";

// "Download your data" (DESIGN §10 rc21, GDPR Art. 15 and 20): one JSON document of the
// account, the groups, events and plans it is in, and what it said in them — events at
// the person's OWN tier, exactly as their pages show them (§9 visibility integrity).
// Other people appear by nothing at all: an export is yours, not a copy of theirs.
// A read: the route is a GET and this writes nothing.

const row = <T extends z.ZodRawShape>(shape: T) => z.object(shape);

async function all<T extends z.ZodRawShape>(
  storage: StoragePort,
  shape: T,
  sql: string,
  params: readonly string[],
) {
  return (await storage.query({ sql, params })).map((r) => row(shape).parse(r));
}

const nullable = z.string().nullable();

export async function exportPerson(storage: StoragePort, personId: string, now: string) {
  const [account] = await all(
    storage,
    { email: z.string(), display_name: nullable, created_at: z.string() },
    "SELECT email, display_name, created_at FROM person WHERE id = ?",
    [personId],
  );
  if (account === undefined) throw new Error("no such person");

  const groups = await all(
    storage,
    {
      name: z.string(),
      role: z.string(),
      handle: nullable,
      show_email: z.number(),
      joined_at: z.string(),
    },
    `SELECT g.name, m.role, m.handle, m.show_email, m.joined_at
     FROM group_member m JOIN person_group g ON g.id = m.group_id
     WHERE m.person_id = ? ORDER BY m.joined_at`,
    [personId],
  );

  const events = await all(
    storage,
    {
      id: z.string(),
      title: z.string(),
      description: nullable,
      location: nullable,
      all_day: z.number(),
      start_local: z.string(),
      end_local: z.string(),
      tzid: nullable,
      rrule: nullable,
      status: z.string(),
      edit_tier: z.string(),
      visibility: visibilitySchema,
      attendance: nullable,
      response_kind: z.string(),
      response_state: nullable,
      handle: nullable,
      show_email: z.number(),
    },
    `SELECT e.id, e.title, e.description, e.location, e.all_day, e.start_local, e.end_local,
            e.tzid, e.rrule, e.status, ep.edit_tier, ep.visibility, ep.attendance,
            ep.response_kind, ep.response_state, ep.handle, ep.show_email
     FROM event_participation ep JOIN canonical_event e ON e.id = ep.canonical_event_id
     WHERE ep.person_id = ? ORDER BY e.start_local`,
    [personId],
  );
  const notes = await all(
    storage,
    { canonical_event_id: z.string(), body: z.string(), created_at: z.string() },
    "SELECT canonical_event_id, body, created_at FROM event_feedback WHERE person_id = ? ORDER BY created_at",
    [personId],
  );
  const votes = await all(
    storage,
    { canonical_event_id: z.string(), slot_index: z.number(), answer: z.string() },
    "SELECT canonical_event_id, slot_index, answer FROM slot_response WHERE person_id = ?",
    [personId],
  );

  const threads = await all(
    storage,
    {
      id: z.string(),
      name: z.string(),
      organizer_id: z.string(),
      handle: nullable,
      show_email: z.number(),
    },
    `SELECT t.id, t.name, t.organizer_id, m.handle, m.show_email
     FROM plan_thread_member m JOIN plan_thread t ON t.id = m.thread_id
     WHERE m.person_id = ? ORDER BY m.created_at`,
    [personId],
  );
  const plans = await all(
    storage,
    {
      id: z.string(),
      thread_id: z.string(),
      name: z.string(),
      status: z.string(),
      created_at: z.string(),
    },
    "SELECT id, thread_id, name, status, created_at FROM plan WHERE author_id = ? ORDER BY created_at",
    [personId],
  );
  const planEvents = await all(
    storage,
    { plan_id: z.string(), title: z.string(), start_local: z.string(), end_local: z.string() },
    `SELECT pe.plan_id, pe.title, pe.start_local, pe.end_local
     FROM plan_event pe JOIN plan p ON p.id = pe.plan_id WHERE p.author_id = ?
     ORDER BY pe.start_local`,
    [personId],
  );
  const planVotes = await all(
    storage,
    { thread_id: z.string(), plan: z.string(), answer: z.string() },
    `SELECT p.thread_id, p.name AS plan, v.answer FROM plan_vote v JOIN plan p ON p.id = v.plan_id
     WHERE v.person_id = ?`,
    [personId],
  );
  const planNotes = await all(
    storage,
    {
      thread_id: z.string(),
      first_day: z.string(),
      last_day: z.string(),
      body: z.string(),
      private: z.number(),
    },
    "SELECT thread_id, first_day, last_day, body, private FROM plan_note WHERE author_id = ?",
    [personId],
  );
  const connections = await all(
    storage,
    { account_email: z.string(), calendar_id: z.string(), status: z.string() },
    "SELECT account_email, calendar_id, status FROM calendar_connection WHERE owner_id = ?",
    [personId],
  );

  return {
    exported_at: now,
    account: { email: account.email, name: account.display_name, created_at: account.created_at },
    groups: groups.map((g) => ({
      name: g.name,
      role: g.role,
      your_name_here: g.handle,
      email_shown_here: g.show_email === 1,
      joined_at: g.joined_at,
    })),
    events: events.map((e) => {
      const see = (part: Parameters<typeof canSee>[1]) => canSee(e.visibility, part);
      return {
        title: see("title") ? e.title : null,
        description: see("description") ? e.description : null,
        location: see("location") ? e.location : null,
        all_day: e.all_day === 1,
        start: e.start_local,
        end: e.end_local,
        time_zone: e.tzid,
        repeats: e.rrule,
        status: e.status,
        you: {
          can: e.edit_tier,
          see: e.visibility,
          attendance: e.attendance,
          asked_to: e.response_kind,
          answer: e.response_state,
          your_name_here: e.handle,
          email_shown_here: e.show_email === 1,
        },
        your_notes: notes
          .filter((n) => n.canonical_event_id === e.id)
          .map((n) => ({ note: n.body, at: n.created_at })),
        your_votes: votes
          .filter((v) => v.canonical_event_id === e.id)
          .map((v) => ({ option: v.slot_index + 1, answer: v.answer })),
      };
    }),
    plans: threads.map((t) => ({
      name: t.name,
      you_organize: t.organizer_id === personId,
      your_name_here: t.handle,
      email_shown_here: t.show_email === 1,
      your_plans: plans
        .filter((p) => p.thread_id === t.id)
        .map((p) => ({
          name: p.name,
          status: p.status,
          created_at: p.created_at,
          events: planEvents
            .filter((pe) => pe.plan_id === p.id)
            .map((pe) => ({ title: pe.title, start: pe.start_local, end: pe.end_local })),
        })),
      your_votes: planVotes
        .filter((v) => v.thread_id === t.id)
        .map((v) => ({ plan: v.plan, answer: v.answer })),
      your_notes: planNotes
        .filter((n) => n.thread_id === t.id)
        .map((n) => ({
          from: n.first_day,
          to: n.last_day,
          note: n.body,
          private: n.private === 1,
        })),
    })),
    calendar_connections: connections,
  };
}
