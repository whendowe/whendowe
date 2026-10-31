// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { SqlStatement, StoragePort } from "../db/port.js";
import { transitionStatements } from "../events/event.js";
import { uuidv7 } from "../ids.js";
import { collect, reapplyLedger } from "./purge.js";

// Deleting an account (DESIGN §10 rc21 *Privacy basics*, GDPR Art. 17).
//
// Everything leaving does, for every event, group and thread the person is in — and in
// the ones they have left too, since their history is still there. Their own rows go:
// participation, answers, votes, notes, drafts, links, sessions, sign-in links, invites
// to their address, calendar connections. What OTHER people's history needs to read
// right — "who changed this", "who proposed that" — is moved to a TOMBSTONE: a person
// called "a former member", one per container, so an erased person can't be followed
// from one event to the next. Then the person row itself goes, and the ledger says so.
//
// One batch per container, then one for the person: a heavy user's thousand events must
// not be one statement list too long for a driver. Each batch is safe to run again.

/** What a tombstone is called, everywhere. */
export const FORMER_MEMBER = "a former member";

const tombstone = (id: string, now: string, exists: SqlStatement): SqlStatement => ({
  sql: `INSERT INTO person (id, email, display_name, created_at, erased_at)
        SELECT ?, ?, ?, ?, ? WHERE ${exists.sql}`,
  params: [id, `${id}@erased.invalid`, FORMER_MEMBER, now, now, ...exists.params],
});

const idsSchema = z.array(z.object({ id: z.string() }));

async function ids(storage: StoragePort, sql: string, params: readonly string[]) {
  return idsSchema.parse(await storage.query({ sql, params })).map((r) => r.id);
}

/**
 * Every container the person appears in — taking part now, or only in its history. One
 * query per place a person can be referenced, merged here: D1 caps how many SELECTs one
 * compound statement may UNION (the both-drivers contract suite found it).
 */
async function containersOf(storage: StoragePort, p: string) {
  const merged = async (queries: readonly (readonly [string, readonly string[]])[]) => {
    const found = new Set<string>();
    for (const [sql, params] of queries)
      for (const id of await ids(storage, sql, params)) found.add(id);
    return [...found].sort();
  };
  const events = await merged([
    ["SELECT canonical_event_id AS id FROM event_participation WHERE person_id = ?", [p]],
    ["SELECT canonical_event_id AS id FROM slot_response WHERE person_id = ?", [p]],
    ["SELECT canonical_event_id AS id FROM event_feedback WHERE person_id = ?", [p]],
    ["SELECT canonical_event_id AS id FROM response_token WHERE person_id = ?", [p]],
    [
      "SELECT canonical_event_id AS id FROM event_change_proposal WHERE proposed_by = ? OR decided_by = ?",
      [p, p],
    ],
    [
      "SELECT canonical_event_id AS id FROM event_participant_change WHERE person_id = ? OR actor_id = ?",
      [p, p],
    ],
    ["SELECT DISTINCT canonical_event_id AS id FROM change_log WHERE actor = ?", [p]],
    ["SELECT id FROM canonical_event WHERE owner_id = ?", [p]],
  ]);
  const groups = await merged([
    ["SELECT group_id AS id FROM group_member WHERE person_id = ?", [p]],
    ["SELECT id FROM person_group WHERE created_by = ?", [p]],
    ["SELECT DISTINCT group_id AS id FROM group_invite WHERE invited_by = ?", [p]],
  ]);
  const threads = await merged([
    ["SELECT thread_id AS id FROM plan_thread_member WHERE person_id = ?", [p]],
    ["SELECT id FROM plan_thread WHERE organizer_id = ?", [p]],
    ["SELECT DISTINCT thread_id AS id FROM plan WHERE author_id = ? OR decided_by = ?", [p, p]],
    ["SELECT DISTINCT thread_id AS id FROM plan_note WHERE author_id = ?", [p]],
    [
      "SELECT DISTINCT pl.thread_id AS id FROM plan_vote v JOIN plan pl ON pl.id = v.plan_id WHERE v.person_id = ?",
      [p],
    ],
  ]);
  return { events, groups, threads };
}

