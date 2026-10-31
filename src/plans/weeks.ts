// SPDX-License-Identifier: AGPL-3.0-or-later
import { diffPlans, type PlanEventLike, sameTime } from "./diff.js";
import { overlaps } from "./plan.js";

// The week rows (DESIGN §10 rc19: "weeks matter, months don't"). Pure view-model: dates in,
// rows of days and labelled ribbons out, so the pages only interpolate.
//
// An event is ONE span drawn as per-week pieces, each knowing whether the event starts
// (head) or ends (tail) in its week. Nothing about an event stops at a week boundary,
// and while one is being edited, its weeks and the week either side never fold — the
// next day someone would tap is always on screen. Positions come from the model's days,
// never from a ribbon's box (the prototype's lesson: grips placed by box were 2 days off).

// --- days -------------------------------------------------------------------------------

const MS_DAY = 86_400_000;
export const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function utc(k: string): Date {
  return new Date(`${k.slice(0, 10)}T00:00:00Z`);
}

export function addDays(k: string, n: number): string {
  return new Date(utc(k).getTime() + n * MS_DAY).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export function dowMon(k: string): number {
  return (utc(k).getUTCDay() + 6) % 7;
}

export function weekStart(k: string): string {
  return addDays(k, -dowMon(k));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b).getTime() - utc(a).getTime()) / MS_DAY);
}

/** ISO 8601 week number. */
export function isoWeek(k: string): number {
  const thursday = addDays(k, 3 - dowMon(k));
  const jan1 = `${thursday.slice(0, 4)}-01-01`;
  return Math.floor(daysBetween(jan1, thursday) / 7) + 1;
}

