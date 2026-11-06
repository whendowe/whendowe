// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StoragePort } from "../../src/db/port.js";

// What an event-poll left behind (MVP-2 slice 2C, removed in rc35): candidate times and
// slot_response votes. Nothing writes them any more, but the rows stay until their event
// is purged, so erasure, removal, export and purge must still handle them. This writes
// them as the old code did, for those tests.

/** One candidate time on an event, and each voter's answer to it. */
export async function leftoverPollVotes(
  port: StoragePort,
  eventId: string,
  votes: readonly { readonly personId: string; readonly answer: "yes" | "ifneedbe" | "no" }[],
  now: string,
): Promise<void> {
  await port.batch([
    {
      sql: `INSERT INTO event_candidate (canonical_event_id, slot_index, all_day, start_local, end_local, tzid)
            VALUES (?, 0, 0, '2101-11-21T18:00', '2101-11-21T20:00', 'Europe/Prague')`,
      params: [eventId],
    },
    ...votes.map((v) => ({
      sql: `INSERT INTO slot_response (canonical_event_id, slot_index, person_id, answer, responded_at)
            VALUES (?, 0, ?, ?, ?)`,
      params: [eventId, v.personId, v.answer, now],
    })),
  ]);
}
