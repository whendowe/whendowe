// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { diff } from "../changelog.js";
import type { SqlStatement, StoragePort } from "../db/port.js";
import { type EventFieldsInput, eventFieldsSchema, flatten } from "../events/event.js";
import { groupDefaults } from "../events/participation.js";
import {
  type Answer,
  answerSchema,
  type CandidateTimeInput,
  PollInputError,
  validateCandidates,
} from "../events/poll.js";
import { type Arrival, arrivalOf } from "../events/response.js";
import { uuidv7 } from "../ids.js";
import type { GroupMembership } from "../people/group.js";
import { type PlanEventLike, sameTime } from "./diff.js";
import {
  deciders,
  decidesByConsensus,
  memberName,
  type ThreadAccess,
  threadStatements,
} from "./thread.js";

// Plans (DESIGN §10 rc19, slice P1): several events proposed, compared and accepted as
// one. Every operation takes the ThreadAccess that findThreadForMember returned, so no
// caller can reach a plan in a thread it isn't in; a draft is further limited to its
// author by every statement that touches it.
//
// Votes are attributed rows of their own (plan_vote), guarded by the plan's status in
// the same statement, exactly as poll votes are (§10 rc12).

const statusSchema = z.enum(["draft", "on_table", "accepted", "replaced", "withdrawn"]);
export type PlanStatus = z.infer<typeof statusSchema>;

/** A poll's place and notes, copied to each time it offers (rc26); null on drawn plans. */
export interface PlanEventDetails {
  readonly location: string | null;
  readonly description: string | null;
}

export interface PlanEvent extends PlanEventLike, PlanEventDetails {
  /** The scheduled event this became when its plan was accepted; null before. */
  readonly canonicalEventId: string | null;
}

export interface PlanVote {
  readonly personId: string;
  readonly answer: Answer;
  readonly respondedAt: string;
  /** How it arrived (rc42); null from before that was recorded. */
  readonly arrival: Arrival | null;
}

export interface Plan {
  readonly id: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly name: string;
  readonly message: string | null;
  readonly answersId: string | null;
  /** Drafted with "Plan the rest…": its header says "the rest of", not "changes to". */
  readonly restOf: boolean;
  readonly questionId: string;
  readonly status: PlanStatus;
  readonly replacedBy: string | null;
  /** The organizer who accepted it; null when it was accepted by consensus. */
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** In time order. */
  readonly events: readonly PlanEvent[];
  readonly votes: readonly PlanVote[];
  /** A, B, C… in the order plans were put on the table; null for a draft. */
  readonly letter: string | null;
}

export const MAX_PLAN_EVENTS = 60;
export const MAX_PLAN_NAME = 120;
export const MAX_MESSAGE = 1000;

/** A person-facing problem with what was asked (shown on the page, not a crash). */
export class PlanInputError extends Error {}

// --- pure helpers ---------------------------------------------------------------------

/** "A".."Z", then "AA".. — enough letters for any thread. */
export function letterFor(index: number): string {
  const n = Math.floor(index / 26);
  return (n > 0 ? letterFor(n - 1) : "") + String.fromCharCode(65 + (index % 26));
}

/** An event's time as a half-open interval of comparable keys (wall clock, thread zone). */
export function intervalOf(e: Pick<PlanEventLike, "allDay" | "startLocal" | "endLocal">): {
  readonly start: string;
  readonly end: string;
} {
  return e.allDay
    ? { start: `${e.startLocal}T00:00:00`, end: `${e.endLocal}T00:00:00` }
    : { start: e.startLocal, end: e.endLocal };
}

export function overlaps(
  a: Pick<PlanEventLike, "allDay" | "startLocal" | "endLocal">,
  b: Pick<PlanEventLike, "allDay" | "startLocal" | "endLocal">,
): boolean {
  const x = intervalOf(a);
  const y = intervalOf(b);
  return x.start < y.end && y.start < x.end;
}

/** The time a plan covers: its first start to its last end. Null for no events. */
export function spanOf(
  events: readonly Pick<PlanEventLike, "allDay" | "startLocal" | "endLocal">[],
): { readonly start: string; readonly end: string } | null {
  let start: string | null = null;
  let end: string | null = null;
  for (const e of events) {
    const i = intervalOf(e);
    if (start === null || i.start < start) start = i.start;
    if (end === null || i.end > end) end = i.end;
  }
  return start === null || end === null ? null : { start, end };
}

/**
 * The plans an accepted plan replaces (DESIGN §10 rc19): the others on the table in the
 * same question, or whose time overlaps its time. Plans for other weeks stay.
 */
export interface Alternative {
  readonly id: string;
  readonly questionId: string;
  readonly events: readonly PlanEventLike[];
}

export function alternativesOf(accepted: Alternative, onTable: readonly Alternative[]): string[] {
  const span = spanOf(accepted.events);
  return onTable
    .filter((p) => {
      if (p.id === accepted.id) return false;
      if (p.questionId === accepted.questionId) return true;
      const s = spanOf(p.events);
      return span !== null && s !== null && s.start < span.end && span.start < s.end;
    })
    .map((p) => p.id);
}

