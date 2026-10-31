// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { SqlStatement, StoragePort } from "../db/port.js";

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
    { sql: "DELETE FROM person_group WHERE id = ?", params: [groupId] },
    ledger("group", groupId, now),
  ];
}

export function purgeThreadStatements(threadId: string, now: string): SqlStatement[] {
  return [
    { sql: "DELETE FROM plan_note WHERE thread_id = ?", params: [threadId] },
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
