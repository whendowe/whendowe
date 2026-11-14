// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { SqlStatement, StoragePort } from "../db/port.js";
import {
  cutoff,
  DEFAULT_RETAIN_DAYS,
  isEventDue,
  isPlanDue,
  LEDGER_KEEP_DAYS,
} from "./retention.js";

// The purge pipeline (DESIGN §10 deletion model point 5, rc21 *Privacy basics*): the ONE
// place that hard-deletes an event, a group or a plan thread. User acts only ask for it —
// deleting an event, leaving the last, retention — and this does it.
//
// Each purge is one batch: every row that hangs off the thing, children before parents
// (so it never depends on whether a driver enforces foreign keys), the thing itself, and
// an erasure-ledger row naming it by id. The ledger is what lets a restore from backup
// put the purges back (reapplyLedger below) before the instance serves again.

export type PurgeKind = "event" | "group" | "thread";

function ledger(kind: PurgeKind, id: string, now: string): SqlStatement {
  return {
    sql: "INSERT INTO erasure_ledger (kind, id, erased_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    params: [kind, id, now],
  };
}

/** Everything under an event, children first; written out, never built from names (§13). */
const EVENT_CHILDREN: readonly string[] = [
  "DELETE FROM projection WHERE canonical_event_id = ?",
  "DELETE FROM event_override WHERE canonical_event_id = ?",
  "DELETE FROM slot_response WHERE canonical_event_id = ?",
  "DELETE FROM event_candidate WHERE canonical_event_id = ?",
  "DELETE FROM event_feedback WHERE canonical_event_id = ?",
  "DELETE FROM receipt_unsent WHERE canonical_event_id = ?",
  "DELETE FROM verified_request_token WHERE request_id IN (SELECT id FROM verified_request WHERE canonical_event_id = ?)",
  "DELETE FROM verified_request_answer WHERE request_id IN (SELECT id FROM verified_request WHERE canonical_event_id = ?)",
  "DELETE FROM verified_request WHERE canonical_event_id = ?",
  "DELETE FROM response_token WHERE canonical_event_id = ?",
  "DELETE FROM event_change_proposal WHERE canonical_event_id = ?",
  "DELETE FROM event_participant_change WHERE canonical_event_id = ?",
  "DELETE FROM event_participation WHERE canonical_event_id = ?",
  "DELETE FROM change_log WHERE canonical_event_id = ?",
];

export function purgeEventStatements(eventId: string, now: string): SqlStatement[] {
  return [
    {
      sql: "UPDATE plan_event SET canonical_event_id = NULL WHERE canonical_event_id = ?",
      params: [eventId],
    },
    ...EVENT_CHILDREN.map((sql) => ({ sql, params: [eventId] })),
    { sql: "DELETE FROM canonical_event WHERE id = ?", params: [eventId] },
    ledger("event", eventId, now),
  ];
}

export function purgeGroupStatements(groupId: string, now: string): SqlStatement[] {
  return [
    // Events made from the group outlive it: group_id was only ever provenance (rc15).
    { sql: "UPDATE canonical_event SET group_id = NULL WHERE group_id = ?", params: [groupId] },
    { sql: "DELETE FROM group_invite WHERE group_id = ?", params: [groupId] },
    { sql: "DELETE FROM group_member WHERE group_id = ?", params: [groupId] },
    // An opt-out from this group has nothing left to stop (rc24).
    {
      sql: "DELETE FROM mail_suppression WHERE scope = 'group' AND scope_id = ?",
      params: [groupId],
    },
    { sql: "DELETE FROM person_group WHERE id = ?", params: [groupId] },
    ledger("group", groupId, now),
  ];
}

export function purgeThreadStatements(threadId: string, now: string): SqlStatement[] {
  return [
    { sql: "DELETE FROM plan_note WHERE thread_id = ?", params: [threadId] },
    { sql: "DELETE FROM receipt_unsent WHERE thread_id = ?", params: [threadId] },
    {
      sql: "DELETE FROM verified_request_token WHERE request_id IN (SELECT id FROM verified_request WHERE thread_id = ?)",
      params: [threadId],
    },
    {
      sql: "DELETE FROM verified_request_answer WHERE request_id IN (SELECT id FROM verified_request WHERE thread_id = ?)",
      params: [threadId],
    },
    { sql: "DELETE FROM verified_request WHERE thread_id = ?", params: [threadId] },
    {
      sql: "DELETE FROM plan_vote WHERE plan_id IN (SELECT id FROM plan WHERE thread_id = ?)",
      params: [threadId],
    },
    {
      sql: "DELETE FROM plan_event WHERE plan_id IN (SELECT id FROM plan WHERE thread_id = ?)",
      params: [threadId],
    },
    // Answers and replacements point between the thread's own plans: unlink, then delete.
    {
      sql: "UPDATE plan SET answers_id = NULL, replaced_by = NULL WHERE thread_id = ?",
      params: [threadId],
    },
    { sql: "DELETE FROM plan WHERE thread_id = ?", params: [threadId] },
    { sql: "DELETE FROM plan_thread_member WHERE thread_id = ?", params: [threadId] },
    { sql: "DELETE FROM plan_thread WHERE id = ?", params: [threadId] },
    ledger("thread", threadId, now),
  ];
}

