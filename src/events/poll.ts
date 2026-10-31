// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { diff } from "../changelog.js";
import type { StoragePort } from "../db/port.js";
import type { GroupMembership } from "../people/group.js";
import { type Shown, shownAs, shownRowSchema } from "../people/person.js";
import {
  type CanonicalEvent,
  createEventWith,
  type EventAccess,
  type EventFieldsInput,
  eventFieldsSchema,
  flatten,
} from "./event.js";
import type { GroupDefault } from "./participation.js";

// Time polls (MVP-2 slice 2C, WORKFLOWS US-13): "when do we play?". A poll is an
// event in status `proposed` carrying 2..MAX candidate times; every participant who
// can see it answers yes / if-need-be / no per candidate; an editor confirms one,
// which writes that candidate into the event's time and flips it to `scheduled` —
// one guarded statement, so a vote after confirmation is impossible, not just hidden.
//
// Votes are attributed rows (person + answer + time) in slot_response. They are not
// change_log rows: change_log is keyed by event revision, and bumping the revision
// on every vote would turn each vote into an edit conflict for whoever is editing.

export const MIN_CANDIDATES = 2;
export const MAX_CANDIDATES = 10;

export const answerSchema = z.enum(["yes", "ifneedbe", "no"]);
export type Answer = z.infer<typeof answerSchema>;

export interface Candidate {
  readonly slotIndex: number;
  readonly allDay: boolean;
  readonly startLocal: string;
  readonly endLocal: string;
  readonly tzid: string | null;
}

export interface CandidateTimeInput {
  readonly startLocal: string;
  readonly endLocal: string;
}

/**
 * Validate every candidate exactly as an event's own time is validated (same schema,
 * same messages), then sort them chronologically and refuse duplicates.
 */
export function validateCandidates(
  fields: Omit<EventFieldsInput, "startLocal" | "endLocal">,
  times: readonly CandidateTimeInput[],
): Omit<Candidate, "slotIndex">[] {
  if (times.length < MIN_CANDIDATES)
    throw new PollInputError(`Offer at least ${MIN_CANDIDATES} times to choose from.`);
  if (times.length > MAX_CANDIDATES)
    throw new PollInputError(`Offer at most ${MAX_CANDIDATES} times.`);
  const parsed = times.map((t) => eventFieldsSchema.parse({ ...fields, ...t }));
  const keys = new Set(parsed.map((c) => `${c.startLocal}/${c.endLocal}`));
  if (keys.size !== parsed.length)
    throw new PollInputError("Two of the offered times are the same.");
  return parsed
    .map((c) => ({
      allDay: c.allDay,
      startLocal: c.startLocal,
      endLocal: c.endLocal,
      tzid: c.tzid,
    }))
    .sort((a, b) => (a.startLocal < b.startLocal ? -1 : a.startLocal > b.startLocal ? 1 : 0));
}

/** A person-facing problem with the poll as a whole (count, duplicates). */
export class PollInputError extends Error {}

/**
 * Create a poll. The event's own time holds the earliest candidate as a placeholder
 * (the columns are NOT NULL); nothing reads it as "the" time while status is
 * `proposed` — desired() projects nothing that isn't scheduled, and the pages show
 * the candidates instead.
 */
