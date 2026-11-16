// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { type StoragePort, stmt } from "../db/port.js";
import { resolveInvitees } from "../events/participation.js";
import { uuidv7 } from "../ids.js";
import { findGroupForMember } from "../people/group.js";
import { ASK_DRAFT_KEEP_DAYS } from "../privacy/retention.js";

export { ASK_DRAFT_KEEP_DAYS };

import { MAX_OPTION_EVENTS, MAX_OPTIONS, questionThreadStatements } from "./plan.js";

// An unsent Ask when question (DESIGN §10 *Asking when*, rc46, slice A2). The page saves the
// whole question on every change; nobody but its author can see it. Asking turns it into a
// thread with its options on the table (questionThreadStatements) and removes the draft: it is
// claimed in one statement first, so it is asked once, never twice.

/** Most addresses one question names, as the poll form. */
export const MAX_ASK_EMAILS = 50;

const eventSchema = z.object({
  allDay: z.boolean(),
  startLocal: z.string().max(19),
  endLocal: z.string().max(19),
});

/** A draft's body, as stored: zod-checked on every read, and on every save. */
export const askBodySchema = z.object({
  title: z.string().max(200),
  location: z.string().max(200).nullable(),
  note: z.string().max(2000).nullable(),
  tzid: z.string().max(64).nullable(),
  /** In order: their letters follow it. Each is one event, or several ("+ and"). */
  options: z.array(z.array(eventSchema).max(MAX_OPTION_EVENTS)).max(MAX_OPTIONS),
  /** People named by address, as typed; a group's people come from the group. */
  emails: z.array(z.string().max(320)).max(MAX_ASK_EMAILS),
});
export type AskBody = z.infer<typeof askBodySchema>;

export const EMPTY_ASK: AskBody = {
  title: "",
  location: null,
  note: null,
  tzid: null,
  options: [],
  emails: [],
};

export interface AskDraft {
  readonly id: string;
  readonly groupId: string | null;
  readonly body: AskBody;
  readonly updatedAt: string;
}

const rowSchema = z.object({
  id: z.string(),
  group_id: z.string().nullable(),
  body: z.string(),
  updated_at: z.string(),
});

function toDraft(raw: unknown): AskDraft | null {
  const r = rowSchema.parse(raw);
  let json: unknown;
  try {
    json = JSON.parse(r.body);
  } catch {
    return null;
  }
  const body = askBodySchema.safeParse(json);
  return body.success
    ? { id: r.id, groupId: r.group_id, body: body.data, updatedAt: r.updated_at }
    : null;
}

/** Start a draft, asked of a group if one is given (its membership proven here). */
export async function startAskDraft(
  storage: StoragePort,
  input: {
    readonly authorId: string;
    readonly groupId: string | null;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<AskDraft | null> {
  if (
    input.groupId !== null &&
    (await findGroupForMember(storage, input.groupId, input.authorId)) === null
  )
    return null;
  const id = (input.newId ?? uuidv7)();
  await storage.batch([
    stmt(
      `INSERT INTO ask_draft (id, author_id, group_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.authorId,
      input.groupId,
      JSON.stringify(EMPTY_ASK),
      input.now,
      input.now,
    ),
  ]);
  return { id, groupId: input.groupId, body: EMPTY_ASK, updatedAt: input.now };
}

/** The author's own draft, or null: nobody else's is ever found, whatever its id. */
export async function findAskDraft(
  storage: StoragePort,
  input: { readonly id: string; readonly authorId: string },
): Promise<AskDraft | null> {
  const [row] = await storage.query(
    stmt(
      "SELECT id, group_id, body, updated_at FROM ask_draft WHERE id = ? AND author_id = ?",
      input.id,
      input.authorId,
    ),
  );
  return row === undefined ? null : toDraft(row);
}

/** Save the whole question: one write, the body checked first. False when it isn't theirs. */
export async function saveAskDraft(
  storage: StoragePort,
  input: {
    readonly id: string;
    readonly authorId: string;
    readonly body: AskBody;
    readonly now: string;
  },
): Promise<boolean> {
  const body = askBodySchema.parse(input.body);
  const saved = await storage.query(
    stmt(
      `UPDATE ask_draft SET body = ?, updated_at = ? WHERE id = ? AND author_id = ?
       RETURNING id`,
      JSON.stringify(body),
      input.now,
      input.id,
      input.authorId,
    ),
  );
  return saved.length > 0;
}

/** The author's unsent questions, most recently touched first, for home. */
export async function listAskDrafts(storage: StoragePort, authorId: string): Promise<AskDraft[]> {
  return (
    await storage.query(
      stmt(
        `SELECT id, group_id, body, updated_at FROM ask_draft WHERE author_id = ?
         ORDER BY updated_at DESC, id DESC`,
        authorId,
      ),
    )
  ).flatMap((r) => {
    const d = toDraft(r);
    return d === null ? [] : [d];
  });
}

/** Throw the draft away: only the author's. */
export async function discardAskDraft(
  storage: StoragePort,
  input: { readonly id: string; readonly authorId: string },
): Promise<boolean> {
  const gone = await storage.query(
    stmt(
      "DELETE FROM ask_draft WHERE id = ? AND author_id = ? RETURNING id",
      input.id,
      input.authorId,
    ),
  );
  return gone.length > 0;
}

/**
 * Ask it (rc46): the thread, its options on the table and its people, and the draft gone, in
 * one batch. The draft's checks are made again here — the group still theirs, the times
 * valid, the addresses not opted out — and any refusal throws as the poll form's do.
 */
export async function askDraft(
  storage: StoragePort,
  input: {
    readonly id: string;
    readonly authorId: string;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<{ readonly threadId: string; readonly planIds: readonly string[] } | null> {
  const draft = await findAskDraft(storage, input);
  if (draft === null) return null;
  const group =
    draft.groupId === null
      ? null
      : await findGroupForMember(storage, draft.groupId, input.authorId);
  if (draft.groupId !== null && group === null) return null;
  const { body } = draft;
  const people = await resolveInvitees(
    storage,
    body.emails.map((email) => ({ email, editTier: "view", visibility: "FULL" })),
    { now: input.now, from: { senderId: input.authorId, groupId: draft.groupId } },
  );
  const { threadId, planIds, statements } = await questionThreadStatements(storage, {
    creatorId: input.authorId,
    group,
    fields: {
      title: body.title,
      location: body.location,
      description: body.note,
      tzid: body.tzid,
    },
    options: body.options,
    people: people.map((p) => p.personId),
    now: input.now,
    ...(input.newId === undefined ? {} : { newId: input.newId }),
  });
  // Claimed in one statement only now, every check passed: two presses at once make one
  // thread — the second finds nothing to claim. If the write then fails, it is put back.
  const claimed = await storage.query(
    stmt(
      "DELETE FROM ask_draft WHERE id = ? AND author_id = ? RETURNING created_at",
      input.id,
      input.authorId,
    ),
  );
  const [row] = claimed;
  if (row === undefined) return null;
  try {
    await storage.batch(statements);
  } catch (error) {
    await storage.batch([
      stmt(
        `INSERT INTO ask_draft (id, author_id, group_id, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        draft.id,
        input.authorId,
        draft.groupId,
        JSON.stringify(body),
        String(row.created_at),
        draft.updatedAt,
      ),
    ]);
    throw error;
  }
  return { threadId, planIds };
}