const STATEMENTS: Readonly<Record<PurgeKind, (id: string, now: string) => SqlStatement[]>> = {
  event: purgeEventStatements,
  group: purgeGroupStatements,
  thread: purgeThreadStatements,
};

/**
 * Purge an event, group or thread now. An event still mirrored into someone's calendar
 * (a projection not yet 'deleted', MVP-4) is not purged — its mirrors would be orphaned
 * as unmanaged copies — and the answer says so; nothing exists to mirror before MVP-4.
 */
export async function purge(
  storage: StoragePort,
  kind: PurgeKind,
  id: string,
  now: string,
): Promise<{ readonly kind: "purged" | "mirrored" }> {
  if (kind === "event") {
    const live = await storage.query({
      sql: "SELECT 1 FROM projection WHERE canonical_event_id = ? AND state <> 'deleted' LIMIT 1",
      params: [id],
    });
    if (live.length > 0) return { kind: "mirrored" };
  }
  await storage.batch(STATEMENTS[kind](id, now));
  return { kind: "purged" };
}

/**
 * Garbage collection (rc21): an event nobody can edit any more, and a group or thread
 * with nobody in it, is purged. Called after anyone leaves; returns what went.
 */
export async function collect(
  storage: StoragePort,
  candidates: {
    readonly events?: readonly string[];
    readonly groups?: readonly string[];
    readonly threads?: readonly string[];
  },
  now: string,
): Promise<{ readonly events: string[]; readonly groups: string[]; readonly threads: string[] }> {
  const gone = { events: [] as string[], groups: [] as string[], threads: [] as string[] };
  const orphan = async (sql: string, id: string) =>
    (await storage.query({ sql, params: [id] })).length > 0;
  for (const id of candidates.events ?? []) {
    const noEditor = await orphan(
      `SELECT 1 FROM canonical_event e WHERE e.id = ? AND NOT EXISTS
         (SELECT 1 FROM event_participation ep WHERE ep.canonical_event_id = e.id AND ep.edit_tier = 'edit')`,
      id,
    );
    if (noEditor && (await purge(storage, "event", id, now)).kind === "purged")
      gone.events.push(id);
  }
  for (const id of candidates.groups ?? []) {
    const empty = await orphan(
      `SELECT 1 FROM person_group g WHERE g.id = ? AND NOT EXISTS
         (SELECT 1 FROM group_member m WHERE m.group_id = g.id)`,
      id,
    );
    if (empty) {
      await purge(storage, "group", id, now);
      gone.groups.push(id);
    }
  }
  for (const id of candidates.threads ?? []) {
    const empty = await orphan(
      `SELECT 1 FROM plan_thread t WHERE t.id = ? AND NOT EXISTS
         (SELECT 1 FROM plan_thread_member m WHERE m.thread_id = t.id)`,
      id,
    );
    if (empty) {
      await purge(storage, "thread", id, now);
      gone.threads.push(id);
    }
  }
  return gone;
}

const ledgerRowSchema = z.object({
  kind: z.enum(["person", "event", "group", "thread"]),
  id: z.string(),
});

/**
 * After a restore from backup: purge again whatever the ledger says was purged and is
 * back. Persons are re-erased by erasure.ts (R3); this handles the containers. Run before
 * the instance serves (DESIGN §10 rc21 *the backup tail*).
 */
export async function reapplyLedger(storage: StoragePort, now: string): Promise<number> {
  const rows = (
    await storage.query({ sql: "SELECT kind, id FROM erasure_ledger", params: [] })
  ).map((r) => ledgerRowSchema.parse(r));
  const present: Readonly<Record<PurgeKind, string>> = {
    event: "SELECT 1 FROM canonical_event WHERE id = ?",
    group: "SELECT 1 FROM person_group WHERE id = ?",
    thread: "SELECT 1 FROM plan_thread WHERE id = ?",
  };
  let again = 0;
  for (const r of rows) {
    if (r.kind === "person") continue;
    if ((await storage.query({ sql: present[r.kind], params: [r.id] })).length === 0) continue;
    if ((await purge(storage, r.kind, r.id, now)).kind === "purged") again += 1;
  }
  return again;
}

