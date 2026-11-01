// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { FEEDBACK_MAX_LENGTH, FEEDBACK_PER_PERSON_PER_EVENT } from "../events/response.js";
import { uuidv7 } from "../ids.js";
import { listPlans, PlanInputError } from "./plan.js";
import type { ThreadAccess } from "./thread.js";
import { lastDay } from "./weeks.js";

// Notes on days (DESIGN §10 Plans P5; rc28 its first slice: a note with a vote). A note
// needs no agreement, only attribution: it never changes a vote or a plan. A vote note is
// public and lies on the days from the first to the last time on the table when it was
// written. Private notes and notes drawn on the week rows are the rest of P5.

export interface PlanNote {
  readonly id: string;
  readonly authorId: string;
  /** Inclusive dates: a note is "on" days, not at times. */
  readonly firstDay: string;
  readonly lastDay: string;
  readonly body: string;
  readonly createdAt: string;
}

export type NoteResult =
  | { readonly kind: "added"; readonly id: string }
  /** Nothing is on the table, so there are no days for it to be on. */
  | { readonly kind: "closed" };

/** Add a public note on the days of what is on the table now. Throws PlanInputError for a bad body. */
export async function addVoteNote(
  storage: StoragePort,
  access: ThreadAccess,
  input: { readonly body: string; readonly now: string; readonly newId?: () => string },
): Promise<NoteResult> {
  const body = input.body.trim();
  if (body === "") throw new PlanInputError("Write something first.");
  if (body.length > FEEDBACK_MAX_LENGTH)
    throw new PlanInputError(`Keep it under ${FEEDBACK_MAX_LENGTH} characters.`);
  const events = (await listPlans(storage, access))
    .filter((p) => p.status === "on_table")
    .flatMap((p) => p.events);
  if (events.length === 0) return { kind: "closed" };
  const first = events.map((e) => e.startLocal.slice(0, 10)).sort()[0] ?? "";
  const last = events.map(lastDay).sort().at(-1) ?? first;
  const [count] = await storage.query({
    sql: "SELECT count(*) AS n FROM plan_note WHERE thread_id = ? AND author_id = ?",
    params: [access.thread.id, access.personId],
  });
  if (Number(count?.n ?? 0) >= FEEDBACK_PER_PERSON_PER_EVENT)
    throw new PlanInputError("That's a lot of notes already — perhaps edit the plan instead.");
  const id = (input.newId ?? (() => uuidv7()))();
  await storage.batch([
    {
      sql: `INSERT INTO plan_note (id, thread_id, author_id, first_day, last_day, body, private, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      params: [id, access.thread.id, access.personId, first, last, body, input.now],
    },
  ]);
  return { kind: "added", id };
}

const noteRowSchema = z.object({
  id: z.string(),
  author_id: z.string(),
  first_day: z.string(),
  last_day: z.string(),
  body: z.string(),
  created_at: z.string(),
});

/** The thread's notes this person may see — public ones, and their own private ones — oldest first. */
export async function listNotes(storage: StoragePort, access: ThreadAccess): Promise<PlanNote[]> {
  const rows = await storage.query({
    sql: `SELECT id, author_id, first_day, last_day, body, created_at FROM plan_note
          WHERE thread_id = ? AND (private = 0 OR author_id = ?)
          ORDER BY created_at, id`,
    params: [access.thread.id, access.personId],
  });
  return rows.map((row) => {
    const r = noteRowSchema.parse(row);
    return {
      id: r.id,
      authorId: r.author_id,
      firstDay: r.first_day,
      lastDay: r.last_day,
      body: r.body,
      createdAt: r.created_at,
    };
  });
}

/** Whether a note lies on any of these days (inclusive ranges overlap). */
export function noteTouches(note: PlanNote, firstDay: string, lastDay: string): boolean {
  return note.firstDay <= lastDay && firstDay <= note.lastDay;
}
