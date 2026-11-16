// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { type StoragePort, stmt } from "./db/port.js";
import { uuidv7 } from "./ids.js";

// A minute to take it back (DESIGN §10 *Asking when*, rc46, slice A0). An action that mails
// other people is held for a minute instead of done at once. While it waits, nothing anyone
// else sees has changed, so Undo is a delete. The scheduled pass claims what is due — from
// then on Undo is gone — and runs it at most once: a crash after the claim loses the action
// rather than sending it twice. What happened is kept for the actor to read for a day; the
// purge pass then removes it.
//
// This module is platform-blind and knows no kind's meaning: each kind's runner is built by
// the layer that can send mail and handed to runDueHeld as a port.

/** How long an action waits before the pass may take it. */
export const HOLD_MS = 60_000;
/** How long what happened stays on the page for the actor. */
export const SHOWN_MS = 24 * 60 * 60 * 1000;
/** At most this many actions per pass; the rest wait for the next minute. */
export const PASS_LIMIT = 20;

export const heldKindSchema = z.enum(["vote_links", "choose"]);
export type HeldKind = z.infer<typeof heldKindSchema>;

export interface HeldAction {
  readonly id: string;
  readonly kind: HeldKind;
  readonly threadId: string | null;
  readonly dueAt: string;
  /** Set once a pass has claimed it: Undo is gone. */
  readonly takenAt: string | null;
  /** What happened, once it has run. */
  readonly outcome: string | null;
  /** Its arguments, as stored: what the page says it is about (a chosen plan's id). */
  readonly args: unknown;
}

/** What a runner gets: the action, its actor and its arguments, unparsed — the runner checks them. */
export interface DueAction {
  readonly id: string;
  readonly actorId: string;
  readonly threadId: string | null;
  readonly args: unknown;
  readonly now: string;
}

/**
 * Runs one kind, re-making the checks its button made: the world may have changed in the
 * minute. Returns the line the actor will read. Never throws for a refusal — that is a line
 * too; a throw is a failure the pass reports in its own words.
 */
export type HeldRunner = (action: DueAction) => Promise<string>;
export type HeldRunners = Readonly<Record<HeldKind, HeldRunner>>;

/** The line shown when a runner failed: its error may hold anything, so it is never shown. */
export const FAILED_OUTCOME =
  "It couldn't be done: something went wrong. Nothing more will be tried.";

const rowSchema = z.object({
  id: z.string(),
  kind: heldKindSchema,
  args: z.string(),
  thread_id: z.string().nullable(),
  due_at: z.string(),
  taken_at: z.string().nullable(),
  outcome: z.string().nullable(),
});

/** A row of a kind this version knows, or null for one it doesn't: it is left alone (rc46). */
function toAction(raw: unknown): HeldAction | null {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    id: r.id,
    kind: r.kind,
    threadId: r.thread_id,
    dueAt: r.due_at,
    takenAt: r.taken_at,
    outcome: r.outcome,
    args: parseArgs(r.args),
  };
}

function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const COLUMNS = "id, kind, thread_id, due_at, taken_at, outcome, args";

/**
 * Hold an action for a minute. Pressing the same button again while one is waiting holds
 * nothing new: the waiting one is returned, so a double press can't mail people twice.
 */