export async function createPoll(
  storage: StoragePort,
  input: {
    readonly creatorId: string;
    readonly group: GroupMembership | null;
    readonly fields: Omit<EventFieldsInput, "startLocal" | "endLocal">;
    readonly candidates: readonly CandidateTimeInput[];
    /** People named directly, at their own tiers (DESIGN rc15). */
    readonly people?: readonly GroupDefault[];
    readonly now: string;
  },
): Promise<CanonicalEvent> {
  const candidates = validateCandidates(input.fields, input.candidates);
  const first = candidates[0];
  if (first === undefined) throw new PollInputError("Offer at least one time.");
  return createEventWith(
    storage,
    {
      creatorId: input.creatorId,
      group: input.group,
      ...(input.people === undefined ? {} : { people: input.people }),
      fields: { ...input.fields, startLocal: first.startLocal, endLocal: first.endLocal },
      status: "proposed",
      responseKind: "slot_vote",
      now: input.now,
    },
    (eventId) =>
      candidates.map((c, slotIndex) => ({
        sql: `INSERT INTO event_candidate (canonical_event_id, slot_index, all_day, start_local, end_local, tzid)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [eventId, slotIndex, c.allDay ? 1 : 0, c.startLocal, c.endLocal, c.tzid],
      })),
  );
}

const candidateRowSchema = z.object({
  slot_index: z.number(),
  all_day: z.number(),
  start_local: z.string(),
  end_local: z.string(),
  tzid: z.string().nullable(),
});

async function candidatesOf(storage: StoragePort, eventId: string): Promise<Candidate[]> {
  const rows = await storage.query({
    sql: `SELECT slot_index, all_day, start_local, end_local, tzid
          FROM event_candidate WHERE canonical_event_id = ? ORDER BY slot_index`,
    params: [eventId],
  });
  return rows.map((row) => {
    const r = candidateRowSchema.parse(row);
    return {
      slotIndex: r.slot_index,
      allDay: r.all_day === 1,
      startLocal: r.start_local,
      endLocal: r.end_local,
      tzid: r.tzid,
    };
  });
}

export interface Voter {
  readonly personId: string;
  readonly shown: Shown;
  readonly answer: Answer;
}

export interface CandidateResult extends Candidate {
  readonly yes: number;
  readonly ifNeedBe: number;
  readonly no: number;
  readonly mine: Answer | null;
  /** Who answered what. The page shows names only to tiers that see participants. */
  readonly voters: readonly Voter[];
}

export interface PollResults {
  readonly candidates: readonly CandidateResult[];
  /** People who can answer: every participant who can see the event at all. */
  readonly electorate: number;
  /** Slots every one of them said yes to — the "works for everyone" hint (WORKFLOWS §9 Q). */
  readonly everyoneYes: readonly number[];
}

const voteRowSchema = shownRowSchema.extend({
  slot_index: z.number(),
  person_id: z.string(),
  answer: answerSchema,
});

/** The poll's candidates and answers, for someone who passed findEventForParticipant. */
export async function pollResults(storage: StoragePort, access: EventAccess): Promise<PollResults> {
  const eventId = access.event.id;
  const candidates = await candidatesOf(storage, eventId);
  const votes = (
    await storage.query({
      sql: `SELECT r.slot_index, r.person_id, r.answer, p.email, p.display_name, ep.handle, ep.show_email
            FROM slot_response r JOIN person p ON p.id = r.person_id
              LEFT JOIN event_participation ep
                ON ep.canonical_event_id = r.canonical_event_id AND ep.person_id = r.person_id
            WHERE r.canonical_event_id = ?
            ORDER BY r.person_id`,
      params: [eventId],
    })
  ).map((row) => voteRowSchema.parse(row));
  const electorateRows = await storage.query({
    sql: `SELECT count(*) AS n FROM event_participation WHERE canonical_event_id = ? AND visibility <> 'HIDDEN'`,
    params: [eventId],
  });
  const electorate = z.number().parse(electorateRows[0]?.n);

  const results = candidates.map((c) => {
    const here = votes.filter((v) => v.slot_index === c.slotIndex);
    const count = (a: Answer) => here.filter((v) => v.answer === a).length;
    return {
      ...c,
      yes: count("yes"),
      ifNeedBe: count("ifneedbe"),
      no: count("no"),
      mine: here.find((v) => v.person_id === access.participation.personId)?.answer ?? null,
      voters: here.map((v) => ({
        personId: v.person_id,
        shown: shownAs(v.person_id, v, eventId),
        answer: v.answer,
      })),
    };
  });
  return {
    candidates: results,
    electorate,
    everyoneYes: results
      .filter((r) => electorate > 0 && r.yes === electorate)
      .map((r) => r.slotIndex),
  };
}

export type VoteResult =
  | { readonly kind: "recorded" }
  | { readonly kind: "closed" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid" };

/**
 * Record this person's answers (any subset of the candidates; a later answer replaces
 * an earlier one). ONE statement, so the answers land together or not at all, and the
 * `status = 'proposed'` join makes voting after confirmation impossible in the
 * database itself — a vote racing a confirm either lands before it or not at all.
 * RETURNING tells us which happened.
 */
export async function vote(
  storage: StoragePort,
  access: EventAccess,
  input: { readonly answers: ReadonlyMap<number, Answer>; readonly now: string },
): Promise<VoteResult> {
  if (access.participation.visibility === "HIDDEN") return { kind: "forbidden" };
  if (access.event.status !== "proposed") return { kind: "closed" };
  if (input.answers.size === 0) return { kind: "invalid" };
  const slots = new Set((await candidatesOf(storage, access.event.id)).map((c) => c.slotIndex));
  for (const slot of input.answers.keys()) if (!slots.has(slot)) return { kind: "invalid" };

  const payload = JSON.stringify([...input.answers].map(([s, a]) => ({ s, a })));
  const written = await storage.query({
    sql: `INSERT INTO slot_response (canonical_event_id, slot_index, person_id, answer, responded_at)
          SELECT c.canonical_event_id, c.slot_index, ?, json_extract(j.value, '$.a'), ?
          FROM json_each(?) j
          JOIN event_candidate c ON c.canonical_event_id = ? AND c.slot_index = json_extract(j.value, '$.s')
          JOIN canonical_event e ON e.id = c.canonical_event_id AND e.status = 'proposed'
          WHERE true
          ON CONFLICT (canonical_event_id, slot_index, person_id)
            DO UPDATE SET answer = excluded.answer, responded_at = excluded.responded_at
          RETURNING slot_index`,
    params: [access.participation.personId, input.now, payload, access.event.id],
  });
  return written.length === input.answers.size ? { kind: "recorded" } : { kind: "closed" };
}

export type ConfirmResult =
  | { readonly kind: "confirmed"; readonly event: CanonicalEvent }
  | { readonly kind: "forbidden" }
  | { readonly kind: "closed" }
  | { readonly kind: "invalid" }
  | { readonly kind: "conflict" };

/**
 * Confirm candidate `slotIndex`: copy its time into the event and flip `proposed` →
 * `scheduled`, guarded by the revision the editor SAW and by the status, with the
 * change_log row written only if that UPDATE happened (the editEvent pattern). The
 * candidates and votes stay as the record of how the time was chosen; they leave
 * desired state because the status did.
 */
export async function confirmCandidate(
  storage: StoragePort,
  access: EventAccess,
  input: {
    readonly slotIndex: number;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly now: string;
  },
): Promise<ConfirmResult> {
  if (access.participation.editTier !== "edit") return { kind: "forbidden" };
  if (access.event.status !== "proposed") return { kind: "closed" };
  const candidate = (await candidatesOf(storage, access.event.id)).find(
    (c) => c.slotIndex === input.slotIndex,
  );
  if (candidate === undefined) return { kind: "invalid" };

  const { event } = access;
  const chosen = {
    ...event,
    allDay: candidate.allDay,
    startLocal: candidate.startLocal,
    endLocal: candidate.endLocal,
    tzid: candidate.tzid,
  };
  const change = diff(
    { ...flatten(event), status: event.status },
    { ...flatten(chosen), status: "scheduled" },
  );
  const next = input.expectedRevision + 1;
  try {
    await storage.batch([
      {
        sql: `UPDATE canonical_event SET all_day = ?, start_local = ?, end_local = ?, tzid = ?,
                status = 'scheduled', revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ? AND status = 'proposed'`,
        params: [
          candidate.allDay ? 1 : 0,
          candidate.startLocal,
          candidate.endLocal,
          candidate.tzid,
          input.now,
          event.id,
          input.expectedRevision,
        ],
      },
      {
        sql: `INSERT INTO change_log (canonical_event_id, revision, actor, source, diff, created_at)
              SELECT ?, ?, ?, 'ui', ?, ? WHERE changes() = 1`,
        params: [event.id, next, input.actorId, JSON.stringify(change), input.now],
      },
    ]);
  } catch {
    return { kind: "conflict" };
  }
  const written = await storage.query({
    sql: "SELECT actor, diff FROM change_log WHERE canonical_event_id = ? AND revision = ?",
    params: [event.id, next],
  });
  const row = written[0];
  if (row === undefined || row.actor !== input.actorId || row.diff !== JSON.stringify(change)) {
    return { kind: "conflict" };
  }
  return {
    kind: "confirmed",
    event: { ...chosen, status: "scheduled", revision: next, updatedAt: input.now },
  };
}