// --- Retention (DESIGN §10 rc21 *Retention*) ------------------------------------------
// The cron's purge pass runs this hourly (retention.ts `isRetentionHour`): past events
// and plans, then rows whose time is up. Chunked, and with nothing due it only reads
// (§16). Nothing here needs the ledger to survive a restore: a restored row that was
// due is still due, and the next pass takes it again. Events go through purge() anyway,
// which ledgers them.

/** Events and plans purged per pass; candidates read per pass, at most. */
export const RETENTION_CHUNK = 50;
export const RETENTION_SCAN = 1000;
const PAGE = 100;

/** A plan and what hangs off it. Plans point at each other: unlink, then delete. */
export function purgePlanStatements(planId: string): SqlStatement[] {
  return [
    { sql: "DELETE FROM plan_vote WHERE plan_id = ?", params: [planId] },
    { sql: "DELETE FROM plan_event WHERE plan_id = ?", params: [planId] },
    { sql: "UPDATE plan SET answers_id = NULL WHERE answers_id = ?", params: [planId] },
    { sql: "UPDATE plan SET replaced_by = NULL WHERE replaced_by = ?", params: [planId] },
    { sql: "DELETE FROM plan WHERE id = ?", params: [planId] },
  ];
}

const eventRowSchema = z.object({
  id: z.string(),
  start_local: z.string(),
  end_local: z.string(),
  all_day: z.number(),
  tzid: z.string().nullable(),
  rrule: z.string().nullable(),
  status: z.string(),
  updated_at: z.string(),
  retain_days: z.number(),
});

/**
 * Past events, by retention.ts. The SQL only narrows, never further than the rule: an
 * event can't be due before its start (or, cancelled, the day it was cancelled) is older
 * than its period, and a series with no end that isn't cancelled never is. Keyset paging, so events that aren't due yet never crowd out ones that are.
 */
async function pastEvents(storage: StoragePort, now: string): Promise<string[]> {
  const due: string[] = [];
  let after = "";
  for (let read = 0; read < RETENTION_SCAN && due.length < RETENTION_CHUNK; read += PAGE) {
    const rows = await storage.query({
      sql: `SELECT id, start_local, end_local, all_day, tzid, rrule, status, updated_at, retain_days
            FROM canonical_event
            WHERE id > ?
              AND (substr(start_local, 1, 10) < date(?, '-' || (retain_days + 1) || ' days')
                   OR (status = 'cancelled'
                       AND substr(updated_at, 1, 10) < date(?, '-' || (retain_days + 1) || ' days')))
              AND (rrule IS NULL OR instr(rrule, 'COUNT=') > 0 OR instr(rrule, 'UNTIL=') > 0
                   OR status = 'cancelled')
            ORDER BY id LIMIT ?`,
      params: [after, now, now, PAGE],
    });
    for (const r of rows) {
      const e = eventRowSchema.parse(r);
      after = e.id;
      const isDue = isEventDue(
        {
          startLocal: e.start_local,
          endLocal: e.end_local,
          allDay: e.all_day === 1,
          tzid: e.tzid,
          rrule: e.rrule,
          status: e.status,
          updatedAt: e.updated_at,
          retainDays: e.retain_days,
        },
        now,
      );
      if (isDue && due.length < RETENTION_CHUNK) due.push(e.id);
    }
    if (rows.length < PAGE) break;
  }
  return due;
}

const planRowSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  last_end: z.string().nullable(),
  all_day: z.number().nullable(),
  live: z.number(),
});

async function pastPlans(storage: StoragePort, now: string): Promise<string[]> {
  const rows = await storage.query({
    sql: `SELECT p.id, p.created_at, max(pe.end_local) AS last_end, max(pe.all_day) AS all_day,
                 count(pe.canonical_event_id) AS live
          FROM plan p LEFT JOIN plan_event pe ON pe.plan_id = p.id
          GROUP BY p.id
          HAVING live = 0
             -- An all-day end is exclusive, so this narrows a day less than the rule.
             AND coalesce(substr(max(pe.end_local), 1, 10), substr(p.created_at, 1, 10))
                 < date(?, ?)
          ORDER BY p.id LIMIT ?`,
    params: [now, `-${DEFAULT_RETAIN_DAYS} days`, RETENTION_CHUNK],
  });
  return rows
    .map((r) => planRowSchema.parse(r))
    .filter((p) =>
      isPlanDue(
        {
          lastEndLocal: p.last_end,
          allDay: p.all_day === 1,
          createdAt: p.created_at,
          liveEvents: p.live,
        },
        now,
      ),
    )
    .map((p) => p.id);
}

