// SPDX-License-Identifier: AGPL-3.0-or-later
import { canSee, type EventPart } from "../events/participation.js";
import type { Visibility } from "../people/group.js";
import type { EventFields } from "../providers/base.js";

// Merging a change made in Google (DESIGN.md §11 apply_inbound_edit, §10 rc53 *Google
// Calendar, both ways*). A change from a copy is based on what that copy last held — the event
// at the copy's base revision. Against it, each part either side changed is found: a part only
// Google changed comes in, a part only WhenDoWe changed stays, and a part both changed is a
// collision, which the later write wins. The change from Google is always the later one here:
// it is compared with an event that already holds every change made before it arrived.
//
// Time merges as ONE part — start, end, zone and all-day together — never field by field:
// Google moving the start while someone here moved the end would otherwise make an event that
// ends before it starts.

/** What comes back from a copy (rc53), in the event's own terms: never its repeat rule. */
export type InboundFields = Pick<
  EventFields,
  "title" | "description" | "location" | "startLocal" | "endLocal" | "tzid" | "allDay"
>;

/** The parts a change is merged by, each the fields it covers and the tier part that shows it. */
export const INBOUND_PARTS = [
  { part: "title", fields: ["title"] },
  { part: "description", fields: ["description"] },
  { part: "location", fields: ["location"] },
  { part: "time", fields: ["startLocal", "endLocal", "tzid", "allDay"] },
] as const satisfies readonly {
  readonly part: EventPart;
  readonly fields: readonly (keyof InboundFields)[];
}[];

export type InboundPart = (typeof INBOUND_PARTS)[number]["part"];

export interface Merge {
  /** The event as it should be now. */
  readonly fields: InboundFields;
  /** The parts taken from Google that change the event. Empty: nothing to write (§11). */
  readonly applied: readonly InboundPart[];
  /** Of those, the parts that replace a change made here since the copy's base: collisions. */
  readonly replaced: readonly InboundPart[];
}

function samePart(
  a: InboundFields,
  b: InboundFields,
  fields: readonly (keyof InboundFields)[],
): boolean {
  return fields.every((f) => a[f] === b[f]);
}

/**
 * Merge a copy's fields into the event. `base` is the event as the copy last held it, `current`
 * the event now, `incoming` the copy as Google has it (already in the event's terms: fromCopy).
 * A part the copy's tier doesn't show never comes in: it wasn't there to edit.
 */
export function mergeInbound(input: {
  readonly base: InboundFields;
  readonly current: InboundFields;
  readonly incoming: InboundFields;
  readonly visibility: Visibility;
}): Merge {
  const { base, current, incoming } = input;
  let fields: InboundFields = current;
  const applied: InboundPart[] = [];
  const replaced: InboundPart[] = [];
  for (const { part, fields: covers } of INBOUND_PARTS) {
    if (!canSee(input.visibility, part)) continue;
    if (samePart(incoming, base, covers)) continue; // Google didn't change it
    if (samePart(incoming, current, covers)) continue; // already so: both made the same change
    const taken: Partial<InboundFields> = {};
    for (const f of covers) Object.assign(taken, { [f]: incoming[f] });
    fields = { ...fields, ...taken };
    applied.push(part);
    if (!samePart(current, base, covers)) replaced.push(part);
  }
  return { fields, applied, replaced };
}

/** The line WhenDoWe puts at the top of a copy's description (rc40) begins with this. */
export const OUR_LINE_PREFIX = "From WhenDoWe — ";

/**
 * A copy's fields in the event's own terms (rc53): the line WhenDoWe put at the top of the
 * description is ours, so it is taken off — the whole first paragraph, whatever its link or
 * wording, since the wording changes between versions. Empty text is no text, as on the form.
 */
export function fromCopy(fields: EventFields): InboundFields {
  const text = (value: string | null): string | null =>
    value === null || value.trim() === "" ? null : value;
  let description = fields.description;
  if (description?.startsWith(OUR_LINE_PREFIX)) {
    const end = description.indexOf("\n\n");
    description = end === -1 ? null : description.slice(end + 2);
  }
  return {
    title: fields.title,
    description: text(description),
    location: text(fields.location),
    startLocal: fields.startLocal,
    endLocal: fields.endLocal,
    tzid: fields.tzid,
    allDay: fields.allDay,
  };
}
