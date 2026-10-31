// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { changeCount, diffPlans, type PlanEventLike } from "../../src/plans/diff.js";
import { alternativesOf, clipDays, overlaps, restOf } from "../../src/plans/plan.js";
import { propertySettings } from "./budget.js";

// Plans' pure core (DESIGN §10 rc19): the comparison people read instead of comparing two
// calendars by eye, and "Keep only / Drop these days". If the diff ever loses or doubles
// an event, a plan's change list lies about what was proposed.

const SIDS = ["a", "b", "c", "d", "e", "f"];
const TITLES = ["With Adam", "With Mara", "Session"];
const WHO = [[], ["adam"], ["mara"], ["adam", "mara"]];

function drawInt(tc: hegel.TestCase, min: number, max: number): number {
  return tc.draw(gs.integers({ minValue: min, maxValue: max }));
}

function day(n: number): string {
  const d = new Date(Date.UTC(2026, 10, 1 + n));
  return d.toISOString().slice(0, 10);
}

function drawEvent(tc: hegel.TestCase, sid: string): PlanEventLike {
  const start = drawInt(tc, 0, 40);
  const allDay = tc.draw(gs.booleans());
  const title = TITLES[drawInt(tc, 0, TITLES.length - 1)] ?? "x";
  const who = WHO[drawInt(tc, 0, WHO.length - 1)] ?? [];
  if (allDay) {
    return {
      sid,
      title,
      allDay,
      startLocal: day(start),
      endLocal: day(start + drawInt(tc, 1, 10)),
      who,
    };
  }
  const h = drawInt(tc, 8, 20);
  return {
    sid,
    title,
    allDay,
    startLocal: `${day(start)}T${String(h).padStart(2, "0")}:00:00`,
    endLocal: `${day(start)}T${String(h + drawInt(tc, 1, 3)).padStart(2, "0")}:00:00`,
    who,
  };
}

/** A plan: a random subset of the sids, each at most once (plan_event's primary key). */
function drawPlan(tc: hegel.TestCase): PlanEventLike[] {
  return SIDS.filter(() => tc.draw(gs.booleans())).map((sid) => drawEvent(tc, sid));
}

/**
 * An answer to a plan, made the way people make one: copy it, then move, rename, re-assign,
 * drop or add events. Two independent random plans would almost never share an event that
 * differs in one way only, which is the case the comparison exists for.
 */
function drawAnswer(tc: hegel.TestCase, base: readonly PlanEventLike[]): PlanEventLike[] {
  const out: PlanEventLike[] = [];
  for (const e of base) {
    const edit = drawInt(tc, 0, 4);
    if (edit === 0) continue; // left out
    if (edit === 1)
      out.push({ ...drawEvent(tc, e.sid), title: e.title, who: e.who }); // moved
    else if (edit === 2)
      out.push({ ...e, title: `${e.title}!` }); // renamed
    else if (edit === 3)
      out.push({ ...e, who: e.who.length === 0 ? ["adam"] : [] }); // re-assigned
    else out.push(e);
  }
  for (const sid of ["x", "y"]) if (tc.draw(gs.booleans())) out.push(drawEvent(tc, sid)); // new
  return out;
}

