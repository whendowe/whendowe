// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { type EventFieldsInput, eventFieldsSchema } from "./event.js";

// What a poll asks, shared by polls as threads of one-event plans (DESIGN §10 rc26):
// the answers (yes / if-need-be / no) and the times offered, validated as an event's own
// time is. The event-polls that came before (MVP-2 slice 2C, an event `proposed` with
// candidate times and slot_response votes) were withdrawn and their code removed (rc35);
// their rows stay until the event is purged.

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
  // One time is a question too (rc33): "Pizza Thursday at 7, who's in?"
  if (times.length === 0) throw new PollInputError("Offer a time.");
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