function eventStatements(e: string, p: string, t: string, now: string): SqlStatement[] {
  const awaited = {
    sql: `EXISTS (SELECT 1 FROM event_participation WHERE canonical_event_id = ? AND person_id = ?
            AND response_kind = 'accept' AND (response_state IS NULL OR response_state = 'pending'))`,
    params: [e, p],
  };
  const referenced: SqlStatement = {
    sql: `(EXISTS (SELECT 1 FROM change_log WHERE canonical_event_id = ? AND actor = ?)
           OR EXISTS (SELECT 1 FROM event_participant_change
                      WHERE canonical_event_id = ? AND (person_id = ? OR actor_id = ?))
           OR EXISTS (SELECT 1 FROM event_change_proposal
                      WHERE canonical_event_id = ? AND (proposed_by = ? OR decided_by = ?))
           OR EXISTS (SELECT 1 FROM canonical_event WHERE id = ? AND owner_id = ?)
           OR ${awaited.sql})`,
    params: [e, p, e, p, p, e, p, p, e, p, ...awaited.params],
  };
  return [
    tombstone(t, now, referenced),
    // An event waiting for THEIR agreement can't happen now: it is declined, by them.
    ...transitionStatements({
      eventId: e,
      from: "proposed",
      to: "declined",
      actorId: t,
      now,
      afterPrevious: false,
      gate: awaited,
    }),
    {
      sql: "UPDATE change_log SET actor = ? WHERE canonical_event_id = ? AND actor = ?",
      params: [t, e, p],
    },
    {
      sql: "UPDATE event_participant_change SET person_id = ? WHERE canonical_event_id = ? AND person_id = ?",
      params: [t, e, p],
    },
    {
      sql: "UPDATE event_participant_change SET actor_id = ? WHERE canonical_event_id = ? AND actor_id = ?",
      params: [t, e, p],
    },
    {
      sql: `UPDATE event_change_proposal SET status = 'withdrawn', decided_at = ?
            WHERE canonical_event_id = ? AND proposed_by = ? AND status = 'pending'`,
      params: [now, e, p],
    },
    {
      sql: "UPDATE event_change_proposal SET proposed_by = ? WHERE canonical_event_id = ? AND proposed_by = ?",
      params: [t, e, p],
    },
    {
      sql: "UPDATE event_change_proposal SET decided_by = ? WHERE canonical_event_id = ? AND decided_by = ?",
      params: [t, e, p],
    },
    {
      sql: "UPDATE canonical_event SET owner_id = ? WHERE id = ? AND owner_id = ?",
      params: [t, e, p],
    },
    {
      sql: "DELETE FROM response_token WHERE canonical_event_id = ? AND person_id = ?",
      params: [e, p],
    },
    {
      sql: "DELETE FROM slot_response WHERE canonical_event_id = ? AND person_id = ?",
      params: [e, p],
    },
    {
      sql: "DELETE FROM event_feedback WHERE canonical_event_id = ? AND person_id = ?",
      params: [e, p],
    },
    {
      sql: "DELETE FROM event_participation WHERE canonical_event_id = ? AND person_id = ?",
      params: [e, p],
    },
  ];
}

function groupStatements(g: string, p: string, t: string, now: string): SqlStatement[] {
  return [
    // As leaving: an organizer hands the role to the longest-standing member.
    {
      sql: `UPDATE group_member SET role = 'organizer'
            WHERE group_id = ? AND person_id =
                (SELECT person_id FROM group_member WHERE group_id = ? AND person_id <> ?
                 ORDER BY joined_at, person_id LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM group_member
                              WHERE group_id = ? AND role = 'organizer' AND person_id <> ?)`,
      params: [g, g, p, g, p],
    },
    { sql: "DELETE FROM group_invite WHERE group_id = ? AND invited_by = ?", params: [g, p] },
    { sql: "DELETE FROM group_member WHERE group_id = ? AND person_id = ?", params: [g, p] },
    tombstone(t, now, {
      sql: "EXISTS (SELECT 1 FROM person_group WHERE id = ? AND created_by = ?)",
      params: [g, p],
    }),
    {
      sql: "UPDATE person_group SET created_by = ? WHERE id = ? AND created_by = ?",
      params: [t, g, p],
    },
  ];
}