export async function holdAction(
  storage: StoragePort,
  input: {
    readonly actorId: string;
    readonly threadId: string | null;
    readonly kind: HeldKind;
    readonly args?: unknown;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<HeldAction> {
  const due = new Date(Date.parse(input.now) + HOLD_MS).toISOString();
  await storage.batch([
    stmt(
      `INSERT INTO held_action (id, actor_id, thread_id, kind, args, due_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM held_action WHERE actor_id = ? AND kind = ?
                           AND thread_id IS ? AND taken_at IS NULL)`,
      (input.newId ?? uuidv7)(),
      input.actorId,
      input.threadId,
      input.kind,
      JSON.stringify(input.args ?? {}),
      due,
      input.now,
      input.actorId,
      input.kind,
      input.threadId,
    ),
  ]);
  const [row] = await storage.query(
    stmt(
      `SELECT ${COLUMNS} FROM held_action
        WHERE actor_id = ? AND kind = ? AND thread_id IS ? AND taken_at IS NULL`,
      input.actorId,
      input.kind,
      input.threadId,
    ),
  );
  const held = toAction(row);
  if (held === null) throw new Error("a held action just written could not be read back");
  return held;
}

/**
 * Undo a held action: only its actor's, only while no pass has taken it. `too_late` means a
 * pass took it first — the page then shows what happened. `absent`: not theirs, or gone.
 */
export async function undoHeld(
  storage: StoragePort,
  input: { readonly id: string; readonly actorId: string },
): Promise<"undone" | "too_late" | "absent"> {
  const deleted = await storage.query(
    stmt(
      `DELETE FROM held_action WHERE id = ? AND actor_id = ? AND taken_at IS NULL
       RETURNING id`,
      input.id,
      input.actorId,
    ),
  );
  if (deleted.length > 0) return "undone";
  const [taken] = await storage.query(
    stmt("SELECT 1 AS ok FROM held_action WHERE id = ? AND actor_id = ?", input.id, input.actorId),
  );
  return taken === undefined ? "absent" : "too_late";
}

/** The actor's actions on a thread that are waiting, running, or ran within the last day. */
export async function heldOn(
  storage: StoragePort,
  input: { readonly actorId: string; readonly threadId: string; readonly now: string },
): Promise<HeldAction[]> {
  const since = new Date(Date.parse(input.now) - SHOWN_MS).toISOString();
  return (
    await storage.query(
      stmt(
        `SELECT ${COLUMNS} FROM held_action
          WHERE actor_id = ? AND thread_id = ? AND (taken_at IS NULL OR taken_at >= ?)
          ORDER BY created_at, id`,
        input.actorId,
        input.threadId,
        since,
      ),
    )
  ).flatMap((r) => {
    const held = toAction(r);
    return held === null ? [] : [held];
  });
}

const dueSchema = z.object({
  id: z.string(),
  actor_id: z.string(),
  thread_id: z.string().nullable(),
  kind: heldKindSchema,
  args: z.string(),
});

/**
 * Run what is due, oldest first, at most PASS_LIMIT. With nothing due this is one indexed
 * read and no write (§6). Each action is claimed in one guarded statement before it runs,
 * so two passes never run the same one. Returns how many ran.
 */
export async function runDueHeld(
  storage: StoragePort,
  runners: HeldRunners,
  now: string,
): Promise<number> {
  const due = (
    await storage.query(
      stmt(
        `SELECT id, actor_id, thread_id, kind, args FROM held_action
          WHERE taken_at IS NULL AND due_at <= ? ORDER BY due_at, id LIMIT ?`,
        now,
        PASS_LIMIT,
      ),
    )
  ).flatMap((r) => {
    // A kind this version doesn't know is left for the version that does (rc46).
    const parsed = dueSchema.safeParse(r);
    return parsed.success ? [parsed.data] : [];
  });
  let ran = 0;
  for (const row of due) {
    const claimed = await storage.query(
      stmt(
        "UPDATE held_action SET taken_at = ? WHERE id = ? AND taken_at IS NULL RETURNING id",
        now,
        row.id,
      ),
    );
    if (claimed.length === 0) continue; // undone, or another pass took it
    let outcome: string;
    try {
      outcome = await runners[row.kind]({
        id: row.id,
        actorId: row.actor_id,
        threadId: row.thread_id,
        args: parseArgs(row.args),
        now,
      });
    } catch {
      outcome = FAILED_OUTCOME;
    }
    await storage.batch([stmt("UPDATE held_action SET outcome = ? WHERE id = ?", outcome, row.id)]);
    ran += 1;
  }
  return ran;
}
