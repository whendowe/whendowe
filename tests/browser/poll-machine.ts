// SPDX-License-Identifier: AGPL-3.0-or-later
import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import type { Page } from "./fixtures.js";

// The poll picker's state machine (DESIGN §9 rc17): a model of what the form should
// hold, the actions a person can take, how each one changes the model, and how to take
// it on the real page. poll-machine.spec.ts draws sequences of these with Hegel, and
// pins the shrunken ones it finds as plain replays.
//
// The model is written from the owner-approved behaviour (the clickable mockup,
// 2026-10-24), not from the script: it holds the options as a person sees them.

export const MAX = 10;
export const LENGTHS = [30, 60, 90, 120, 180, 240] as const;

interface Time {
  date: string;
  own: string | null;
}
interface Stretch {
  from: string;
  to: string;
}
export interface Model {
  kind: "times" | "days";
  start: string;
  length: number;
  times: Time[];
  days: Stretch[];
  pending: string | null;
  asking: string | null;
  view: { year: number; month: number };
}

export type Action =
  | { type: "tap"; day: number }
  | { type: "month"; by: -1 | 1 }
  | { type: "kind"; kind: "times" | "days" }
  | { type: "start"; time: string }
  | { type: "length"; minutes: number }
  | { type: "again" }
  | { type: "another"; option: number }
  | { type: "own"; option: number; time: string }
  | { type: "remove"; option: number }
  | { type: "choose"; chip: number };

/** The fresh poll form (poll-new.html) on the frozen day, 24 Oct 2026. */
export function initial(): Model {
  return {
    kind: "times",
    start: "19:00",
    length: 180,
    times: [],
    days: [],
    pending: null,
    asking: null,
    view: { year: 2026, month: 9 },
  };
}

const date = (k: string) => Temporal.PlainDate.from(k);
const pad = (n: number) => String(n).padStart(2, "0");
export const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const clock = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

/** The days on screen: whole Monday-to-Sunday weeks around the month. */
export function grid(view: Model["view"]): string[] {
  const first = Temporal.PlainDate.from({ year: view.year, month: view.month + 1, day: 1 });
  const last = first.add({ months: 1 }).subtract({ days: 1 });
  const from = first.subtract({ days: first.dayOfWeek - 1 });
  const to = last.add({ days: 7 - last.dayOfWeek });
  const days: string[] = [];
  for (let d = from; Temporal.PlainDate.compare(d, to) <= 0; d = d.add({ days: 1 })) {
    days.push(d.toString());
  }
  return days;
}

const startOf = (m: Model, t: Time) => t.own ?? m.start;

/** The options as listed, soonest first: the order the letters A, B, C… follow. */
export function options(m: Model): (Time | Stretch)[] {
  if (m.kind === "days") {
    return [...m.days].sort((a, b) =>
      a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1,
    );
  }
  return [...m.times].sort((a, b) =>
    a.date === b.date ? minutes(startOf(m, a)) - minutes(startOf(m, b)) : a.date < b.date ? -1 : 1,
  );
}
const timesOn = (m: Model, day: string) =>
  options(m).filter((o): o is Time => "date" in o && o.date === day);

/** What the plain rows must carry: the server's view of the options. */
export function rows(m: Model): { start: string; end: string }[] {
  return options(m).map((o) => {
    if ("from" in o) return { start: `${o.from}T00:00`, end: `${o.to}T00:00` };
    const s = minutes(startOf(m, o));
    const end = s + m.length;
    return {
      start: `${o.date}T${clock(s)}`,
      end: `${date(o.date)
        .add({ days: Math.floor(end / 1440) })
        .toString()}T${clock(end % 1440)}`,
    };
  });
}

/** The chips the "which to remove?" panel shows: one per time on the day, then Remove all, Keep. */
export function chips(m: Model): number {
  return m.asking === null ? 0 : timesOn(m, m.asking).length + 2;
}