function threadStatements(th: string, p: string, t: string, now: string): SqlStatement[] {
  const quoted = `"${p}"`;
  return [
    {
      sql: `UPDATE plan SET status = 'withdrawn', decided_at = ?, updated_at = ?
            WHERE thread_id = ? AND author_id = ? AND status = 'on_table'`,
      params: [now, now, th, p],
    },
    {
      sql: `DELETE FROM plan_event WHERE plan_id IN
              (SELECT id FROM plan WHERE thread_id = ? AND author_id = ? AND status = 'draft')`,
      params: [th, p],
    },
    {
      sql: "DELETE FROM plan WHERE thread_id = ? AND author_id = ? AND status = 'draft'",
      params: [th, p],
    },
    {
      sql: "DELETE FROM plan_vote WHERE person_id = ? AND plan_id IN (SELECT id FROM plan WHERE thread_id = ?)",
      params: [p, th],
    },
    { sql: "DELETE FROM plan_note WHERE thread_id = ? AND author_id = ?", params: [th, p] },
    {
      sql: `UPDATE plan_thread SET organizer_id =
              (SELECT person_id FROM plan_thread_member WHERE thread_id = ? AND person_id <> ?
               ORDER BY created_at, person_id LIMIT 1)
            WHERE id = ? AND organizer_id = ?
              AND EXISTS (SELECT 1 FROM plan_thread_member WHERE thread_id = ? AND person_id <> ?)`,
      params: [th, p, th, p, th, p],
    },
    {
      sql: "DELETE FROM plan_thread_member WHERE thread_id = ? AND person_id = ?",
      params: [th, p],
    },
    tombstone(t, now, {
      sql: `(EXISTS (SELECT 1 FROM plan_thread WHERE id = ? AND organizer_id = ?)
             OR EXISTS (SELECT 1 FROM plan WHERE thread_id = ? AND (author_id = ? OR decided_by = ?))
             OR EXISTS (SELECT 1 FROM plan_event pe JOIN plan pl ON pl.id = pe.plan_id
                        WHERE pl.thread_id = ? AND instr(pe.who, ?) > 0))`,
      params: [th, p, th, p, p, th, quoted],
    }),
    {
      sql: "UPDATE plan_thread SET organizer_id = ? WHERE id = ? AND organizer_id = ?",
      params: [t, th, p],
    },
    {
      sql: "UPDATE plan SET author_id = ? WHERE thread_id = ? AND author_id = ?",
      params: [t, th, p],
    },
    {
      sql: "UPDATE plan SET decided_by = ? WHERE thread_id = ? AND decided_by = ?",
      params: [t, th, p],
    },
    // Who an event is for is a JSON list of member ids: the same swap, inside it.
    {
      sql: `UPDATE plan_event SET who = replace(who, ?, ?)
            WHERE plan_id IN (SELECT id FROM plan WHERE thread_id = ?) AND instr(who, ?) > 0`,
      params: [quoted, `"${t}"`, th, quoted],
    },
  ];
}

export interface ErasePreview {
  /** Events only they can edit: erasing deletes these, for this many other people. */
  readonly eventsDeleted: number;
  readonly peopleAffected: number;
  readonly groupsDeleted: number;
  readonly threadsDeleted: number;
}