/** What is still open in a plan: its events that overlap nothing agreed ("Plan the rest…"). */
export function restOf<E extends PlanEventLike>(
  events: readonly E[],
  agreed: readonly PlanEventLike[],
): E[] {
  return events.filter((e) => !agreed.some((a) => overlaps(a, e)));
}

/** The base a plan is compared with, less the events already agreed exactly as they are. */
export function openBase<E extends PlanEventLike>(
  base: readonly E[],
  agreed: readonly PlanEventLike[],
): E[] {
  return base.filter((e) => !agreed.some((a) => a.sid === e.sid && sameTime(a, e)));
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * "Keep only these days" (keep = true) or "Drop these days" over first..last, both
 * inclusive dates. Whole-day stretches are clipped; a timed event goes by the day it
 * starts. A stretch cut in two keeps its sid on the first part; the second is new.
 */
export function clipDays<E extends PlanEventLike>(
  events: readonly E[],
  range: { readonly first: string; readonly last: string; readonly keep: boolean },
  newSid: () => string,
): E[] {
  const from = range.first <= range.last ? range.first : range.last;
  const to = range.first <= range.last ? range.last : range.first;
  const after = addDays(to, 1);
  const out: E[] = [];
  for (const e of events) {
    if (!e.allDay) {
      const day = e.startLocal.slice(0, 10);
      const inside = from <= day && day <= to;
      if (inside === range.keep) out.push(e);
      continue;
    }
    if (range.keep) {
      const s = e.startLocal > from ? e.startLocal : from;
      const t = e.endLocal < after ? e.endLocal : after;
      if (s < t) out.push({ ...e, startLocal: s, endLocal: t });
    } else {
      if (e.startLocal < from) {
        out.push({ ...e, endLocal: e.endLocal < from ? e.endLocal : from });
      }
      if (e.endLocal > after) {
        const s = e.startLocal > after ? e.startLocal : after;
        out.push({ ...e, sid: e.startLocal < from ? newSid() : e.sid, startLocal: s });
      }
    }
  }
  return out;
}

function byTime(a: PlanEventLike, b: PlanEventLike): number {
  const x = intervalOf(a);
  const y = intervalOf(b);
  if (x.start !== y.start) return x.start < y.start ? -1 : 1;
  if (x.end !== y.end) return x.end < y.end ? -1 : 1;
  return a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0;
}

// --- reading --------------------------------------------------------------------------

const planRowSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  author_id: z.string(),
  name: z.string(),
  message: z.string().nullable(),
  answers_id: z.string().nullable(),
  rest_of: z.number(),
  question_id: z.string(),
  status: statusSchema,
  replaced_by: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const eventRowSchema = z.object({
  plan_id: z.string(),
  sid: z.string(),
  title: z.string(),
  all_day: z.number(),
  start_local: z.string(),
  end_local: z.string(),
  who: z.string(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  canonical_event_id: z.string().nullable(),
});

const whoSchema = z.array(z.string());

const voteRowSchema = z.object({
  plan_id: z.string(),
  person_id: z.string(),
  answer: answerSchema,
  responded_at: z.string(),
  answered_via: z.string().nullable(),
  answered_via_by: z.string().nullable(),
});

const PLAN_COLUMNS = `p.id, p.thread_id, p.author_id, p.name, p.message, p.answers_id, p.rest_of,
  p.question_id, p.status, p.replaced_by, p.decided_by, p.decided_at, p.sent_at, p.created_at,
  p.updated_at`;

function toPlanEvent(row: z.infer<typeof eventRowSchema>): PlanEvent {
  return {
    sid: row.sid,
    title: row.title,
    allDay: row.all_day === 1,
    startLocal: row.start_local,
    endLocal: row.end_local,
    who: whoSchema.parse(JSON.parse(row.who)),
    location: row.location,
    description: row.description,
    canonicalEventId: row.canonical_event_id,
  };
}

/**
 * Every plan in the thread this person may see: all sent plans, in the order they were
 * put on the table (which gives them their letters), then this person's draft if any.
 * Nobody else's draft, ever.
 */
export async function listPlans(storage: StoragePort, access: ThreadAccess): Promise<Plan[]> {
  const scope = `p.thread_id = ? AND (p.status <> 'draft' OR p.author_id = ?)`;
  const params = [access.thread.id, access.personId];
  const plans = (
    await storage.query({
      sql: `SELECT ${PLAN_COLUMNS} FROM plan p WHERE ${scope}
            ORDER BY p.status = 'draft', p.sent_at, p.id`,
      params,
    })
  ).map((row) => planRowSchema.parse(row));
  const events = (
    await storage.query({
      sql: `SELECT e.plan_id, e.sid, e.title, e.all_day, e.start_local, e.end_local, e.who,
              e.location, e.description, e.canonical_event_id
            FROM plan_event e JOIN plan p ON p.id = e.plan_id WHERE ${scope}`,
      params,
    })
  ).map((row) => eventRowSchema.parse(row));
  const votes = (
    await storage.query({
      sql: `SELECT v.plan_id, v.person_id, v.answer, v.responded_at, v.answered_via, v.answered_via_by
            FROM plan_vote v JOIN plan p ON p.id = v.plan_id WHERE ${scope}`,
      params,
    })
  ).map((row) => voteRowSchema.parse(row));

  let sent = 0;
  return plans.map((p) => ({
    id: p.id,
    threadId: p.thread_id,
    authorId: p.author_id,
    name: p.name,
    message: p.message,
    answersId: p.answers_id,
    restOf: p.rest_of === 1,
    questionId: p.question_id,
    status: p.status,
    replacedBy: p.replaced_by,
    decidedBy: p.decided_by,
    decidedAt: p.decided_at,
    sentAt: p.sent_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    events: events
      .filter((e) => e.plan_id === p.id)
      .map(toPlanEvent)
      .sort(byTime),
    votes: votes
      .filter((v) => v.plan_id === p.id)
      .map((v) => ({
        personId: v.person_id,
        answer: v.answer,
        respondedAt: v.responded_at,
        arrival: arrivalOf(v.answered_via, v.answered_via_by),
      })),
    letter: p.status === "draft" ? null : letterFor(sent++),
  }));
}

/** An event that is agreed: a scheduled event an accepted plan of this thread wrote. */
export interface AgreedEvent extends PlanEventLike {
  readonly eventId: string;
  readonly planId: string;
}

const agreedRowSchema = z.object({
  sid: z.string(),
  plan_id: z.string(),
  who: z.string(),
  event_id: z.string(),
  title: z.string(),
  all_day: z.number(),
  start_local: z.string(),
  end_local: z.string(),
});

/**
 * What is agreed in the thread, read from the canonical events themselves — so an edit
 * or a cancellation made on an event's own page is what the thread shows.
 */
export async function agreedEvents(
  storage: StoragePort,
  access: ThreadAccess,
): Promise<AgreedEvent[]> {
  const rows = await storage.query({
    sql: `SELECT pe.sid, pe.plan_id, pe.who, e.id AS event_id, e.title, e.all_day, e.start_local, e.end_local
          FROM plan_event pe
          JOIN plan p ON p.id = pe.plan_id AND p.status = 'accepted'
          JOIN canonical_event e ON e.id = pe.canonical_event_id AND e.status = 'scheduled'
          WHERE p.thread_id = ?`,
    params: [access.thread.id],
  });
  return rows
    .map((row) => {
      const r = agreedRowSchema.parse(row);
      return {
        sid: r.sid,
        planId: r.plan_id,
        eventId: r.event_id,
        title: r.title,
        allDay: r.all_day === 1,
        startLocal: r.start_local,
        endLocal: r.end_local,
        who: whoSchema.parse(JSON.parse(r.who)),
      };
    })
    .sort(byTime);
}

// --- drafts ---------------------------------------------------------------------------

export interface PlanEventInput {
  readonly title: string;
  readonly allDay: boolean;
  readonly startLocal: string;
  /** Exclusive when all day. */
  readonly endLocal: string;
  readonly who: readonly string[];
}

/**
 * Who an event is for, as stored: members only, sorted, once each — and every member
 * at once is stored as everyone (empty), so "for everyone" has one spelling.
 */
export function normalizeWho(access: ThreadAccess, who: readonly string[]): string[] {
  const members = new Set(access.members.map((m) => m.personId));
  const picked = [...new Set(who)];
  for (const id of picked)
    if (!members.has(id)) throw new PlanInputError("Choose people from this plan's members.");
  if (picked.length === members.size) return [];
  return picked.sort();
}

/** Validate a plan event exactly as an event's own fields are (same schema, same messages). */
export function validatePlanEvent(
  access: ThreadAccess,
  input: PlanEventInput,
): Omit<PlanEventLike, "sid"> {
  const f = eventFieldsSchema.parse({
    title: input.title,
    description: null,
    location: null,
    allDay: input.allDay,
    startLocal: input.startLocal,
    endLocal: input.endLocal,
    tzid: input.allDay ? null : access.thread.tzid,
    rrule: null,
  });
  return {
    title: f.title,
    allDay: f.allDay,
    startLocal: f.startLocal,
    endLocal: f.endLocal,
    who: normalizeWho(access, input.who),
  };
}

const DRAFT = "(SELECT id FROM plan WHERE thread_id = ? AND author_id = ? AND status = 'draft')";

/** A copy keeps a poll's place and notes (rc26); an event drawn afresh has none. */
function insertEvent(planId: string, e: PlanEventLike & Partial<PlanEventDetails>): SqlStatement {
  return {
    sql: `INSERT INTO plan_event (plan_id, sid, title, all_day, start_local, end_local, who, location, description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      planId,
      e.sid,
      e.title,
      e.allDay ? 1 : 0,
      e.startLocal,
      e.endLocal,
      JSON.stringify(e.who),
      e.location ?? null,
      e.description ?? null,
    ],
  };
}

function touchDraft(access: ThreadAccess, now: string): SqlStatement {
  return {
    sql: "UPDATE plan SET updated_at = ? WHERE thread_id = ? AND author_id = ? AND status = 'draft'",
    params: [now, access.thread.id, access.personId],
  };
}

/** This person's draft in the thread, if they have one. */
export async function findDraft(storage: StoragePort, access: ThreadAccess): Promise<Plan | null> {
  return (await listPlans(storage, access)).find((p) => p.status === "draft") ?? null;
}

export type StartDraftResult =
  | { readonly kind: "started"; readonly planId: string }
  /** An unsent draft with events exists; starting over needs `replace`. */
  | { readonly kind: "has_draft" }
  | { readonly kind: "invalid" };

/**
 * Start a draft: blank, "Suggest changes…" to a plan on the table (a copy that answers
 * it, events keeping their sids), or "Plan the rest…" of a replaced plan (only what
 * overlaps nothing agreed). An existing draft is kept unless it is empty or `replace`.
 */
export async function startDraft(
  storage: StoragePort,
  access: ThreadAccess,
  input: {
    readonly fromId: string | null;
    readonly rest: boolean;
    readonly replace: boolean;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<StartDraftResult> {
  const plans = await listPlans(storage, access);
  const from = input.fromId === null ? null : (plans.find((p) => p.id === input.fromId) ?? null);
  if (input.fromId !== null) {
    if (from === null) return { kind: "invalid" };
    if (input.rest ? from.status !== "replaced" : from.status !== "on_table")
      return { kind: "invalid" };
  } else if (input.rest) return { kind: "invalid" };

  const draft = plans.find((p) => p.status === "draft");
  if (draft !== undefined && draft.events.length > 0 && !input.replace)
    return { kind: "has_draft" };

  const id = (input.newId ?? (() => uuidv7()))();
  let events: readonly PlanEventLike[] = from?.events ?? [];
  if (input.rest) events = restOf(events, await agreedEvents(storage, access));
  try {
    await storage.batch([
      ...dropDraft(access),
      {
        sql: `INSERT INTO plan (id, thread_id, author_id, name, message, answers_id, rest_of,
                question_id, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'draft', ?, ?)`,
        params: [
          id,
          access.thread.id,
          access.personId,
          input.rest && from !== null ? `${from.name} (the rest)` : "",
          from?.id ?? null,
          input.rest ? 1 : 0,
          from?.questionId ?? id,
          input.now,
          input.now,
        ],
      },
      ...events.map((e) => insertEvent(id, e)),
    ]);
  } catch {
    // Another tab started a draft at the same moment: the one-draft index refused ours.
    return { kind: "has_draft" };
  }
  return { kind: "started", planId: id };
}

export type DraftEditResult =
  | { readonly kind: "saved"; readonly sid: string }
  | { readonly kind: "no_draft" }
  | { readonly kind: "full" };

/** Add an event to this person's draft. */
export async function addDraftEvent(
  storage: StoragePort,
  access: ThreadAccess,
  input: PlanEventInput & { readonly now: string; readonly newSid?: () => string },
): Promise<DraftEditResult> {
  const fields = validatePlanEvent(access, input);
  const draft = await findDraft(storage, access);
  if (draft === null) return { kind: "no_draft" };
  if (draft.events.length >= MAX_PLAN_EVENTS) return { kind: "full" };
  const sid = (input.newSid ?? (() => uuidv7()))();
  await storage.batch([insertEvent(draft.id, { ...fields, sid }), touchDraft(access, input.now)]);
  return { kind: "saved", sid };
}

/**
 * Bring back an event the draft left out of the plan it answers ("Bring back"): a copy
 * of the base's event, sid and all, so the comparison shows it as unchanged again.
 */
export async function bringBack(
  storage: StoragePort,
  access: ThreadAccess,
  input: { readonly sid: string; readonly now: string },
): Promise<DraftEditResult> {
  const plans = await listPlans(storage, access);
  const draft = plans.find((p) => p.status === "draft");
  if (draft === undefined) return { kind: "no_draft" };
  const base = plans.find((p) => p.id === draft.answersId);
  const e = base?.events.find((x) => x.sid === input.sid);
  if (e === undefined || draft.events.some((x) => x.sid === input.sid)) return { kind: "no_draft" };
  if (draft.events.length >= MAX_PLAN_EVENTS) return { kind: "full" };
  await storage.batch([insertEvent(draft.id, e), touchDraft(access, input.now)]);
  return { kind: "saved", sid: e.sid };
}

/** Change one event of this person's draft. */
export async function updateDraftEvent(
  storage: StoragePort,
  access: ThreadAccess,
  input: PlanEventInput & { readonly sid: string; readonly now: string },
): Promise<DraftEditResult> {
  const f = validatePlanEvent(access, input);
  const rows = await storage.query({
    sql: `UPDATE plan_event SET title = ?, all_day = ?, start_local = ?, end_local = ?, who = ?
          WHERE plan_id = ${DRAFT} AND sid = ? RETURNING sid`,
    params: [
      f.title,
      f.allDay ? 1 : 0,
      f.startLocal,
      f.endLocal,
      JSON.stringify(f.who),
      access.thread.id,
      access.personId,
      input.sid,
    ],
  });
  if (rows.length === 0) return { kind: "no_draft" };
  await storage.batch([touchDraft(access, input.now)]);
  return { kind: "saved", sid: input.sid };
}

/** Take one event out of this person's draft. */
export async function removeDraftEvent(
  storage: StoragePort,
  access: ThreadAccess,
  input: { readonly sid: string; readonly now: string },
): Promise<DraftEditResult> {
  const rows = await storage.query({
    sql: `DELETE FROM plan_event WHERE plan_id = ${DRAFT} AND sid = ? RETURNING sid`,
    params: [access.thread.id, access.personId, input.sid],
  });
  if (rows.length === 0) return { kind: "no_draft" };
  await storage.batch([touchDraft(access, input.now)]);
  return { kind: "saved", sid: input.sid };
}

/** "Keep only these days" / "Drop these days" on this person's draft. */
export async function clipDraft(
  storage: StoragePort,
  access: ThreadAccess,
  input: {
    readonly first: string;
    readonly last: string;
    readonly keep: boolean;
    readonly now: string;
    readonly newSid?: () => string;
  },
): Promise<{ readonly kind: "saved" | "no_draft" }> {
  const day = z.iso.date({ error: "Pick the first and the last day." });
  const first = day.parse(input.first);
  const last = day.parse(input.last);
  const draft = await findDraft(storage, access);
  if (draft === null) return { kind: "no_draft" };
  const events = clipDays(
    draft.events,
    { first, last, keep: input.keep },
    input.newSid ?? (() => uuidv7()),
  );
  await storage.batch([
    { sql: "DELETE FROM plan_event WHERE plan_id = ?", params: [draft.id] },
    ...events.map((e) => insertEvent(draft.id, e)),
    touchDraft(access, input.now),
  ]);
  return { kind: "saved" };
}

/** The draft's name and message, as typed (a blank name gets its default when sent). */
export async function setDraftDetails(
  storage: StoragePort,
  access: ThreadAccess,
  input: { readonly name: string; readonly message: string; readonly now: string },
): Promise<{ readonly kind: "saved" | "no_draft" }> {
  const name = input.name.trim().replace(/\s+/g, " ");
  const message = input.message.trim();
  if (name.length > MAX_PLAN_NAME)
    throw new PlanInputError(`Keep the name under ${MAX_PLAN_NAME} characters.`);
  if (message.length > MAX_MESSAGE)
    throw new PlanInputError(`Keep the message under ${MAX_MESSAGE} characters.`);
  const rows = await storage.query({
    sql: `UPDATE plan SET name = ?, message = ?, updated_at = ?
          WHERE thread_id = ? AND author_id = ? AND status = 'draft' RETURNING id`,
    params: [name, message === "" ? null : message, input.now, access.thread.id, access.personId],
  });
  return { kind: rows.length === 0 ? "no_draft" : "saved" };
}

/**
 * Throw this person's draft away. A hard delete, which §10 allows here alone: a draft was
 * never shown to anyone, and nothing refers to it.
 */
export async function discardDraft(storage: StoragePort, access: ThreadAccess): Promise<void> {
  await storage.batch(dropDraft(access));
}

/**
 * Delete this person's draft and its events. The events go explicitly, not by the
 * foreign key's cascade: a libsql connection does not enforce foreign keys unless asked,
 * and an orphaned row must not depend on which driver ran the statement.
 */
function dropDraft(access: ThreadAccess): SqlStatement[] {
  const params = [access.thread.id, access.personId];
  return [
    { sql: `DELETE FROM plan_event WHERE plan_id IN ${DRAFT}`, params },
    { sql: "DELETE FROM plan WHERE thread_id = ? AND author_id = ? AND status = 'draft'", params },
  ];
}

/** The name a plan gets when it is sent with none: "Mara's changes to A", or "Plan C". */
export function defaultName(
  access: ThreadAccess,
  answered: Pick<Plan, "letter"> | null,
  ownLetter: string,
): string {
  const me = access.members.find((m) => m.personId === access.personId);
  const who = me === undefined ? "Someone" : memberName(me);
  return answered?.letter == null ? `Plan ${ownLetter}` : `${who}'s changes to ${answered.letter}`;
}

export type SendResult =
  | { readonly kind: "sent"; readonly planId: string }
  | { readonly kind: "empty" }
  | { readonly kind: "no_draft" };

/**
 * Put this person's draft on the table, with their yes. The status flip and the vote are
 * one batch, and the vote is written only if the flip happened.
 */
export async function sendDraft(
  storage: StoragePort,
  access: ThreadAccess,
  input: { readonly now: string },
): Promise<SendResult> {
  const plans = await listPlans(storage, access);
  const draft = plans.find((p) => p.status === "draft");
  if (draft === undefined) return { kind: "no_draft" };
  if (draft.events.length === 0) return { kind: "empty" };
  const answered = plans.find((p) => p.id === draft.answersId) ?? null;
  const ownLetter = letterFor(plans.filter((p) => p.status !== "draft").length);
  const name = draft.name === "" ? defaultName(access, answered, ownLetter) : draft.name;
  await storage.batch([
    {
      sql: `UPDATE plan SET status = 'on_table', name = ?, sent_at = ?, updated_at = ?
            WHERE id = ? AND author_id = ? AND status = 'draft'`,
      params: [name, input.now, input.now, draft.id, access.personId],
    },
    {
      sql: `INSERT INTO plan_vote (plan_id, person_id, answer, responded_at, answered_via)
            SELECT ?, ?, 'yes', ?, 'session' WHERE changes() = 1`,
      params: [draft.id, access.personId, input.now],
    },
  ]);
  return { kind: "sent", planId: draft.id };
}

// --- deciding -------------------------------------------------------------------------

export type DecideResult =
  | { readonly kind: "accepted"; readonly replaced: readonly string[] }
  | { readonly kind: "forbidden" }
  | { readonly kind: "closed" }
  | { readonly kind: "invalid" };

export type VoteResult =
  | { readonly kind: "recorded" }
  /** With two members, this vote was the second yes. */
  | { readonly kind: "accepted"; readonly replaced: readonly string[] }
  | { readonly kind: "closed" }
  | { readonly kind: "invalid" };

/**
 * Record this person's vote on a plan on the table (a later vote replaces an earlier
 * one). The `status = 'on_table'` join makes a vote after the plan was decided
 * impossible in the database itself. With two members, the second yes accepts it.
 */
export async function castVote(
  storage: StoragePort,
  access: ThreadAccess,
  input: {
    readonly planId: string;
    readonly answer: Answer;
    readonly now: string;
    /** How this vote arrived (rc42); null only for a link from before it was recorded. */
    readonly arrival: Arrival | null;
  },
): Promise<VoteResult> {
  const answer = answerSchema.safeParse(input.answer);
  if (!answer.success) return { kind: "invalid" };
  const written = await storage.query({
    sql: `INSERT INTO plan_vote (plan_id, person_id, answer, responded_at, answered_via, answered_via_by)
          SELECT p.id, ?, ?, ?, ?, ? FROM plan p WHERE p.id = ? AND p.thread_id = ? AND p.status = 'on_table'
          ON CONFLICT (plan_id, person_id)
            DO UPDATE SET answer = excluded.answer, responded_at = excluded.responded_at,
              answered_via = excluded.answered_via, answered_via_by = excluded.answered_via_by
          RETURNING plan_id`,
    params: [
      access.personId,
      answer.data,
      input.now,
      input.arrival?.via ?? null,
      input.arrival?.by ?? null,
      input.planId,
      access.thread.id,
    ],
  });
  if (written.length === 0) return { kind: "closed" };
  if (!decidesByConsensus(access) || answer.data !== "yes") return { kind: "recorded" };

  const plan = (await listPlans(storage, access)).find((p) => p.id === input.planId);
  if (plan === undefined) return { kind: "recorded" };
  const yes = new Set(plan.votes.filter((v) => v.answer === "yes").map((v) => v.personId));
  if (!access.members.every((m) => yes.has(m.personId))) return { kind: "recorded" };
  const result = await accept(storage, access, input.planId, {
    decidedBy: null,
    actorId: access.personId,
    now: input.now,
  });
  return result.kind === "accepted" ? result : { kind: "recorded" };
}

/**
 * The organizer accepts a plan as a whole (more than two members). With two, a plan is
 * accepted only by both saying yes — there is nobody to decide over the other.
 */
export async function acceptPlan(
  storage: StoragePort,
  access: ThreadAccess,
  input: { readonly planId: string; readonly now: string; readonly newId?: () => string },
): Promise<DecideResult> {
  if (decidesByConsensus(access) || access.thread.organizerId !== access.personId)
    return { kind: "forbidden" };
  return accept(storage, access, input.planId, {
    decidedBy: access.personId,
    actorId: access.personId,
    now: input.now,
    ...(input.newId === undefined ? {} : { newId: input.newId }),
  });
}

/**
 * Accept: flip the plan, replace its alternatives, and write each of its events as a
 * scheduled canonical event for every member, with participation and a history row —
 * ONE batch. Every statement after the first is guarded by this accept's own
 * decision_id, so an accept that lost a race (the plan was no longer on the table)
 * writes nothing at all, and the read-back says which one won.
 */
async function accept(
  storage: StoragePort,
  access: ThreadAccess,
  planId: string,
  input: {
    readonly decidedBy: string | null;
    readonly actorId: string;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<DecideResult> {
  const newId = input.newId ?? (() => uuidv7());
  const plans = await listPlans(storage, access);
  const plan = plans.find((p) => p.id === planId);
  if (plan === undefined || plan.status === "draft") return { kind: "invalid" };
  if (plan.status !== "on_table") return { kind: "closed" };

  const replaced = alternativesOf(
    plan,
    plans.filter((p) => p.status === "on_table"),
  );
  const decisionId = newId();
  const guard = "EXISTS (SELECT 1 FROM plan WHERE id = ? AND decision_id = ?)";
  const g = [plan.id, decisionId];
  const editors = JSON.stringify(deciders(access));
  const owner = access.thread.organizerId;

  const statements: SqlStatement[] = [
    {
      sql: `UPDATE plan SET status = 'accepted', decided_by = ?, decided_at = ?, decision_id = ?, updated_at = ?
            WHERE id = ? AND thread_id = ? AND status = 'on_table'`,
      params: [input.decidedBy, input.now, decisionId, input.now, plan.id, access.thread.id],
    },
    {
      sql: `UPDATE plan SET status = 'replaced', replaced_by = ?, decided_at = ?, updated_at = ?
            WHERE thread_id = ? AND status = 'on_table'
              AND id IN (SELECT value FROM json_each(?)) AND ${guard}`,
      params: [plan.id, input.now, input.now, access.thread.id, JSON.stringify(replaced), ...g],
    },
  ];
  for (const e of plan.events) {
    const eventId = newId();
    const tzid = e.allDay ? null : access.thread.tzid;
    const fields = {
      title: e.title,
      description: e.description,
      location: e.location,
      allDay: e.allDay,
      startLocal: e.startLocal,
      endLocal: e.endLocal,
      tzid,
      rrule: null,
    };
    statements.push(
      {
        // The thread's group, if any, is the event's provenance and gives its period (rc27).
        sql: `INSERT INTO canonical_event
                (id, revision, origin, owner_id, group_id, title, description, location, all_day,
                 start_local, end_local, tzid, rrule, status, created_at, updated_at, retain_days)
              SELECT ?, 1, 'user_edit', ?, g.id, ?, ?, ?, ?, ?, ?, ?, NULL, 'scheduled', ?, ?,
                     coalesce(g.retain_days, 365)
              FROM (SELECT 1) LEFT JOIN person_group g ON g.id = ?
              WHERE ${guard}`,
        params: [
          eventId,
          owner,
          e.title,
          e.description,
          e.location,
          e.allDay ? 1 : 0,
          e.startLocal,
          e.endLocal,
          tzid,
          input.now,
          input.now,
          access.thread.groupId,
          ...g,
        ],
      },
      {
        sql: `INSERT INTO event_participation
                (canonical_event_id, person_id, edit_tier, visibility, response_kind, created_at)
              SELECT ?, m.person_id,
                CASE WHEN m.person_id IN (SELECT value FROM json_each(?)) THEN 'edit' ELSE 'view' END,
                'FULL', 'none', ?
              FROM plan_thread_member m WHERE m.thread_id = ? AND ${guard}`,
        params: [eventId, editors, input.now, access.thread.id, ...g],
      },
      // The group's members who see only busy time weren't asked; they get the result,
      // at their usual terms — those in it when the thread started, never later (rc27).
      {
        sql: `INSERT INTO event_participation
                (canonical_event_id, person_id, edit_tier, visibility, response_kind, created_at)
              SELECT ?, gm.person_id, gm.default_edit_tier, gm.default_visibility, 'none', ?
              FROM group_member gm
              WHERE gm.group_id = ? AND gm.default_visibility = 'BUSY' AND gm.joined_at <= ?
                AND gm.person_id NOT IN (SELECT person_id FROM plan_thread_member WHERE thread_id = ?)
                AND ${guard}`,
        params: [
          eventId,
          input.now,
          access.thread.groupId,
          access.thread.createdAt,
          access.thread.id,
          ...g,
        ],
      },
      {
        sql: `INSERT INTO change_log (canonical_event_id, revision, actor, source, diff, created_at)
              SELECT ?, 1, ?, 'ui', ?, ? WHERE ${guard}`,
        params: [
          eventId,
          input.actorId,
          JSON.stringify(diff({}, { ...flatten(fields), status: "scheduled" })),
          input.now,
          ...g,
        ],
      },
      {
        sql: `UPDATE plan_event SET canonical_event_id = ? WHERE plan_id = ? AND sid = ? AND ${guard}`,
        params: [eventId, plan.id, e.sid, ...g],
      },
    );
  }
  await storage.batch(statements);
  const won = await storage.query({
    sql: "SELECT decision_id FROM plan WHERE id = ?",
    params: [plan.id],
  });
  if (won[0]?.decision_id !== decisionId) return { kind: "closed" };
  return { kind: "accepted", replaced };
}

/** Its author takes a plan on the table back. */
export async function withdrawPlan(
  storage: StoragePort,
  access: ThreadAccess,
  input: { readonly planId: string; readonly now: string },
): Promise<{ readonly kind: "withdrawn" | "closed" }> {
  const rows = await storage.query({
    sql: `UPDATE plan SET status = 'withdrawn', decided_at = ?, updated_at = ?
          WHERE id = ? AND thread_id = ? AND author_id = ? AND status = 'on_table' RETURNING id`,
    params: [input.now, input.now, input.planId, access.thread.id, access.personId],
  });
  return { kind: rows.length === 0 ? "closed" : "withdrawn" };
}

export type SuggestResult =
  | { readonly kind: "suggested"; readonly planId: string }
  /** That exact time is already on the table in this question. */
  | { readonly kind: "same" }
  | { readonly kind: "closed" };

/**
 * "Suggest another time" (DESIGN §10 rc26): a one-event plan on the table answers with
 * a new one-event plan in the same question — the same event at another time, sent with
 * the suggester's yes. Every insert is guarded on the base still being on the table, so a
 * suggestion can't land in a question that was decided meanwhile.
 */
export async function suggestTime(
  storage: StoragePort,
  access: ThreadAccess,
  input: {
    readonly planId: string;
    readonly startLocal: string;
    /** Exclusive when all day. */
    readonly endLocal: string;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<SuggestResult> {
  const plans = await listPlans(storage, access);
  const base = plans.find((p) => p.id === input.planId);
  const [e, ...more] = base?.events ?? [];
  if (base === undefined || base.status !== "on_table" || e === undefined || more.length > 0)
    return { kind: "closed" };
  const t = validatePlanEvent(access, {
    title: e.title,
    allDay: e.allDay,
    startLocal: input.startLocal,
    endLocal: input.endLocal,
    who: e.who,
  });
  const same = plans.some(
    (p) =>
      p.status === "on_table" &&
      p.questionId === base.questionId &&
      p.events.some(
        (x) => x.allDay === t.allDay && x.startLocal === t.startLocal && x.endLocal === t.endLocal,
      ),
  );
  if (same) return { kind: "same" };
  const newId = input.newId ?? (() => uuidv7());
  const id = newId();
  await storage.batch([
    {
      sql: `INSERT INTO plan (id, thread_id, author_id, name, answers_id, question_id, status, sent_at, created_at, updated_at)
            SELECT ?, ?, ?, ?, b.id, b.question_id, 'on_table', ?, ?, ? FROM plan b
            WHERE b.id = ? AND b.thread_id = ? AND b.status = 'on_table'`,
      params: [
        id,
        access.thread.id,
        access.personId,
        base.name,
        input.now,
        input.now,
        input.now,
        base.id,
        access.thread.id,
      ],
    },
    {
      sql: `INSERT INTO plan_event (plan_id, sid, title, all_day, start_local, end_local, who, location, description)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM plan WHERE id = ?)`,
      params: [
        id,
        newId(),
        t.title,
        t.allDay ? 1 : 0,
        t.startLocal,
        t.endLocal,
        JSON.stringify(t.who),
        e.location,
        e.description,
        id,
      ],
    },
    {
      sql: `INSERT INTO plan_vote (plan_id, person_id, answer, responded_at, answered_via)
            SELECT ?, ?, 'yes', ?, 'session' WHERE EXISTS (SELECT 1 FROM plan WHERE id = ?)`,
      params: [id, access.personId, input.now, id],
    },
  ]);
  const made = await storage.query({ sql: "SELECT 1 AS ok FROM plan WHERE id = ?", params: [id] });
  return made.length === 0 ? { kind: "closed" } : { kind: "suggested", planId: id };
}

// --- polls (rc26) ---------------------------------------------------------------------

/**
 * "Find a time" (DESIGN §10 rc26 *Polls are one-event plans*): a thread named for the
 * poll, one plan per offered time — all on the table in one question, sent by the creator
 * with a yes to each — in ONE batch, so a poll without its times never exists.
 *
 * Its members are the creator, the people named by address, and a group's members whose
 * usual terms there show at least title, time and place: a thread shows all of that to
 * everyone in it. Members who see only busy time get the accepted event, not a vote.
 */
export async function createPollThread(
  storage: StoragePort,
  input: {
    readonly creatorId: string;
    readonly group: GroupMembership | null;
    readonly fields: Omit<EventFieldsInput, "startLocal" | "endLocal">;
    readonly candidates: readonly CandidateTimeInput[];
    /** People named by address (resolveInvitees): members, whatever terms were typed. */
    readonly people?: readonly string[];
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<{ readonly threadId: string; readonly planIds: readonly string[] }> {
  const newId = input.newId ?? (() => uuidv7());
  const times = validateCandidates(input.fields, input.candidates);
  const first = times[0];
  if (first === undefined) throw new PollInputError("Offer at least one time.");
  const f = eventFieldsSchema.parse({
    ...input.fields,
    startLocal: first.startLocal,
    endLocal: first.endLocal,
  });
  const fromGroup =
    input.group === null
      ? []
      : (await groupDefaults(storage, input.group))
          .filter((d) => d.visibility === "FULL" || d.visibility === "DETAILS")
          .map((d) => d.personId);
  const { thread, statements } = threadStatements({
    name: f.title,
    tzid: f.tzid ?? "UTC",
    creatorId: input.creatorId,
    memberIds: [...fromGroup, ...(input.people ?? [])],
    groupId: input.group?.group.id ?? null,
    // Nobody else yet is a poll made to be shared (rc29).
    alone: true,
    now: input.now,
    newId,
  });
  // Ids sorted, then given out in time order: letters follow sent_at then id, and every
  // time is sent at the same moment.
  const ids = times.map(() => newId()).sort();
  const questionId = ids[0] ?? "";
  times.forEach((t, i) => {
    const planId = ids[i] ?? "";
    statements.push(
      {
        sql: `INSERT INTO plan (id, thread_id, author_id, name, question_id, status, sent_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'on_table', ?, ?, ?)`,
        params: [
          planId,
          thread.id,
          input.creatorId,
          f.title,
          questionId,
          input.now,
          input.now,
          input.now,
        ],
      },
      insertEvent(planId, {
        sid: newId(),
        title: f.title,
        allDay: t.allDay,
        startLocal: t.startLocal,
        endLocal: t.endLocal,
        who: [],
        location: f.location,
        description: f.description,
      }),
      {
        sql: "INSERT INTO plan_vote (plan_id, person_id, answer, responded_at, answered_via) VALUES (?, ?, 'yes', ?, 'session')",
        params: [planId, input.creatorId, input.now],
      },
    );
  });
  await storage.batch(statements);
  return { threadId: thread.id, planIds: ids };
}