/** "Sat 26 Dec". */
export function dayLabel(k: string): string {
  const d = utc(k);
  return `${WEEKDAY[dowMon(k)]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** "26 Dec". */
export function shortDay(k: string): string {
  const d = utc(k);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

type Timed = Pick<PlanEventLike, "allDay" | "startLocal" | "endLocal">;

/** The last day an event is on, inclusive (an all-day end is exclusive; a timed one ending at midnight is the day before). */
export function lastDay(e: Timed): string {
  if (e.allDay) return addDays(e.endLocal, -1);
  const day = e.endLocal.slice(0, 10);
  const startDay = e.startLocal.slice(0, 10);
  return e.endLocal.slice(11, 16) === "00:00" && day > startDay ? addDays(day, -1) : day;
}

export function dayKeys(e: Timed): string[] {
  const out: string[] = [];
  const z = lastDay(e);
  for (let k = e.startLocal.slice(0, 10); k <= z; k = addDays(k, 1)) out.push(k);
  return out;
}

const hm = (t: string) => t.slice(11, 16);

/** "Thu 5 Nov, 19:00–23:00", "Sat 26 Dec, all day", "Mon 9 Nov – Sun 15 Nov". */
export function whenText(e: Timed): string {
  const a = e.startLocal.slice(0, 10);
  if (e.allDay) {
    const z = lastDay(e);
    return z === a ? `${dayLabel(a)}, all day` : `${dayLabel(a)} – ${dayLabel(z)}`;
  }
  const z = e.endLocal.slice(0, 10);
  return z === a
    ? `${dayLabel(a)}, ${hm(e.startLocal)}–${hm(e.endLocal)}`
    : `${dayLabel(a)} ${hm(e.startLocal)} – ${dayLabel(z)} ${hm(e.endLocal)}`;
}

/** "Thu 19 Nov → Thu 26 Nov" when only the day changes; the times only when they change. */
export function moveText(a: Timed, b: Timed): string {
  if (a.allDay || b.allDay) return `${whenText(a)} → ${whenText(b)}`;
  const da = a.startLocal.slice(0, 10);
  const db = b.startLocal.slice(0, 10);
  const t = (e: Timed) => `${hm(e.startLocal)}–${hm(e.endLocal)}`;
  const oneDay = (e: Timed) => e.endLocal.slice(0, 10) === e.startLocal.slice(0, 10);
  if (oneDay(a) && oneDay(b)) {
    if (t(a) === t(b)) return `${dayLabel(da)} → ${dayLabel(db)}`;
    if (da === db) return `${dayLabel(da)}, ${t(a)} → ${t(b)}`;
  }
  return `${whenText(a)} → ${whenText(b)}`;
}

/** "9 Nov – 15 Nov" for a plan's events, or one day. Empty for none. */
export function spanText(events: readonly Timed[]): string {
  if (events.length === 0) return "";
  const first = events.map((e) => e.startLocal.slice(0, 10)).sort()[0] ?? "";
  const last = events.map(lastDay).sort().at(-1) ?? first;
  return first === last ? dayLabel(first) : `${dayLabel(first)} – ${dayLabel(last)}`;
}

// --- who and colour ---------------------------------------------------------------------

export type NameOf = (personId: string) => string;

/** "Lena, Tom", or "everyone". */
export function whoText(who: readonly string[], nameOf: NameOf): string {
  return who.length === 0 ? "everyone" : who.map(nameOf).join(", ");
}

/** Who, shown beside a title unless the title already says it ("With Adam"). */
export function whoTag(e: Pick<PlanEventLike, "title" | "who">, nameOf: NameOf): string | null {
  const names = e.who.map(nameOf).filter((n) => !e.title.includes(n));
  return names.length === 0 ? null : names.join(", ");
}

/** Colour follows the person when an event is for one, and otherwise the title. */
export function colourKey(e: Pick<PlanEventLike, "title" | "who">): string {
  const [only, ...rest] = e.who;
  return only !== undefined && rest.length === 0 ? `@${only}` : e.title.trim().toLowerCase();
}

export const COLOURS = 8;

/** Colours in first-seen order over the thread, so an event has its colour in every plan. */
export function colourMap(
  events: readonly Pick<PlanEventLike, "title" | "who">[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const k = colourKey(e);
    if (!out.has(k)) out.set(k, out.size % COLOURS);
  }
  return out;
}

// --- the comparison, in words -----------------------------------------------------------

export interface Part {
  readonly text: string;
  readonly strong: boolean;
}

const t = (text: string): Part => ({ text, strong: false });
const b = (text: string): Part => ({ text, strong: true });

export type ItemKind = "agreed" | "plan" | "ghost";

export interface Item {
  readonly e: PlanEventLike;
  readonly kind: ItemKind;
  /** "moved", "new", "left out", "was here", "renamed", "for Mara". */
  readonly badge: string | null;
}

export interface Line {
  /** The day it is listed under. */
  readonly day: string;
  readonly kind: "chg" | "add" | "rm" | "warn";
  readonly parts: readonly Part[];
  /** False for the copy listed under the week a moved event left: count it once. */
  readonly primary: boolean;
}

export interface Model {
  readonly items: readonly Item[];
  readonly lines: readonly Line[];
  /** Changes from the base; 0 without one. */
  readonly changes: number;
  /** Base events left out of the comparison because they are agreed since. */
  readonly settled: number;
  readonly compared: boolean;
}

/**
 * What a week list draws: agreed events, the plan in focus, and ghosts of what it moves
 * or leaves out — plus the changes in words. One plan is drawn; the difference is
 * written, never layered (§10 rc19). Without a base, an event overlapping what is agreed
 * is called out instead.
 */
export function compareModel(input: {
  readonly agreed: readonly PlanEventLike[];
  readonly events: readonly PlanEventLike[];
  readonly base: readonly PlanEventLike[] | null;
  readonly nameOf: NameOf;
}): Model {
  const { agreed, events, base, nameOf } = input;
  const items: Item[] = agreed.map((e) => ({ e, kind: "agreed", badge: null }));
  const lines: Line[] = [];
  const start = (e: PlanEventLike) => e.startLocal.slice(0, 10);
  if (base === null) {
    for (const e of events) {
      items.push({ e, kind: "plan", badge: null });
      if (agreed.some((a) => overlaps(a, e)))
        lines.push({
          day: start(e),
          kind: "warn",
          parts: [b(e.title), t(" overlaps what is agreed")],
          primary: true,
        });
    }
    return { items, lines, changes: 0, settled: 0, compared: false };
  }
  const isSettled = (e: PlanEventLike) => agreed.some((a) => a.sid === e.sid && sameTime(a, e));
  const open = base.filter((e) => !isSettled(e));
  const d = diffPlans(open, events);
  for (const e of d.same) items.push({ e, kind: "plan", badge: null });
  for (const c of d.changed) {
    const [only, ...more] = c.next.who;
    const forWhom = only !== undefined && more.length === 0 ? `for ${nameOf(only)}` : "for others";
    items.push({
      e: c.next,
      kind: "plan",
      badge: c.moved ? "moved" : c.renamed ? "renamed" : forWhom,
    });
    if (c.moved) items.push({ e: c.base, kind: "ghost", badge: "was here" });
    const parts: Part[] = [b(c.base.title)];
    if (c.renamed)
      parts.push(t(" renamed "), b(c.next.title), t(c.moved || c.whoChanged ? "," : ""));
    if (c.moved) parts.push(t(` moved ${moveText(c.base, c.next)}${c.whoChanged ? "," : ""}`));
    if (c.whoChanged)
      parts.push(
        t(" now for "),
        b(whoText(c.next.who, nameOf)),
        t(` (was ${whoText(c.base.who, nameOf)})`),
      );
    lines.push({ day: start(c.next), kind: "chg", parts, primary: true });
    if (c.moved && weekStart(start(c.base)) !== weekStart(start(c.next)))
      lines.push({ day: start(c.base), kind: "chg", parts, primary: false });
  }
  for (const e of d.onlyNext) {
    items.push({ e, kind: "plan", badge: "new" });
    lines.push({
      day: start(e),
      kind: "add",
      parts: [t("New: "), b(e.title), t(`, ${whenText(e)}`)],
      primary: true,
    });
  }
  for (const e of d.onlyBase) {
    items.push({ e, kind: "ghost", badge: "left out" });
    lines.push({
      day: start(e),
      kind: "rm",
      parts: [t("Left out: "), b(e.title), t(`, ${whenText(e)}`)],
      primary: true,
    });
  }
  return {
    items,
    lines: lines.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0)),
    changes: d.changed.length + d.onlyNext.length + d.onlyBase.length,
    settled: base.length - open.length,
    compared: true,
  };
}

// --- week rows --------------------------------------------------------------------------

export interface Piece {
  /** The Monday of the piece's week. */
  readonly w: string;
  readonly c0: number;
  readonly c1: number;
  readonly head: boolean;
  readonly tail: boolean;
}

/** One piece per week an event touches. */
export function pieces(e: Timed): Piece[] {
  const a = e.startLocal.slice(0, 10);
  const z = lastDay(e);
  const out: Piece[] = [];
  for (let w = weekStart(a); w <= z; w = addDays(w, 7)) {
    const head = a >= w;
    const tail = z <= addDays(w, 6);
    out.push({ w, c0: head ? dowMon(a) : 0, c1: tail ? dowMon(z) : 6, head, tail });
  }
  return out;
}

export interface DayCell {
  readonly key: string;
  readonly dow: string;
  readonly date: number;
  readonly weekend: boolean;
  readonly today: boolean;
  /** The first or last day of the event being edited. */
  readonly selEnd: boolean;
  readonly selMid: boolean;
  readonly picked: boolean;
}

export interface Ribbon {
  readonly sid: string;
  readonly kind: ItemKind;
  readonly colour: number;
  /** CSS grid lines, 1-based: column `colStart / colEnd`, row `row`. */
  readonly colStart: number;
  readonly colEnd: number;
  readonly row: number;
  /** A one-day event: its own day is marked, the label runs into two columns beside it. */
  readonly one: boolean;
  readonly right: boolean;
  readonly head: boolean;
  readonly tail: boolean;
  readonly time: string | null;
  readonly title: string;
  readonly who: string | null;
  readonly badge: string | null;
  readonly aria: string;
  /** The day the piece starts on: what a tap on it means. */
  readonly day: string;
  readonly selected: boolean;
  /** Grips on the true ends of a selected whole-day stretch, placed by day columns. */
  readonly grips: {
    readonly start: boolean;
    readonly end: boolean;
    readonly n: number;
    readonly a: number;
    readonly b: number;
  } | null;
}

export interface WeekRow {
  readonly start: string;
  readonly number: number;
  readonly range: string;
  readonly days: readonly DayCell[];
  readonly ribbons: readonly Ribbon[];
  readonly lines: readonly Line[];
  /** Changes listed in this week ("3 changes ▾"); 0 says "same as A" when the plan is here. */
  readonly changes: number;
  readonly samePlan: boolean;
}

export type Block =
  | { readonly kind: "week"; readonly row: WeekRow }
  | {
      readonly kind: "fold";
      readonly rows: readonly WeekRow[];
      readonly label: string;
      readonly summary: string;
    };

const ORDER: Record<ItemKind, number> = { agreed: 0, plan: 1, ghost: 2 };

function inWeek(e: Timed, w: string): boolean {
  const z = addDays(w, 6);
  return e.startLocal.slice(0, 10) <= z && lastDay(e) >= w;
}

function weekRow(
  w: string,
  model: Model,
  opts: {
    readonly today: string;
    readonly colours: ReadonlyMap<string, number>;
    readonly nameOf: NameOf;
    readonly selected: string | null;
    readonly picked: string | null;
  },
): WeekRow {
  const z = addDays(w, 6);
  const here = model.items
    .filter((it) => inWeek(it.e, w))
    .sort((x, y) => {
      if (x.kind !== y.kind) return ORDER[x.kind] - ORDER[y.kind];
      return x.e.startLocal < y.e.startLocal ? -1 : x.e.startLocal > y.e.startLocal ? 1 : 0;
    });
  const sel = model.items.find((it) => it.kind === "plan" && it.e.sid === opts.selected)?.e ?? null;
  const lanes: number[][] = [];
  const ribbons: Ribbon[] = [];
  for (const it of here) {
    const e = it.e;
    const pc = pieces(e).find((p) => p.w === w);
    if (pc === undefined) continue;
    const one = pc.c0 === pc.c1;
    const right = one && pc.c0 > 4;
    const s = one ? (right ? pc.c0 - 2 : pc.c0) : pc.c0;
    const end = one ? (right ? pc.c0 : pc.c0 + 2) : pc.c1;
    let lane = lanes.findIndex((occ) => !occ.some((c) => c >= s && c <= end));
    if (lane < 0) {
      lanes.push([]);
      lane = lanes.length - 1;
    }
    for (let c = s; c <= end; c++) lanes[lane]?.push(c);
    const isSel = it.kind === "plan" && sel !== null && e.sid === sel.sid;
    const gs = isSel && e.allDay && pc.head;
    const ge = isSel && e.allDay && pc.tail;
    ribbons.push({
      sid: e.sid,
      kind: it.kind,
      colour: opts.colours.get(colourKey(e)) ?? 0,
      colStart: s + 1,
      colEnd: end + 2,
      row: lane + 2,
      one,
      right,
      head: pc.head,
      tail: pc.tail,
      time: e.allDay ? null : hm(e.startLocal),
      title: e.title,
      who: whoTag(e, opts.nameOf),
      badge: it.badge,
      aria: `${whenText(e)}: ${e.title}, for ${whoText(e.who, opts.nameOf)} (${it.badge ?? (it.kind === "plan" ? "proposed" : it.kind)})`,
      day: addDays(w, pc.c0),
      selected: isSel,
      grips: gs || ge ? { start: gs, end: ge, n: end - s + 1, a: pc.c0 - s, b: pc.c1 - s } : null,
    });
  }
  const selDays = sel === null ? [] : dayKeys(sel);
  const selFirst = sel === null ? null : sel.startLocal.slice(0, 10);
  const selLast = sel === null ? null : lastDay(sel);
  const days: DayCell[] = DOW.map((dow, i) => {
    const key = addDays(w, i);
    const inSel = selDays.includes(key);
    const isEnd = key === selFirst || key === selLast;
    return {
      key,
      dow,
      date: utc(key).getUTCDate(),
      weekend: i >= 5,
      today: key === opts.today,
      selEnd: inSel && isEnd,
      selMid: inSel && !isEnd,
      picked: key === opts.picked,
    };
  });
  const lines = model.lines.filter((l) => l.day >= w && l.day <= z);
  const changes = lines.filter((l) => l.kind !== "warn").length;
  return {
    start: w,
    number: isoWeek(w),
    range: `${shortDay(w)} – ${shortDay(z)}`,
    days,
    ribbons,
    lines,
    changes,
    samePlan: model.compared && changes === 0 && here.some((it) => it.kind === "plan"),
  };
}

/**
 * The weeks to draw, folded where nothing is proposed (or, for what is agreed alone,
 * where nothing at all is): from this week (or the plan's first, if earlier) to the last
 * event drawn, at least four weeks, plus `more`. The selected event's weeks and the
 * week either side never fold.
 */
export function weekBlocks(
  model: Model,
  opts: {
    readonly today: string;
    readonly colours: ReadonlyMap<string, number>;
    readonly nameOf: NameOf;
    readonly selected: string | null;
    readonly picked: string | null;
    /** True for "what is agreed": fold only empty weeks. */
    readonly agreedOnly: boolean;
    readonly more: number;
  },
): Block[] {
  const thisWeek = weekStart(opts.today);
  const proposed = model.items.filter((it) => it.kind !== "agreed");
  // A plan starts at its own first week (empty weeks before it are noise); what is
  // agreed, or an empty draft, starts at this week.
  let first = opts.agreedOnly || proposed.length === 0 ? thisWeek : null;
  for (const it of proposed) {
    const w = weekStart(it.e.startLocal);
    if (first === null || w < first) first = w;
  }
  if (first === null) first = thisWeek;
  let last = first;
  for (const it of opts.agreedOnly ? model.items : proposed.length > 0 ? proposed : model.items) {
    const w = weekStart(lastDay(it.e));
    if (w > last) last = w;
  }
  if (opts.agreedOnly) last = addDays(last, 7);
  last = addDays(last, 7 * opts.more);
  if (last < addDays(first, 21)) last = addDays(first, 21);
  const start = first;

  const sel = model.items.find((it) => it.kind === "plan" && it.e.sid === opts.selected)?.e;
  const keep =
    sel === undefined
      ? null
      : { from: addDays(weekStart(sel.startLocal), -7), to: addDays(weekStart(lastDay(sel)), 7) };
  const picked = opts.picked === null ? null : weekStart(opts.picked);
  const foldable = (w: string) => {
    if (keep !== null && w >= keep.from && w <= keep.to) return false;
    if (w === picked) return false;
    const pool = opts.agreedOnly ? model.items : proposed;
    return !pool.some((it) => inWeek(it.e, w)) && !model.lines.some((l) => weekStart(l.day) === w);
  };

  const weeks: string[] = [];
  for (let w = first; w <= last; w = addDays(w, 7)) weeks.push(w);
  const blocks: Block[] = [];
  for (let i = 0; i < weeks.length; ) {
    const w = weeks[i] ?? start;
    if (!foldable(w)) {
      blocks.push({ kind: "week", row: weekRow(w, model, opts) });
      i++;
      continue;
    }
    let j = i;
    while (j < weeks.length && foldable(weeks[j] ?? start)) j++;
    const run = weeks.slice(i, j);
    const a = run[0] ?? w;
    const z = run.at(-1) ?? w;
    const titles = [
      ...new Set(
        model.items
          .filter((it) => it.kind === "agreed")
          .filter((it) => it.e.startLocal.slice(0, 10) <= addDays(z, 6) && lastDay(it.e) >= a)
          .map((it) => it.e.title),
      ),
    ];
    blocks.push({
      kind: "fold",
      rows: run.map((x) => weekRow(x, model, opts)),
      label: `${run.length > 1 ? `Weeks ${isoWeek(a)}–${isoWeek(z)}` : `Week ${isoWeek(a)}`} · ${shortDay(a)} – ${shortDay(addDays(z, 6))}`,
      summary: titles.length > 0 ? `agreed: ${titles.join(", ")}` : "nothing planned",
    });
    i = j;
  }
  return blocks;
}