/** What deleting this account would take with it, for the confirmation page. */
export async function erasePreview(storage: StoragePort, p: string): Promise<ErasePreview> {
  const n = async (sql: string, params: readonly string[]) =>
    z.number().parse((await storage.query({ sql, params }))[0]?.n);
  const lonely = `SELECT ep.canonical_event_id FROM event_participation ep
    WHERE ep.person_id = ? AND ep.edit_tier = 'edit' AND NOT EXISTS
      (SELECT 1 FROM event_participation o WHERE o.canonical_event_id = ep.canonical_event_id
         AND o.person_id <> ? AND o.edit_tier = 'edit')`;
  return {
    eventsDeleted: await n(`SELECT count(*) AS n FROM (${lonely})`, [p, p]),
    peopleAffected: await n(
      `SELECT count(DISTINCT person_id) AS n FROM event_participation
       WHERE person_id <> ? AND canonical_event_id IN (${lonely})`,
      [p, p, p],
    ),
    groupsDeleted: await n(
      `SELECT count(*) AS n FROM group_member m WHERE m.person_id = ? AND NOT EXISTS
         (SELECT 1 FROM group_member o WHERE o.group_id = m.group_id AND o.person_id <> ?)`,
      [p, p],
    ),
    threadsDeleted: await n(
      `SELECT count(*) AS n FROM plan_thread_member m WHERE m.person_id = ? AND NOT EXISTS
         (SELECT 1 FROM plan_thread_member o WHERE o.thread_id = m.thread_id AND o.person_id <> ?)`,
      [p, p],
    ),
  };
}

/** A calendar connection to revoke at the provider before its tokens are deleted. */
export interface ConnectionToRevoke {
  readonly id: string;
  readonly refreshTokenEnc: string;
}

/** The person's calendar connections, so the caller can revoke them first (§10 rc21). */
export async function connectionsOf(
  storage: StoragePort,
  p: string,
): Promise<ConnectionToRevoke[]> {
  const rows = await storage.query({
    sql: "SELECT id, refresh_token_enc FROM calendar_connection WHERE owner_id = ?",
    params: [p],
  });
  return rows.map((r) => {
    const v = z.object({ id: z.string(), refresh_token_enc: z.string() }).parse(r);
    return { id: v.id, refreshTokenEnc: v.refresh_token_enc };
  });
}

/**
 * Erase a person (§10 rc21). Their email must be read before: it goes with the person
 * row, and is what sign-in links and invites to them are found by.
 */
export async function eraseAccount(
  storage: StoragePort,
  personId: string,
  input: { readonly now: string; readonly newId?: () => string },
): Promise<{ readonly events: string[]; readonly groups: string[]; readonly threads: string[] }> {
  const newId = input.newId ?? (() => uuidv7());
  const now = input.now;
  const p = personId;
  const emailRows = await storage.query({
    sql: "SELECT email FROM person WHERE id = ?",
    params: [p],
  });
  const email = z.string().parse(emailRows[0]?.email);
  const where = await containersOf(storage, p);

  for (const e of where.events) await storage.batch(eventStatements(e, p, newId(), now));
  for (const g of where.groups) await storage.batch(groupStatements(g, p, newId(), now));
  for (const th of where.threads) await storage.batch(threadStatements(th, p, newId(), now));

  await storage.batch([
    { sql: "DELETE FROM session WHERE person_id = ?", params: [p] },
    { sql: "DELETE FROM login_token WHERE email = ?", params: [email] },
    { sql: "DELETE FROM group_invite WHERE email = ?", params: [email] },
    {
      sql: "DELETE FROM projection WHERE calendar_connection_id IN (SELECT id FROM calendar_connection WHERE owner_id = ?)",
      params: [p],
    },
    { sql: "DELETE FROM calendar_connection WHERE owner_id = ?", params: [p] },
    { sql: "DELETE FROM person WHERE id = ?", params: [p] },
    {
      sql: "INSERT INTO erasure_ledger (kind, id, erased_at) VALUES ('person', ?, ?) ON CONFLICT DO NOTHING",
      params: [p, now],
    },
  ]);
  // What nobody can edit, or nobody is in, any more: gone too.
  return collect(storage, where, now);
}

/**
 * After a restore from backup (§10 rc21 *the backup tail*): erase again every person the
 * ledger says was erased and the backup brought back, then purge the containers.
 */
export async function reapplyErasures(storage: StoragePort, now: string): Promise<number> {
  const people = await ids(
    storage,
    `SELECT l.id FROM erasure_ledger l JOIN person p ON p.id = l.id WHERE l.kind = 'person'`,
    [],
  );
  for (const p of people) await eraseAccount(storage, p, { now });
  return people.length + (await reapplyLedger(storage, now));
}