/**
 * Rows whose time is up, within a day: sign-in links (every address ever typed into the
 * form), sessions, answer and vote links and invites a day after they expire or were revoked —
 * the day keeps the per-address and per-group rate windows whole — mail_send rows from
 * before this month (the cap counts this month only), opt-out links once they expire
 * (they hold the address; rc24), notes on days past their
 * retention, and the erasure ledger after the backup window. One read says which have
 * anything to delete; only those statements run.
 */
async function expired(storage: StoragePort, now: string): Promise<number> {
  const dayAgo = cutoff(now, 1);
  const month = now.slice(0, 7);
  const ledgerBefore = cutoff(now, LEDGER_KEEP_DAYS);
  const sweeps: readonly { readonly flag: string; readonly stmt: SqlStatement }[] = [
    {
      flag: "login",
      stmt: { sql: "DELETE FROM login_token WHERE expires_at < ?", params: [dayAgo] },
    },
    {
      flag: "session",
      stmt: {
        sql: "DELETE FROM session WHERE expires_at < ? OR revoked_at < ?",
        params: [dayAgo, dayAgo],
      },
    },
    {
      flag: "answer",
      stmt: { sql: "DELETE FROM response_token WHERE expires_at < ?", params: [dayAgo] },
    },
    {
      flag: "vote",
      stmt: { sql: "DELETE FROM plan_vote_token WHERE expires_at < ?", params: [dayAgo] },
    },
    {
      flag: "share",
      stmt: { sql: "DELETE FROM share_link WHERE expires_at < ?", params: [dayAgo] },
    },
    {
      flag: "invite",
      stmt: { sql: "DELETE FROM group_invite WHERE expires_at < ?", params: [dayAgo] },
    },
    { flag: "mail", stmt: { sql: "DELETE FROM mail_send WHERE month < ?", params: [month] } },
    {
      flag: "optout",
      stmt: { sql: "DELETE FROM opt_out_token WHERE expires_at < ?", params: [now] },
    },
    {
      flag: "note",
      stmt: {
        sql: "DELETE FROM plan_note WHERE last_day < date(?, ?)",
        params: [now, `-${DEFAULT_RETAIN_DAYS + 1} days`],
      },
    },
    {
      flag: "ledger",
      stmt: { sql: "DELETE FROM erasure_ledger WHERE erased_at < ?", params: [ledgerBefore] },
    },
  ];
  const [flags] = await storage.query({
    sql: `SELECT
            EXISTS (SELECT 1 FROM login_token WHERE expires_at < ?) AS login,
            EXISTS (SELECT 1 FROM session WHERE expires_at < ? OR revoked_at < ?) AS session,
            EXISTS (SELECT 1 FROM response_token WHERE expires_at < ?) AS answer,
            EXISTS (SELECT 1 FROM plan_vote_token WHERE expires_at < ?) AS vote,
            EXISTS (SELECT 1 FROM share_link WHERE expires_at < ?) AS share,
            EXISTS (SELECT 1 FROM group_invite WHERE expires_at < ?) AS invite,
            EXISTS (SELECT 1 FROM mail_send WHERE month < ?) AS mail,
            EXISTS (SELECT 1 FROM opt_out_token WHERE expires_at < ?) AS optout,
            EXISTS (SELECT 1 FROM plan_note WHERE last_day < date(?, ?)) AS note,
            EXISTS (SELECT 1 FROM erasure_ledger WHERE erased_at < ?) AS ledger`,
    params: [
      dayAgo,
      dayAgo,
      dayAgo,
      dayAgo,
      dayAgo,
      dayAgo,
      dayAgo,
      month,
      now,
      now,
      `-${DEFAULT_RETAIN_DAYS + 1} days`,
      ledgerBefore,
    ],
  });
  const due = sweeps.filter((s) => flags?.[s.flag] === 1).map((s) => s.stmt);
  if (due.length > 0) await storage.batch(due);
  return due.length;
}

/** What one retention pass removed. */
export interface Retained {
  readonly events: number;
  readonly plans: number;
  readonly sweeps: number;
}

export async function retentionPass(storage: StoragePort, now: string): Promise<Retained> {
  let events = 0;
  for (const id of await pastEvents(storage, now)) {
    if ((await purge(storage, "event", id, now)).kind === "purged") events += 1;
  }
  const plans = await pastPlans(storage, now);
  for (const id of plans) await storage.batch(purgePlanStatements(id));
  return { events, plans: plans.length, sweeps: await expired(storage, now) };
}
