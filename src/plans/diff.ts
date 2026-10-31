// SPDX-License-Identifier: AGPL-3.0-or-later

// What changed between two plans (DESIGN §10 rc19). Pure: no storage, no clock.
//
// Events are matched by identity — the `sid` each event keeps when a plan is copied —
// and never by title or time (§3.4, applied to plans). Matching by what an event looks
// like would call a moved event "one left out, one new", which is exactly the
// two-calendars-compared-by-eye problem plans exist to remove.

/** The parts of a plan event a comparison looks at. */
export interface PlanEventLike {
  readonly sid: string;
  readonly title: string;
  readonly allDay: boolean;
  readonly startLocal: string;
  /** Exclusive when all day (RFC 5545), as everywhere in §10. */
  readonly endLocal: string;
  /** Member ids, sorted; empty means everyone. */
  readonly who: readonly string[];
}

export interface Changed<E extends PlanEventLike> {
  readonly base: E;
  readonly next: E;
  readonly moved: boolean;
  readonly renamed: boolean;
  readonly whoChanged: boolean;
}

export interface PlanDiff<E extends PlanEventLike> {
  readonly same: readonly E[];
  readonly changed: readonly Changed<E>[];
  /** In the base only: "left out". */
  readonly onlyBase: readonly E[];
  /** In the next plan only: "new". */
  readonly onlyNext: readonly E[];
}

export function sameTime(a: PlanEventLike, b: PlanEventLike): boolean {
  return a.allDay === b.allDay && a.startLocal === b.startLocal && a.endLocal === b.endLocal;
}

export function sameWho(a: PlanEventLike, b: PlanEventLike): boolean {
  return a.who.length === b.who.length && a.who.every((id, i) => b.who[i] === id);
}

/**
 * Sort every event of both sides into exactly one bucket. Both lists hold each sid at
 * most once (plan_event's primary key); the result is in the order of `next`, then of
 * `base` for the ones left out.
 */
export function diffPlans<E extends PlanEventLike>(
  base: readonly E[],
  next: readonly E[],
): PlanDiff<E> {
  const bySid = new Map(base.map((e) => [e.sid, e]));
  const same: E[] = [];
  const changed: Changed<E>[] = [];
  const onlyNext: E[] = [];
  const matched = new Set<string>();
  for (const n of next) {
    const b = bySid.get(n.sid);
    if (b === undefined) {
      onlyNext.push(n);
      continue;
    }
    matched.add(n.sid);
    const moved = !sameTime(b, n);
    const renamed = b.title !== n.title;
    const whoChanged = !sameWho(b, n);
    if (moved || renamed || whoChanged)
      changed.push({ base: b, next: n, moved, renamed, whoChanged });
    else same.push(n);
  }
  return { same, changed, onlyBase: base.filter((b) => !matched.has(b.sid)), onlyNext };
}

/** How many differences a reader is shown: one per changed, new or left-out event. */
export function changeCount(d: PlanDiff<PlanEventLike>): number {
  return d.changed.length + d.onlyBase.length + d.onlyNext.length;
}