/** The days a whole-day event covers, as keys. */
function daysOf(e: PlanEventLike): string[] {
  const out: string[] = [];
  for (let d = e.startLocal; d < e.endLocal; d = day(daysBetween(day(0), d) + 1)) out.push(d);
  return out;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

describe("plan diff", () => {
  test("every event of both sides lands in exactly one bucket", () =>
    hegel.test((tc) => {
      const base = drawPlan(tc);
      const next = drawAnswer(tc, base);
      const d = diffPlans(base, next);
      const fromNext = [...d.same, ...d.changed.map((c) => c.next), ...d.onlyNext].map(
        (e) => e.sid,
      );
      const fromBase = [...d.changed.map((c) => c.base), ...d.onlyBase].map((e) => e.sid);
      expect([...fromNext].sort()).toEqual(next.map((e) => e.sid).sort());
      const sameInBase = d.same.map((e) => e.sid);
      expect([...fromBase, ...sameInBase].sort()).toEqual(base.map((e) => e.sid).sort());
    }, propertySettings));

  test("a plan compared with itself has no changes", () =>
    hegel.test((tc) => {
      const p = drawPlan(tc);
      const d = diffPlans(p, p);
      expect(changeCount(d)).toBe(0);
      expect(d.same.length).toBe(p.length);
    }, propertySettings));

  test("swapping the sides swaps left out with new, and keeps the changes", () =>
    hegel.test((tc) => {
      const a = drawPlan(tc);
      const b = drawAnswer(tc, a);
      const ab = diffPlans(a, b);
      const ba = diffPlans(b, a);
      const sids = (es: readonly PlanEventLike[]) => es.map((e) => e.sid).sort();
      expect(sids(ab.onlyBase)).toEqual(sids(ba.onlyNext));
      expect(sids(ab.onlyNext)).toEqual(sids(ba.onlyBase));
      expect(ab.changed.map((c) => c.next.sid).sort()).toEqual(
        ba.changed.map((c) => c.next.sid).sort(),
      );
    }, propertySettings));

  test("an event is same exactly when time, title and who are all equal", () =>
    hegel.test((tc) => {
      const base = drawPlan(tc);
      const next = drawAnswer(tc, base);
      const d = diffPlans(base, next);
      const bySid = new Map(base.map((e) => [e.sid, e]));
      for (const e of d.same) expect(bySid.get(e.sid)).toEqual(e);
      for (const c of d.changed) {
        expect(c.moved || c.renamed || c.whoChanged).toBe(true);
        expect(c.moved).toBe(
          c.base.startLocal !== c.next.startLocal ||
            c.base.endLocal !== c.next.endLocal ||
            c.base.allDay !== c.next.allDay,
        );
      }
    }, propertySettings));
});

describe("keep only / drop these days", () => {
  test("for whole-day stretches, kept days and dropped days split every original day", () =>
    hegel.test((tc) => {
      const events = drawPlan(tc).filter((e) => e.allDay);
      const first = day(drawInt(tc, 0, 45));
      const last = day(drawInt(tc, 0, 45));
      let n = 0;
      const fresh = () => `new-${n++}`;
      const kept = clipDays(events, { first, last, keep: true }, fresh);
      const dropped = clipDays(events, { first, last, keep: false }, fresh);
      const lo = first <= last ? first : last;
      const hi = first <= last ? last : first;
      for (const e of kept) expect(e.startLocal < e.endLocal).toBe(true);
      for (const e of dropped) expect(e.startLocal < e.endLocal).toBe(true);
      const keptDays = kept.flatMap(daysOf);
      const droppedDays = dropped.flatMap(daysOf);
      for (const d of keptDays) expect(lo <= d && d <= hi).toBe(true);
      for (const d of droppedDays) expect(d < lo || d > hi).toBe(true);
      expect([...keptDays, ...droppedDays].sort()).toEqual(events.flatMap(daysOf).sort());
      // Ids stay unique: a stretch cut in two gives its second part a new sid.
      expect(new Set(dropped.map((e) => e.sid)).size).toBe(dropped.length);
    }, propertySettings));

  test("timed events are kept or dropped whole, by the day they start", () =>
    hegel.test((tc) => {
      const events = drawPlan(tc).filter((e) => !e.allDay);
      const first = day(drawInt(tc, 0, 45));
      const last = day(drawInt(tc, 0, 45));
      const kept = clipDays(events, { first, last, keep: true }, () => "x");
      const dropped = clipDays(events, { first, last, keep: false }, () => "x");
      expect([...kept, ...dropped].map((e) => e.sid).sort()).toEqual(
        events.map((e) => e.sid).sort(),
      );
      for (const e of [...kept, ...dropped]) expect(events).toContainEqual(e);
    }, propertySettings));
});

describe("deciding", () => {
  test("an accepted plan replaces its question and what overlaps it, never itself", () =>
    hegel.test((tc) => {
      const plans = ["p0", "p1", "p2", "p3"].map((id) => ({
        id,
        questionId: `q${drawInt(tc, 0, 2)}`,
        events: drawPlan(tc).map((e) => ({ ...e, sid: `${id}-${e.sid}` })),
      }));
      const [accepted] = plans;
      if (accepted === undefined) return;
      const replaced = new Set(alternativesOf(accepted, plans));
      expect(replaced.has(accepted.id)).toBe(false);
      for (const p of plans.slice(1)) {
        const sameQuestion = p.questionId === accepted.questionId;
        const spanOverlap =
          accepted.events.length > 0 &&
          p.events.length > 0 &&
          overlapsSpan(accepted.events, p.events);
        expect(replaced.has(p.id)).toBe(sameQuestion || spanOverlap);
      }
    }, propertySettings));

  test("the rest of a plan overlaps nothing agreed, and loses nothing else", () =>
    hegel.test((tc) => {
      const plan = drawPlan(tc);
      const agreed = drawPlan(tc).map((e) => ({ ...e, sid: `agreed-${e.sid}` }));
      const rest = restOf(plan, agreed);
      for (const e of rest) for (const a of agreed) expect(overlaps(a, e)).toBe(false);
      for (const e of plan) if (!agreed.some((a) => overlaps(a, e))) expect(rest).toContainEqual(e);
    }, propertySettings));
});

/** Independent of spanOf: does any instant lie inside both plans' first-start..last-end? */
function overlapsSpan(a: readonly PlanEventLike[], b: readonly PlanEventLike[]): boolean {
  const span = (es: readonly PlanEventLike[]) => ({
    start: es.map((e) => (e.allDay ? `${e.startLocal}T00:00:00` : e.startLocal)).sort()[0] ?? "",
    end:
      es
        .map((e) => (e.allDay ? `${e.endLocal}T00:00:00` : e.endLocal))
        .sort()
        .at(-1) ?? "",
  });
  const x = span(a);
  const y = span(b);
  return x.start < y.end && y.start < x.end;
}