/** Apply an action to the model, exactly as a person would expect the form to change. */
export function step(m: Model, a: Action): void {
  const opts = options(m);
  const full = opts.length >= MAX;
  switch (a.type) {
    case "tap": {
      const day = grid(m.view)[a.day];
      if (day === undefined) throw new Error(`no day ${a.day} on screen`);
      if (m.kind === "days") {
        if (m.pending === null) {
          if (!full) m.pending = day;
        } else {
          const [from, to] = m.pending < day ? [m.pending, day] : [day, m.pending];
          m.days.push({ from, to });
          m.pending = null;
        }
        break;
      }
      const on = timesOn(m, day);
      if (on.length === 0) {
        m.asking = null;
        if (!full) m.times.push({ date: day, own: null });
      } else if (on.length === 1) {
        m.asking = null;
        m.times = m.times.filter((t) => t.date !== day);
      } else {
        m.asking = m.asking === day ? null : day;
      }
      break;
    }
    case "month": {
      const v = Temporal.PlainDate.from({ year: m.view.year, month: m.view.month + 1, day: 1 }).add(
        {
          months: a.by,
        },
      );
      m.view = { year: v.year, month: v.month - 1 };
      break;
    }
    case "kind":
      if (a.kind !== m.kind) {
        m.kind = a.kind;
        m.pending = null;
        m.asking = null;
      }
      break;
    case "start":
      m.start = a.time;
      break;
    case "length":
      m.length = a.minutes;
      break;
    case "again": {
      const last = opts[opts.length - 1];
      if (last === undefined || full) break;
      let moved: string;
      if ("from" in last) {
        moved = date(last.from).add({ days: 7 }).toString();
        m.days.push({ from: moved, to: date(last.to).add({ days: 7 }).toString() });
      } else {
        moved = date(last.date).add({ days: 7 }).toString();
        m.times.push({ date: moved, own: last.own });
      }
      m.view = { year: date(moved).year, month: date(moved).month - 1 };
      break;
    }
    case "another": {
      const o = opts[a.option];
      if (o === undefined || !("date" in o) || full) break;
      // After the day's last time; if that would run past midnight, before its first.
      const starts = timesOn(m, o.date).map((t) => minutes(startOf(m, t)));
      let s = Math.max(...starts) + m.length;
      if (s + m.length > 1440) s = Math.max(0, Math.min(...starts) - m.length);
      m.times.push({ date: o.date, own: clock(s) });
      break;
    }
    case "own": {
      const o = opts[a.option];
      if (o !== undefined && "date" in o) o.own = a.time === m.start ? null : a.time;
      break;
    }
    case "remove": {
      const o = opts[a.option];
      m.times = m.times.filter((t) => t !== o);
      m.days = m.days.filter((d) => d !== o);
      break;
    }
    case "choose": {
      if (m.asking === null) break;
      const on = timesOn(m, m.asking);
      const day = m.asking;
      const one = on[a.chip];
      if (one !== undefined) m.times = m.times.filter((t) => t !== one);
      else if (a.chip === on.length) m.times = m.times.filter((t) => t.date !== day);
      m.asking = null; // a time removed, all removed, or Keep: the panel closes
      break;
    }
  }
  // The same option twice is one option (the server refuses repeats): the earlier copy
  // stays, the later one goes.
  const seen = new Set<string>();
  const first = (k: string) => !seen.has(k) && seen.add(k) !== undefined;
  if (m.kind === "days") m.days = m.days.filter((d) => first(`${d.from}/${d.to}`));
  else m.times = m.times.filter((t) => first(`${t.date}/${startOf(m, t)}`));
  // The panel only asks about a day that still has several times.
  if (m.kind === "days" || (m.asking !== null && timesOn(m, m.asking).length < 2)) m.asking = null;
}

/** A short, readable name for an action, for the replayable failure log. */
export function describe(a: Action): string {
  switch (a.type) {
    case "tap":
      return `tap(${a.day})`;
    case "month":
      return a.by < 0 ? "prev" : "next";
    case "kind":
      return `kind(${a.kind})`;
    case "start":
      return `start(${a.time})`;
    case "length":
      return `length(${a.minutes})`;
    case "again":
      return "again";
    case "another":
      return `another(${a.option})`;
    case "own":
      return `own(${a.option},${a.time})`;
    case "remove":
      return `remove(${a.option})`;
    case "choose":
      return `choose(${a.chip})`;
  }
}

/** Take the action on the real page, through the controls a person would use. */
export async function act(page: Page, a: Action): Promise<void> {
  const ui = page.locator(".wd-picker");
  const option = (i: number) => ui.locator(".wd-opts li").nth(i);
  // fill() fires both input and change, as typing a time does. Nothing more is sent: the
  // change re-renders the list, so the same locator may then match another option's input,
  // or none, when the edit made this option a repeat of another.
  const setTime = (input: ReturnType<typeof ui.locator>, time: string) => input.fill(time);
  switch (a.type) {
    case "tap":
      return ui.locator(".wd-cal .wd-day").nth(a.day).click();
    case "month":
      return ui.getByRole("button", { name: a.by < 0 ? "Previous month" : "Next month" }).click();
    case "kind":
      return ui
        .getByRole("button", { name: a.kind === "days" ? "A stretch of days" : "A time on a day" })
        .click();
    case "start":
      return setTime(ui.locator(".wd-row input[type=time]"), a.time);
    case "length":
      await ui.locator(".wd-row select").selectOption(String(a.minutes));
      return;
    case "again":
      return ui.getByRole("button", { name: "Same again, +1 week" }).click();
    case "another":
      return option(a.option).getByRole("button", { name: "another time this day" }).click();
    case "own":
      return setTime(option(a.option).locator("input[type=time]"), a.time);
    case "remove":
      return option(a.option).locator(".wd-x").click();
    case "choose":
      return ui.locator(".wd-chooser .wd-chips button").nth(a.chip).click();
  }
}

const seenSchema = z.object({
  allDay: z.boolean().nullable(),
  rows: z.array(z.object({ start: z.string().nullable(), end: z.string().nullable() })),
  listed: z.number(),
  days: z.array(z.object({ label: z.string(), badge: z.string() })),
  chips: z.number(),
});

/**
 * Everything the checks compare, read from the page in one round trip. Plain
 * JavaScript, run in the page: this project has no DOM types, by design (src/ must not
 * use them), so the result is checked with zod instead.
 */
const READ = `(() => {
  const form = document.querySelector("form[data-picker=poll]");
  const value = (name) => { const e = form.querySelector('[name="' + name + '"]'); return e ? e.value : null; };
  const allDay = form.querySelector("[name=allDay]");
  const chooser = form.querySelector(".wd-chooser");
  return {
    allDay: allDay ? allDay.checked : null,
    rows: Array.from({ length: ${MAX} }, (_, i) => ({ start: value("start_" + i), end: value("end_" + i) })),
    listed: form.querySelectorAll(".wd-opts li:not(.wd-empty)").length,
    days: Array.from(form.querySelectorAll(".wd-cal .wd-day"), (b) => ({
      label: b.getAttribute("aria-label") || "",
      badge: (b.querySelector(".wd-badge") || { textContent: "" }).textContent,
    })),
    chips: chooser === null || chooser.hidden ? 0 : chooser.querySelectorAll("button").length,
  };
})()`;

export async function read(page: Page) {
  return seenSchema.parse(await page.evaluate(READ));
}
