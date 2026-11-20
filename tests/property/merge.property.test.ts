// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { canSee } from "../../src/events/participation.js";
import type { Visibility } from "../../src/people/group.js";
import {
  INBOUND_PARTS,
  type InboundFields,
  type InboundPart,
  mergeInbound,
} from "../../src/reconcile/conflict.js";
import { propertySettings } from "./budget.js";

// Merging a change made in Google (DESIGN §11, §10 rc53), over every combination of which
// parts each side changed, at every tier: a part only one side changed is never lost, a part
// both changed goes to Google's (the later write), a part the copy doesn't show never moves,
// time moves as one, and a change delivered twice changes nothing the second time (§11
// "inbound apply is idempotent").

const BASE: InboundFields = {
  title: "Pickup",
  description: "Bring the bag",
  location: "School gate",
  startLocal: "2101-11-20T15:00:00",
  endLocal: "2101-11-20T15:30:00",
  tzid: "Europe/Prague",
  allDay: false,
};

/** Another value for each part: what one side changes it to. */
function changed(side: string, part: InboundPart): Partial<InboundFields> {
  switch (part) {
    case "title":
      return { title: `Pickup (${side})` };
    case "description":
      return { description: side === "here" ? null : `Notes from ${side}` };
    case "location":
      return { location: `${side} corner` };
    case "time":
      // A side moves the start or the end, never both the same way, to catch a part-by-field mix.
      return side === "here"
        ? { endLocal: "2101-11-20T16:00:00" }
        : { startLocal: "2101-11-20T14:00:00", endLocal: "2101-11-20T14:45:00" };
    default: {
      const never: never = part;
      return never;
    }
  }
}

const covers = (part: InboundPart) => INBOUND_PARTS.find((p) => p.part === part)?.fields ?? [];

function partOf(fields: InboundFields, part: InboundPart): string {
  return JSON.stringify(covers(part).map((f) => fields[f]));
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

test("a merge keeps both sides' changes, gives Google a collision, and never moves a hidden part", () =>
  hegel.test((tc) => {
    const visibility = tc.draw(gs.sampledFrom<Visibility>(["FULL", "DETAILS", "BUSY"]));
    let current = BASE;
    let incoming = BASE;
    const ours = new Set<InboundPart>();
    const theirs = new Set<InboundPart>();
    for (const { part } of INBOUND_PARTS) {
      if (tc.draw(gs.booleans())) {
        ours.add(part);
        current = { ...current, ...changed("here", part) };
      }
      if (tc.draw(gs.booleans())) {
        theirs.add(part);
        incoming = { ...incoming, ...changed("google", part) };
      }
    }

    const merge = mergeInbound({ base: BASE, current, incoming, visibility });

    for (const { part } of INBOUND_PARTS) {
      const got = partOf(merge.fields, part);
      const shown = canSee(visibility, part);
      if (!shown || !theirs.has(part)) {
        check(got === partOf(current, part), `${part} should stay as it is here`);
        check(!merge.applied.includes(part), `${part} should not be applied`);
      } else {
        check(got === partOf(incoming, part), `${part} should come from Google`);
        check(merge.applied.includes(part), `${part} should be applied`);
      }
      check(
        merge.replaced.includes(part) === (shown && theirs.has(part) && ours.has(part)),
        `${part} is a collision exactly when both changed it`,
      );
    }
    check(
      merge.applied.length > 0 || JSON.stringify(merge.fields) === JSON.stringify(current),
      "nothing applied means nothing changed",
    );

    // Delivered again, the same change does nothing.
    const again = mergeInbound({ base: BASE, current: merge.fields, incoming, visibility });
    check(again.applied.length === 0, "a change delivered twice applies once");
    check(JSON.stringify(again.fields) === JSON.stringify(merge.fields), "and changes nothing");
  }, propertySettings));
