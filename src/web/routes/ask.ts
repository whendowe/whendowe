// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { Temporal } from "temporal-polyfill";
import { ZodError } from "zod";
import { groupDefaults, UnreachableAddressError } from "../../events/participation.js";
import { PollInputError } from "../../events/poll.js";
import { holdAction } from "../../held.js";
import { uuidv7 } from "../../ids.js";
import { findGroupForMember, listMembers } from "../../people/group.js";
import { type KnownPerson, listKnownPeople } from "../../people/known.js";
import {
  type AskBody,
  type AskDraft,
  askAsEvent,
  askDraft,
  discardAskDraft,
  findAskDraft,
  listAskDrafts,
  MAX_ASK_EMAILS,
  makesEvent,
  saveAskDraft,
  startAskDraft,
} from "../../plans/ask.js";
import type { PlanEventLike } from "../../plans/diff.js";
import { MAX_OPTION_EVENTS, MAX_OPTIONS, madeLike } from "../../plans/plan.js";
import { addDays, colourKey, compareModel, dayLabel, weekBlocks } from "../../plans/weeks.js";
import { askDragAssets } from "../ask-drag.js";
import { type Html, html } from "../layout.js";
import {
  applyPick,
  type Chip,
  carriedFilter,
  NO_LEVERS,
  peoplePicker,
  pickerAction,
  readChips,
} from "../people-picker.js";
import { editorScript, PLAN_STYLE, statusLine } from "../plan-editor.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  requireSignedIn,
  type SignedIn,
  verifyFormCsrf,
} from "../session.js";
import type { AuthDeps } from "./auth.js";
import { EVENTS_PATH, zoneOptions } from "./events.js";
import { lineList, PLANS_PATH, weeksHtml } from "./plans.js";

// Ask when (DESIGN §10 *Asking when*, rc46, A2): one page to ask when, simple by default.
// This is the page as a plain form — every form works without JavaScript (rc15) — and the
// Days calendar is drawn over it next. Every button saves the whole question first, then does
// its one thing, and the page after says "Saved": nothing typed is ever lost by a tap.

export const ASK_PATH = "/ask";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const LETTERS = "ABCDEFGHIJ";

/** One event as the form shows it: a day, a time from and to (none = all day), a last day. */
interface EventRow {
  readonly day: string;
  readonly from: string;
  readonly to: string;
  readonly last: string;
}

function rowOf(e: AskBody["options"][number][number]): EventRow {
  if (e.allDay) {
    const last = DAY.test(e.endLocal) ? addDays(e.endLocal, -1) : "";
    return { day: e.startLocal, from: "", to: "", last: last === e.startLocal ? "" : last };
  }
  return {
    day: e.startLocal.slice(0, 10),
    from: e.startLocal.slice(11, 16),
    to: e.endLocal.slice(11, 16),
    last: "",
  };
}

function eventOf(r: EventRow): AskBody["options"][number][number] {
  const day = DAY.test(r.day) ? r.day : "";
  if (TIME.test(r.from)) {
    const to = TIME.test(r.to) ? r.to : "";
    // rc58: a To earlier than From is the next day, as calendar apps read it.
    const endDay = day !== "" && to < r.from ? addDays(day, 1) : day;
    return {
      allDay: false,
      startLocal: day === "" ? "" : `${day}T${r.from}`,
      endLocal: day === "" || to === "" ? "" : `${endDay}T${to}`,
    };
  }
  const last = DAY.test(r.last) && r.last >= day ? r.last : day;
  return { allDay: true, startLocal: day, endLocal: day === "" ? "" : addDays(last, 1) };
}

const EMPTY_EVENT = eventOf({ day: "", from: "", to: "", last: "" });

function str(form: Record<string, unknown>, key: string): string {
  const v = form[key];
  return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
}

/** The form as a body: what was typed, kept as typed; nothing here refuses. */
function bodyOf(form: Record<string, unknown>, before: AskBody): AskBody {
  const options = before.options.map((events, i) =>
    events.map((was, j) => {
      const name = str(form, `o${i}e${j}name`).slice(0, 200).trim();
      return {
        ...eventOf({
          day: str(form, `o${i}e${j}day`),
          from: str(form, `o${i}e${j}from`),
          to: str(form, `o${i}e${j}to`),
          last: str(form, `o${i}e${j}last`),
        }),
        // rc49: an event keeps its identity through every edit, and has its own name.
        ...(was.sid === undefined ? {} : { sid: was.sid }),
        title: name === "" ? null : name,
      };
    }),
  );
  const { emails, people } = fromChips(readChips(form, MAX_ASK_EMAILS));
  const text = (k: string, max: number) => str(form, k).slice(0, max);
  const opt = (k: string, max: number) => {
    const v = text(k, max).trim();
    return v === "" ? null : v;
  };
  return {
    title: text("title", 200),
    location: opt("location", 200),
    note: opt("note", 2000),
    tzid: opt("tzid", 64),
    options,
    emails,
    people,
    defaults: {
      from: TIME.test(str(form, "new_from")) ? str(form, "new_from") : null,
      hours: HOURS.includes(Number(str(form, "new_hours"))) ? Number(str(form, "new_hours")) : 2,
    },
  };
}

/** rc49: every event has an identity from when it is made; one made without gets one now. */
function withSids(body: AskBody, newId: () => string = uuidv7): AskBody {
  return {
    ...body,
    options: body.options.map((o) =>
      o.map((e) => (e.sid === undefined ? { ...e, sid: newId() } : e)),
    ),
  };
}

/** The question's people as chips (rc48): addresses as typed, then people chosen. */
function chipsOf(body: AskBody): Chip[] {
  const base = { editTier: "view", visibility: "FULL", ask: "" } as const;
  return [
    ...body.emails.map((value): Chip => ({ ...base, kind: "email", value, from: null })),
    ...(body.people ?? []).map(
      (p): Chip => ({ ...base, kind: "person", value: p.id, from: p.from }),
    ),
  ];
}

function fromChips(chips: readonly Chip[]): Pick<AskBody, "emails" | "people"> {
  return {
    emails: chips.filter((c) => c.kind === "email").map((c) => c.value),
    people: chips.filter((c) => c.kind === "person").map((c) => ({ id: c.value, from: c.from })),
  };
}

/** Who the picker knows of, and the question's own group as a chip naming its members. */
interface AskPeople {
  readonly known: readonly KnownPerson[];
  readonly group: { readonly name: string; readonly members: readonly string[] } | null;
  /** The group's people, already asked through it. */
  readonly inGroup: ReadonlySet<string>;
}

async function askPeople(deps: AuthDeps, me: SignedIn, draft: AskDraft): Promise<AskPeople> {
  const known = await listKnownPeople(deps.storage, me.personId);
  const membership =
    draft.groupId === null
      ? null
      : await findGroupForMember(deps.storage, draft.groupId, me.personId);
  if (membership === null) return { known, group: null, inGroup: new Set() };
  const members = (await listMembers(deps.storage, membership)).filter(
    (m) => m.personId !== me.personId,
  );
  return {
    known,
    group: { name: membership.group.name, members: members.map((m) => m.shown.name) },
    inGroup: new Set(members.map((m) => m.personId)),
  };
}

/** Lengths a tapped day can take (rc46: "New ones are 19:00, 2 h"). */
const HOURS = [1, 2, 3, 4, 5, 6];

/** A day tapped on the calendar, as an event of the defaults: a time and length, or all day. */
function tappedEvent(day: string, body: AskBody): AskBody["options"][number][number] {
  const from = body.defaults?.from ?? null;
  if (from === null) return eventOf({ day, from: "", to: "", last: "" });
  const start = Temporal.PlainDateTime.from(`${day}T${from}`);
  const end = start.add({ hours: body.defaults?.hours ?? 2 });
  // Past midnight is the next day: kept as a timed event that ends then.
  return {
    allDay: false,
    startLocal: `${day}T${from}`,
    endLocal: end.toString().slice(0, 16),
  };
}

/** A real calendar day, not only its shape: a drag's value is checked like any other. */
function isDate(s: string | undefined): s is string {
  if (s === undefined || !DAY.test(s)) return false;
  try {
    Temporal.PlainDate.from(s, { overflow: "reject" });
    return true;
  } catch {
    return false;
  }
}

/**
 * One end of an event moved by a drag (rc47), or the event as it was when the move would put
 * that end past the other: a drag never turns an event inside out.
 */
function movedEnd(
  e: AskBody["options"][number][number],
  which: string | undefined,
  day: string,
  hour: string | undefined,
): AskBody["options"][number][number] {
  if (hour === undefined) {
    if (!e.allDay || !DAY.test(e.startLocal) || !DAY.test(e.endLocal)) return e;
    if (which === "start") return day < e.endLocal ? { ...e, startLocal: day } : e;
    return day >= e.startLocal ? { ...e, endLocal: addDays(day, 1) } : e;
  }
  if (e.allDay || e.startLocal === "" || e.endLocal === "") return e;
  const at = Temporal.PlainDateTime.from(`${day}T${hour}:00`);
  if (which === "start") {
    const start = at.toString().slice(0, 16);
    return start < e.endLocal ? { ...e, startLocal: start } : e;
  }
  const end = at.add({ hours: 1 }).toString().slice(0, 16);
  return end > e.startLocal ? { ...e, endLocal: end } : e;
}

/** The one thing a button does after the save. */
function act(body: AskBody, action: string): AskBody {
  // rc46: a free day tapped on the calendar becomes a new option, of the defaults.
  const add = /^add:(\d{4}-\d{2}-\d{2})$/.exec(action);
  if (add !== null && body.options.length < MAX_OPTIONS)
    return { ...body, options: [...body.options, [tappedEvent(add[1] ?? "", body)]] };
  const hour = /^addh:(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(action);
  if (hour !== null && body.options.length < MAX_OPTIONS) {
    const start = Temporal.PlainDateTime.from(`${hour[1]}T${hour[2]}`);
    const end = start.add({ hours: body.defaults?.hours ?? 2 });
    return {
      ...body,
      options: [
        ...body.options,
        [
          {
            allDay: false,
            startLocal: start.toString().slice(0, 16),
            endLocal: end.toString().slice(0, 16),
          },
        ],
      ],
    };
  }
  // rc47: a drag along a week's empty days, one all-day option over them.
  const span = /^span:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(action);
  if (span !== null && isDate(span[1]) && isDate(span[2]) && body.options.length < MAX_OPTIONS) {
    const [a, z] = [span[1] ?? "", span[2] ?? ""].sort();
    return {
      ...body,
      options: [
        ...body.options,
        [{ allDay: true, startLocal: a ?? "", endLocal: addDays(z ?? "", 1) }],
      ],
    };
  }
  // rc47: an end dragged — an all-day event's first or last day, or a timed one's hour.
  const move = /^move:(\d+):(\d+):(start|end):(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):00)?$/.exec(
    action,
  );
  if (move !== null && isDate(move[4])) {
    const [i, j] = [Number(move[1]), Number(move[2])];
    const which = move[3];
    const day = move[4] ?? "";
    const hour = move[5];
    return {
      ...body,
      options: body.options.map((o, k) =>
        k !== i ? o : o.map((e, m) => (m === j ? movedEnd(e, which, day, hour) : e)),
      ),
    };
  }
  const remove = /^remove:(\d+)$/.exec(action);
  if (remove !== null)
    return { ...body, options: body.options.filter((_, k) => k !== Number(remove[1])) };
  if (action === "option" && body.options.length < MAX_OPTIONS)
    return { ...body, options: [...body.options, [EMPTY_EVENT]] };
  // rc49: "+ Like A", a copy of A — the same events, the same identities — to change.
  const [first] = body.options;
  if (action === "like" && first !== undefined && body.options.length < MAX_OPTIONS)
    return { ...body, options: [...body.options, first] };
  const and = /^and:(\d+)$/.exec(action);
  if (and !== null) {
    const i = Number(and[1]);
    return {
      ...body,
      options: body.options.map((o, k) =>
        k === i && o.length < MAX_OPTION_EVENTS ? [...o, EMPTY_EVENT] : o,
      ),
    };
  }
  const drop = /^drop:(\d+):(\d+)$/.exec(action);
  if (drop !== null) {
    const [i, j] = [Number(drop[1]), Number(drop[2])];
    return {
      ...body,
      options: body.options
        .map((o, k) => (k === i ? o.filter((_, m) => m !== j) : o))
        .filter((o) => o.length > 0),
    };
  }
  return body;
}

/** Who asking would email: the group's who see what it plans, and the addresses, not you. */
async function askedCount(deps: AuthDeps, me: SignedIn, draft: AskDraft): Promise<number> {
  const membership =
    draft.groupId === null
      ? null
      : await findGroupForMember(deps.storage, draft.groupId, me.personId);
  const fromGroup =
    membership === null
      ? []
      : (await groupDefaults(deps.storage, membership))
          .filter((d) => d.visibility === "FULL" || d.visibility === "DETAILS")
          .map((d) => d.personId)
          .filter((id) => id !== me.personId);
  const chosen = new Set(
    (draft.body.people ?? []).map((p) => p.id).filter((id) => !fromGroup.includes(id)),
  );
  return fromGroup.length + chosen.size + draft.body.emails.length;
}

function readBack(draft: AskDraft, asked: number, makes: boolean, noMail: boolean): Html {
  const n = draft.body.options.length;
  const letters = [...LETTERS.slice(0, n)];
  const which =
    n === 0
      ? "nothing yet"
      : n === 1
        ? html`<strong>A</strong>`
        : html`<strong>${letters.slice(0, -1).join(", ")} or ${letters.at(-1) ?? ""}</strong>`;
  const what = draft.body.title.trim() === "" ? "this" : `“${draft.body.title.trim()}”`;
  // rc50: one time and nobody to ask is an event, made at once; the button keeps its name.
  if (makes)
    return html`<p class="readback">Nobody to ask, so asking makes ${what} an event at once and tells nobody.</p>`;
  const who =
    asked === 0 ? "nobody yet — add people below" : `${asked} ${asked === 1 ? "person" : "people"}`;
  return html`<p class="readback">${noMail ? "Asking puts to" : "Asking emails"} ${who} one question: does ${which} suit for ${what}? ${
    n > 1 ? "One of them will happen." : n === 1 ? "If it suits, it happens." : ""
  }</p>`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The month shown: asked for, else the first option's, else today's. */
function monthOf(body: AskBody, asked: string | null, today: string): string {
  if (asked !== null && /^\d{4}-\d{2}$/.test(asked)) return asked;
  const first = body.options.flat().find((e) => DAY.test(e.startLocal.slice(0, 10)));
  return (first?.startLocal ?? today).slice(0, 7);
}

/**
 * The Days view (rc46), drawn by the server so it works without JavaScript: one Monday-first
 * month in whole weeks, with week numbers. A free day is a button that adds an option of the
 * defaults; a day with options links to each one's card, the sheet. Moving a month is a button
 * too, so it saves first like every other.
 */
function daysView(body: AskBody, month: string, today: string): Html {
  const first = Temporal.PlainDate.from(`${month}-01`);
  const start = first.subtract({ days: first.dayOfWeek - 1 });
  const last = first.add({ months: 1 }).subtract({ days: 1 });
  const end = last.add({ days: 7 - last.dayOfWeek });
  const onDay = new Map<string, number[]>();
  // rc47: an all-day event's first and last day carry a grip on its letter, for dragging.
  const grips = new Map<string, Grip>();
  body.options.forEach((events, i) => {
    events.forEach((e, j) => {
      const a = e.startLocal.slice(0, 10);
      if (!DAY.test(a)) return;
      const z = e.allDay && DAY.test(e.endLocal) ? addDays(e.endLocal, -1) : a;
      for (let d = a; d <= z; d = addDays(d, 1))
        onDay.set(d, [...new Set([...(onDay.get(d) ?? []), i])]);
      if (!e.allDay || z < a) return;
      if (!grips.has(`${a}|${i}`)) grips.set(`${a}|${i}`, { j, ends: a === z ? "both" : "start" });
      if (a !== z && !grips.has(`${z}|${i}`)) grips.set(`${z}|${i}`, { j, ends: "end" });
    });
  });
  const weeks: Html[] = [];
  for (let w = start; Temporal.PlainDate.compare(w, end) <= 0; w = w.add({ days: 7 })) {
    const cells: Html[] = [html`<span class="wk">${String(w.weekOfYear ?? "")}</span>`];
    for (let k = 0; k < 7; k++) {
      const d = w.add({ days: k });
      const key = d.toString();
      const out = d.month !== first.month ? " out" : "";
      const here = onDay.get(key);
      const label = `${d.day}`;
      cells.push(
        here !== undefined
          ? html`<span class="day has${out}" data-day="${key}"><b>${label}</b>${here.map((i) => {
              const g = grips.get(`${key}|${i}`);
              return html`<a class="letter" href="#o${i}" style="background:var(--o${i % 8})" aria-label="Option ${LETTERS[i] ?? ""}"${g === undefined ? "" : html` data-grip="${String(i)}:${String(g.j)}" data-ends="${g.ends}" draggable="false"`}>${LETTERS[i] ?? ""}</a>`;
            })}</span>`
          : body.options.length < MAX_OPTIONS
            ? html`<button class="day${out}${key === today ? " today" : ""}" type="submit" name="act" value="add:${key}" aria-label="Add ${key}" data-day="${key}">${label}</button>`
            : html`<span class="day${out}" data-day="${key}">${label}</span>`,
      );
    }
    weeks.push(html`<div class="wkrow">${cells}</div>`);
  }
  const prev = first.subtract({ months: 1 }).toString().slice(0, 7);
  const next = first.add({ months: 1 }).toString().slice(0, 7);
  const d = body.defaults;
  return html`<div class="days">
<div class="row nav"><button type="submit" name="act" value="month:${prev}" aria-label="Earlier month">‹</button><strong>${MONTHS[first.month - 1] ?? ""} ${String(first.year)}</strong><button type="submit" name="act" value="month:${next}" aria-label="Later month">›</button></div>
<div class="wkrow head"><span></span>${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((x) => html`<span>${x}</span>`)}</div>
${weeks}
</div>`;
}

/**
 * What a tap makes (rc46), under either view, so every save carries it: a day tapped in Days
 * is this time and length (no time: all day); an hour tapped in Hours is this length.
 */
function newOnes(body: AskBody): Html {
  const d = body.defaults;
  return html`<p class="row wrap newones"><span class="muted">New ones are</span> <label><span class="vh">From</span><input type="time" name="new_from" value="${d === undefined ? "19:00" : (d.from ?? "")}" /></label> <label><span class="vh">For</span><select name="new_hours">${HOURS.map(
    (h) =>
      html`<option value="${String(h)}"${(d?.hours ?? 2) === h ? html` selected` : ""}>${String(h)} h</option>`,
  )}</select></label> <span class="muted small">(no time: a day you tap is all day)</span></p>`;
}

/** Which end of an event a grip holds (rc47): both, for a one-day or one-hour event. */
interface Grip {
  readonly j: number;
  readonly ends: "start" | "end" | "both";
}

/** Hours shown in the Hours view: a day's waking hours. Earlier or later: the option's fields. */
const FIRST_HOUR = 7;
const LAST_HOUR = 22;
/** Days at a time in the Hours view: wide enough cells on a phone (rc46). */
const HOURS_DAYS = 4;

/** The first day the Hours view shows: asked for, else the first option's, else today. */
function fromOf(body: AskBody, asked: string | null, today: string): string {
  if (asked !== null && DAY.test(asked)) return asked;
  const first = body.options.flat().find((e) => DAY.test(e.startLocal.slice(0, 10)));
  return (first?.startLocal ?? today).slice(0, 10);
}

/** Which options a timed event covers in this hour of this day; all-day ones aside. */
function inHour(body: AskBody, day: string, hour: number): number[] {
  const a = `${day}T${String(hour).padStart(2, "0")}:00`;
  const z = `${day}T${String(hour + 1).padStart(2, "0")}:00`;
  const out = new Set<number>();
  body.options.forEach((events, i) => {
    for (const e of events)
      if (!e.allDay && e.startLocal !== "" && e.startLocal < z && (e.endLocal || e.startLocal) > a)
        out.add(i);
  });
  return [...out];
}

/**
 * The Hours view (rc46): four days at a time as an hour grid, drawn by the server like Days.
 * A free hour is a button that adds an option starting then, of the chosen length; an hour
 * with options carries their letters, links to their cards. All-day options sit above.
 */
function hoursView(body: AskBody, from: string, today: string): Html {
  const days = Array.from({ length: HOURS_DAYS }, (_, k) => addDays(from, k));
  const allDay = (day: string) => {
    const out = new Set<number>();
    body.options.forEach((events, i) => {
      for (const e of events)
        if (e.allDay && DAY.test(e.startLocal) && e.startLocal <= day && e.endLocal > day)
          out.add(i);
    });
    return [...out];
  };
  const letters = (is: readonly number[]) =>
    is.map(
      (i) =>
        html`<a class="letter" href="#o${i}" style="background:var(--o${i % 8})" aria-label="Option ${LETTERS[i] ?? ""}">${LETTERS[i] ?? ""}</a>`,
    );
  const full = body.options.length >= MAX_OPTIONS;
  // rc47: a timed event's first and last hour on screen carry a grip, for dragging that end.
  const grips = new Map<string, { readonly start: Html[]; readonly end: Html[] }>();
  const grip = (at: string, i: number, j: number, ends: Grip["ends"]) => {
    const g = grips.get(at) ?? { start: [], end: [] };
    (ends === "end" ? g.end : g.start).push(
      html`<span class="grip" data-grip="${String(i)}:${String(j)}" data-ends="${ends}" aria-hidden="true"></span>`,
    );
    grips.set(at, g);
  };
  body.options.forEach((events, i) => {
    events.forEach((e, j) => {
      // An end typed before its start, or at it, has no ends to drag yet.
      if (e.allDay || e.endLocal <= e.startLocal) return;
      const first = `${e.startLocal.slice(0, 13)}:00`;
      let last: string;
      try {
        // As typed, the end may not be a real time yet: then it shows no grips.
        const lastMinute = Temporal.PlainDateTime.from(e.endLocal).subtract({ minutes: 1 });
        last = `${lastMinute.toString().slice(0, 13)}:00`;
      } catch {
        return;
      }
      if (first === last) grip(first, i, j, "both");
      else {
        grip(first, i, j, "start");
        grip(last, i, j, "end");
      }
    });
  });
  const rows: Html[] = [];
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    const hh = String(h).padStart(2, "0");
    rows.push(
      html`<div class="hrow"><span class="hr">${hh}</span>${days.map((day) => {
        const here = inHour(body, day, h);
        const at = `${day}T${hh}:00`;
        const g = grips.get(at);
        return here.length > 0
          ? html`<span class="hour has" data-at="${at}">${g?.start ?? ""}${letters(here)}${g?.end ?? ""}</span>`
          : full
            ? html`<span class="hour" data-at="${at}"></span>`
            : html`<button class="hour" type="submit" name="act" value="addh:${at}" aria-label="Add ${day} ${hh}:00" data-at="${at}"></button>`;
      })}</div>`,
    );
  }
  return html`<div class="hours">
<div class="row nav"><button type="submit" name="act" value="from:${addDays(from, -HOURS_DAYS)}" aria-label="Earlier days">‹</button><strong>${dayLabel(from)} – ${dayLabel(addDays(from, HOURS_DAYS - 1))}</strong><button type="submit" name="act" value="from:${addDays(from, HOURS_DAYS)}" aria-label="Later days">›</button></div>
<div class="hrow head"><span></span>${days.map((day) => html`<span${day === today ? html` class="today"` : ""}>${dayLabel(day)}</span>`)}</div>
<div class="hrow allday"><span class="hr">all day</span>${days.map((day) => html`<span class="hour${allDay(day).length > 0 ? " has" : ""}">${letters(allDay(day))}</span>`)}</div>
${rows}
<p class="muted small">Earlier or later than ${String(FIRST_HOUR)}:00–${String(LAST_HOUR + 1)}:00: set it in the option below.</p>
</div>`;
}

/** Days or Hours: two views of the same options (rc46). Switching saves first. */
function viewSwitch(view: "days" | "hours"): Html {
  return html`<div class="seg viewswitch" role="group" aria-label="View"><button type="submit" name="act" value="view:days" aria-pressed="${String(view === "days")}">Days</button><button type="submit" name="act" value="view:hours" aria-pressed="${String(view === "hours")}">Hours</button></div>`;
}

/** rc58: a To earlier than From ends on the next day; the sheet says so beside it. */
const nextDay = (r: EventRow) => TIME.test(r.from) && TIME.test(r.to) && r.to < r.from;

function eventRow(
  i: number,
  j: number,
  r: EventRow & { readonly name: string },
  many: boolean,
  title: string,
): Html {
  const k = `o${i}e${j}`;
  return html`<div class="ev">${j > 0 ? html`<p class="and">and</p>` : ""}<div class="row wrap">
<label>Name <span class="muted small">(optional)</span><br /><input name="${k}name" maxlength="200" value="${r.name}" placeholder="${title.trim() === "" ? "As the question" : title.trim()}" /></label>
<label>Day<br /><input type="date" name="${k}day" value="${r.day}" /></label>
<label>From <span class="muted small">(empty: all day)</span><br /><input type="time" name="${k}from" value="${r.from}" /></label>
<label>To${nextDay(r) ? html` <span class="muted small">(next day)</span>` : ""}<br /><input type="time" name="${k}to" value="${r.to}" /></label>
<label>Last day <span class="muted small">(all day, several days)</span><br /><input type="date" name="${k}last" value="${r.last}" /></label>
${many ? html`<button class="link" type="submit" name="act" value="drop:${i}:${j}">Remove</button>` : ""}</div></div>`;
}

/** An event as the week rows draw it (rc49), or null while its time is still being typed. */
function drawn(e: AskBody["options"][number][number], title: string): PlanEventLike | null {
  const ok = e.allDay
    ? DAY.test(e.startLocal) && DAY.test(e.endLocal)
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.startLocal) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.endLocal);
  if (!ok || e.endLocal <= e.startLocal || e.sid === undefined) return null;
  const named = e.title?.trim() || title.trim();
  return {
    sid: e.sid,
    title: named === "" ? "Untitled" : named,
    allDay: e.allDay,
    startLocal: e.startLocal,
    endLocal: e.endLocal,
    who: [],
  };
}

/** An option's events as the week rows draw them: those with a time to draw. */
function drawnOf(body: AskBody, o: AskBody["options"][number] | undefined): PlanEventLike[] {
  return (o ?? []).flatMap((e) => {
    const d = drawn(e, body.title);
    return d === null ? [] : [d];
  });
}

/**
 * Option i's week rows (rc49): compared with A when it was made like A, or A alone instead
 * when seeing A. On the Ask page hue is the option (rc46): every event drawn is in its colour.
 */
function optionModel(
  body: AskBody,
  i: number,
  today: string,
  opts: { readonly seeing: boolean; readonly selected: string | null },
) {
  const a = drawnOf(body, body.options[0]);
  const here = drawnOf(body, body.options[i]);
  const first = body.options[0];
  const like = i > 0 && first !== undefined && madeLike(first, body.options[i] ?? []);
  const model = compareModel({
    agreed: [],
    events: opts.seeing ? a : here,
    base: like && !opts.seeing ? a : null,
    nameOf: () => "",
  });
  const hue = opts.seeing ? 0 : i % 8;
  const colours = new Map([...a, ...here].map((e) => [colourKey(e), hue]));
  const blocks = weekBlocks(model, {
    today,
    colours,
    nameOf: () => "",
    selected: opts.selected,
    picked: null,
    agreedOnly: false,
    more: 0,
  });
  return { model, blocks, hue, like };
}

/** "N changes from A", listed; or that it is the same as A. */
function changesFromA(model: ReturnType<typeof optionModel>["model"]): Html {
  const changes = model.lines.filter((l) => l.kind !== "warn" && l.primary);
  return model.changes === 0
    ? html`<span>Same as A — change something to make it a choice.</span>`
    : html`<details><summary>${String(model.changes)} change${model.changes > 1 ? "s" : ""} from A</summary>${lineList(changes)}</details>`;
}

/**
 * An option made like A (rc49), drawn as week rows of that option alone, its changes from A
 * marked and listed; "See A" draws A in its place instead. One option at a time, never two
 * layers blended (§10 *Plans*). The list of its events below stays the editor.
 */
function likeA(body: AskBody, i: number, today: string, seeing: boolean): Html {
  const { model, blocks } = optionModel(body, i, today, { seeing, selected: null });
  const letter = LETTERS[i] ?? "";
  const head = seeing
    ? html`<p class="row wrap"><span>Showing <strong>A</strong>, which ${letter} is like.</span> <button type="submit" name="act" value="see:">Back to ${letter}</button></p>`
    : html`<div class="row wrap">${changesFromA(model)} <button type="submit" name="act" value="see:${String(i)}">See A</button></div>`;
  return html`<div class="like">${head}${weeksHtml(
    blocks,
    { day: () => `#o${i}`, ribbon: () => `#o${i}` },
    { compareLetter: seeing ? null : "A", selColour: null, editing: false },
  )}</div>`;
}

/** The option being edited on its week rows (rc49, A5b), and the event chosen in it. */
interface Editing {
  readonly i: number;
  readonly sid: string | null;
}

/**
 * The week-row editor behind an option's Edit (rc49, A5b; P4's): the option's week rows, one
 * of its events chosen. With JavaScript its first or last day is picked up and put down, or
 * dragged, and the script writes that event's own fields below and sends the form; a timed
 * one moves to the day tapped. Without it, those fields are the editor, as everywhere here.
 * Tapping another event chooses it: a button, so what was typed is saved first.
 */
function editWeeks(body: AskBody, editing: Editing, today: string): Html {
  const { i } = editing;
  const { model, blocks, hue, like } = optionModel(body, i, today, {
    seeing: false,
    selected: editing.sid,
  });
  const events = body.options[i] ?? [];
  const j = events.findIndex((e) => e.sid === editing.sid);
  const sel = events[j];
  const k = `o${i}e${j}`;
  const hint =
    sel === undefined
      ? "Its events show here once they have a day and a time. Tap one to move it."
      : sel.allDay
        ? "Tap its first or last day to pick it up, then tap where it goes. Or drag an end."
        : "Tap a day to move it there; its times are below.";
  return html`<div class="like edit">${like ? html`<div class="row wrap">${changesFromA(model)}</div>` : ""}
<p class="small muted" data-hint>${hint}</p>
<div data-plan-editor data-sel="${sel === undefined ? "" : (editing.sid ?? "")}" data-grab="" data-form="ask" data-kind="${sel?.allDay ? "days" : "time"}" data-from="${k}day" data-to="${k}last" data-day="${k}day">${weeksHtml(
    blocks,
    {
      day: () => `#o${i}`,
      ribbon: () => `#o${i}`,
      act: (r) => (r.kind === "plan" ? `edit:${String(i)}:${r.sid}` : null),
    },
    { compareLetter: like ? "A" : null, selColour: `var(--o${hue})`, editing: sel !== undefined },
  )}</div>
<p><button type="submit" name="act" value="edit:">Done</button></p></div>`;
}

/** Right after a day was tapped (rc46): what it became, and Undo. */
function addedBar(b: AskBody, added: number | null): Html | "" {
  if (added === null) return "";
  const e = b.options[added]?.[0];
  if (e === undefined) return "";
  const last = e.allDay && DAY.test(e.endLocal) ? addDays(e.endLocal, -1) : e.startLocal;
  const when = e.allDay
    ? last > e.startLocal
      ? `${dayLabel(e.startLocal)} – ${dayLabel(last)}`
      : dayLabel(e.startLocal.slice(0, 10))
    : `${dayLabel(e.startLocal.slice(0, 10))}, ${e.startLocal.slice(11, 16)}`;
  return html`<p class="undo">Added ${when} as ${LETTERS[added] ?? ""} <button class="link" type="submit" name="act" value="remove:${String(added)}">Undo</button></p>`;
}

function askPage(
  draft: AskDraft,
  me: SignedIn,
  input: {
    readonly asked: number;
    /** rc50: asking makes an event at once (one time, nobody to ask). */
    readonly makesEvent: boolean;
    readonly saved: boolean;
    readonly problem: string | null;
    readonly month: string;
    readonly today: string;
    readonly view: "days" | "hours";
    /** The first day the Hours view shows. */
    readonly from: string;
    /** An option just added by tapping a day (rc46): its Undo. */
    readonly added: number | null;
    readonly people: AskPeople;
    /** The group the suggestions are narrowed to. */
    readonly filter: string | null;
    /** rc49: the option made like A that is showing A instead. */
    readonly seeing: number | null;
    /** rc49 (A5b): the option being edited on its week rows. */
    readonly editing: Editing | null;
    /** rc60: this instance sends no email; asking gives you each person's link to copy. */
    readonly noMail: boolean;
  },
): Html {
  const b = draft.body;
  const [first] = b.options;
  const options = b.options.map(
    (events, i) =>
      html`${i > 0 ? html`<p class="or">or</p>` : ""}<fieldset class="option" id="o${i}"><legend><span class="letter" style="background:var(--o${i % 8})">${LETTERS[i] ?? "?"}</span>${i > 0 && first !== undefined && madeLike(first, events) ? " like A" : ""}</legend>
${
  input.editing?.i === i
    ? editWeeks(b, input.editing, input.today)
    : i > 0 && first !== undefined && madeLike(first, events)
      ? likeA(b, i, input.today, input.seeing === i)
      : ""
}
${events.map((e, j) => eventRow(i, j, { ...rowOf(e), name: e.title ?? "" }, events.length > 1 || b.options.length > 1, b.title))}
<p class="row wrap">${events.length < MAX_OPTION_EVENTS ? html`<button type="submit" name="act" value="and:${i}">+ and</button> <span class="muted small">another event, in this option</span>` : ""}${
        input.editing?.i === i
          ? ""
          : html` <button type="submit" name="act" value="edit:${String(i)}">Edit on the weeks</button>`
      }</p>
</fieldset>`,
  );
  return html`${PLAN_STYLE}<div class="pl ask" data-ask-drag>
${statusLine("draft", input.saved ? html` · <span class="muted">Saved</span>` : "")}
${input.problem === null ? "" : html`<p class="error">${input.problem}</p>`}
<form method="post" action="${ASK_PATH}/${draft.id}" id="ask">
<input type="hidden" name="csrf" value="${me.csrfToken}" />
<input type="hidden" name="m" value="${input.month}" />
<input type="hidden" name="v" value="${input.view}" />
<input type="hidden" name="d" value="${input.from}" />
${input.seeing === null ? "" : html`<input type="hidden" name="s" value="${String(input.seeing)}" />`}
${input.editing === null ? "" : html`<input type="hidden" name="x" value="${String(input.editing.i)}" /><input type="hidden" name="e" value="${input.editing.sid ?? ""}" />`}
<button type="submit" name="act" value="save" hidden></button>
<button type="submit" name="act" value="save" hidden data-drag-act></button>
<p><label>What<br /><input name="title" maxlength="200" value="${b.title}" class="wide" required /></label></p>
<p><label>Where <span class="muted">(optional)</span><br /><input name="location" maxlength="200" value="${b.location ?? ""}" class="wide" /></label></p>
<div class="row spread"><h2>When could it be</h2>${viewSwitch(input.view)}</div>
${input.view === "hours" ? hoursView(b, input.from, input.today) : daysView(b, input.month, input.today)}
${newOnes(b)}
${addedBar(b, input.added)}
${b.options.length === 0 ? html`<p class="muted">No times yet. Tap ${input.view === "hours" ? "an hour" : "a day"} to add one.</p>` : options}
${b.options.length < MAX_OPTIONS ? html`<p class="row wrap"><button type="submit" name="act" value="option">+ A time</button>${b.options.length > 0 ? html`<button type="submit" name="act" value="like">+ Like A</button>` : ""} <span class="muted small">another option to choose between${b.options.length > 0 ? "; Like A starts as a copy of A, its changes shown" : ""}</span></p>` : ""}
<p><label>Time zone<br /><input name="tzid" list="zones" value="${b.tzid ?? ""}" placeholder="Europe/Prague" /></label></p>
${zoneOptions()}
<h2>Who</h2>
${peoplePicker({
  chips: chipsOf(b),
  known: input.people.known,
  levers: NO_LEVERS,
  filter: input.filter,
  lead: "Who are you asking? Everyone asked sees the whole question.",
  group: input.people.group,
  exclude: input.people.inGroup,
})}
<p><label>Note <span class="muted">(optional — everyone asked sees it)</span><br /><textarea name="note" rows="2" maxlength="2000" class="wide">${b.note ?? ""}</textarea></label></p>
${readBack(draft, input.asked, input.makesEvent, input.noMail)}
<div class="row wrap"><button class="primary" type="submit" name="act" value="ask">${
    input.asked === 0
      ? "Ask"
      : `Ask ${input.asked} ${input.asked === 1 ? "person" : "people"}${input.noMail ? "" : " by email"}`
  }</button><button type="submit" name="act" value="save">Save</button></div>
${input.makesEvent ? "" : html`<p class="muted small">${input.noMail ? "This instance doesn't send email: after asking, copy each person's own link and send it to them." : "Asking emails them a minute later; until then you can undo it."}</p>`}
<p class="discard"><button class="link" type="submit" name="act" value="discard">Throw this question away</button></p>
</form></div>${askDragAssets()}${input.editing === null ? "" : editorScript()}`;
}

/** Unsent questions on home (rc46): found again, never lost. */
export async function askDraftsSection(deps: AuthDeps, me: SignedIn): Promise<Html> {
  const drafts = await listAskDrafts(deps.storage, me.personId);
  const start = html`<form method="post" action="${ASK_PATH}"><input type="hidden" name="csrf" value="${me.csrfToken}" /><button class="primary" type="submit">Ask when</button></form>`;
  return drafts.length === 0
    ? start
    : html`${start}<h2>Not asked yet</h2><ul>${drafts.map(
        (d) =>
          html`<li><a href="${ASK_PATH}/${d.id}">${d.body.title.trim() === "" ? "Untitled question" : d.body.title}</a> <span class="muted">· ${d.body.options.length} ${d.body.options.length === 1 ? "time" : "times"}</span></li>`,
      )}</ul>`;
}

/** rc49: which option made like A is showing A, if that is still one. */
function seeingOf(value: string | undefined, body: AskBody): number | null {
  const i = Number.parseInt(value ?? "", 10);
  const [first] = body.options;
  const o = body.options[i];
  return Number.isInteger(i) &&
    i > 0 &&
    first !== undefined &&
    o !== undefined &&
    madeLike(first, o)
    ? i
    : null;
}

/**
 * rc49 (A5b): the option being edited, if it is still there, and its event chosen — by
 * identity, never by position. No event named: its first with a time to draw. An event named
 * that is no longer in the option closes the editor, rather than edit something else.
 */
function editingOf(x: string | undefined, sid: string | undefined, body: AskBody): Editing | null {
  const i = Number.parseInt(x ?? "", 10);
  const o = body.options[i];
  if (!Number.isInteger(i) || o === undefined) return null;
  const drawable = drawnOf(body, o);
  if (sid === undefined || sid === "") return { i, sid: drawable[0]?.sid ?? null };
  if (!o.some((e) => e.sid === sid)) return null;
  return { i, sid: drawable.some((e) => e.sid === sid) ? sid : (drawable[0]?.sid ?? null) };
}

/** Where option i is after an action that removes an option, or null if it was that one. */
function optionAfter(i: number, action: string, before: AskBody): number | null {
  const remove = /^remove:(\d+)$/.exec(action);
  const drop = /^drop:(\d+):\d+$/.exec(action);
  const k = Number(remove?.[1] ?? drop?.[1] ?? -1);
  const gone = remove !== null || (drop !== null && before.options[k]?.length === 1);
  if (!gone) return i;
  if (k === i) return null;
  return k < i ? i - 1 : i;
}

/** The editor after a button: opened or closed by Edit and Done, else carried, if still there. */
function editingNext(
  form: Record<string, unknown>,
  action: string,
  before: AskBody,
  after: AskBody,
  seeing: boolean,
): Editing | null {
  const edit = /^edit:(\d*)(?::(.+))?$/.exec(action);
  if (edit !== null) return editingOf(edit[1], edit[2], after);
  if (seeing) return null;
  const i = Number.parseInt(str(form, "x"), 10);
  if (!Number.isInteger(i)) return null;
  const now = optionAfter(i, action, before);
  if (now === null) return null;
  // Its chosen event removed from the list: the editor stays, on the option's first.
  const sid = str(form, "e");
  const dropped =
    action.startsWith(`drop:${String(i)}:`) &&
    !(after.options[now] ?? []).some((e) => e.sid === sid);
  return editingOf(String(now), dropped ? "" : sid, after);
}

function addedOf(value: string | undefined, body: AskBody): number | null {
  const i = Number.parseInt(value ?? "", 10);
  return Number.isInteger(i) && i >= 0 && i < body.options.length ? i : null;
}

function problem(err: unknown): string | null {
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Check the form.";
  if (err instanceof PollInputError || err instanceof UnreachableAddressError) return err.message;
  return null;
}

export function registerAskRoutes(app: Hono<AppEnv>, deps: AuthDeps): void {
  const notFound = (c: Context<AppEnv>) =>
    c.html(page(c, "Not found", html`<h1>Not found</h1><p><a href="/">Your events</a></p>`), 404);

  // Starting writes a draft, so it is a POST (§13: GET never mutates).
  app.post(ASK_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const group = str(form, "group");
    const draft = await startAskDraft(deps.storage, {
      authorId: me.personId,
      groupId: group === "" ? null : group,
      now: deps.now(),
    });
    if (draft === null) return notFound(c);
    // A new question starts with one time to fill in.
    await saveAskDraft(deps.storage, {
      id: draft.id,
      authorId: me.personId,
      body: withSids({ ...draft.body, options: [[EMPTY_EVENT]] }),
      now: deps.now(),
    });
    return c.redirect(`${ASK_PATH}/${draft.id}`, 303);
  });

  app.get(`${ASK_PATH}/:id`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const draft = await findAskDraft(deps.storage, {
      id: c.req.param("id"),
      authorId: me.personId,
    });
    if (draft === null) return notFound(c);
    return c.html(
      page(
        c,
        "Ask when",
        askPage(draft, me, {
          asked: await askedCount(deps, me, draft),
          makesEvent: await makesEvent(deps.storage, draft, me.personId),
          saved: c.req.query("saved") === "1",
          problem: null,
          month: monthOf(draft.body, c.req.query("m") ?? null, deps.now().slice(0, 10)),
          today: deps.now().slice(0, 10),
          view: c.req.query("v") === "hours" ? "hours" : "days",
          from: fromOf(draft.body, c.req.query("d") ?? null, deps.now().slice(0, 10)),
          added: addedOf(c.req.query("added"), draft.body),
          people: await askPeople(deps, me, draft),
          filter: (c.req.query("f") ?? "").slice(0, 64) || null,
          seeing: seeingOf(c.req.query("s"), draft.body),
          editing: editingOf(c.req.query("x"), c.req.query("e"), draft.body),
          noMail: deps.noMail === true,
        }),
      ),
    );
  });

  app.post(`${ASK_PATH}/:id`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const id = c.req.param("id");
    const draft = await findAskDraft(deps.storage, { id, authorId: me.personId });
    if (draft === null) return notFound(c);
    const action = str(form, "act");
    if (action === "discard") {
      await discardAskDraft(deps.storage, { id, authorId: me.personId });
      return c.redirect("/", 303);
    }
    // Every button saves first: nothing typed is lost by any tap.
    const typed = act(bodyOf(form, draft.body), action);
    // A picker button (rc48) changes who is asked; the rest of the form is saved with it.
    const pick = pickerAction(form);
    let filter = carriedFilter(form);
    let body = typed;
    if (pick !== null) {
      const people = await askPeople(deps, me, draft);
      const picked = applyPick({
        chips: chipsOf(typed),
        action: pick,
        known: people.known,
        max: MAX_ASK_EMAILS,
        filter,
        exclude: people.inGroup,
      });
      body = { ...typed, ...fromChips(picked.chips) };
      filter = picked.filter;
    }
    body = withSids(body);
    const now = deps.now();
    await saveAskDraft(deps.storage, { id, authorId: me.personId, body, now });
    if (action !== "ask") {
      // The view, month and days stay where they were shown; a tap's Undo comes back too.
      const q = new URLSearchParams({ saved: "1" });
      const view = /^view:(days|hours)$/.exec(action)?.[1] ?? str(form, "v");
      if (view === "hours") q.set("v", "hours");
      const month = /^month:(\d{4}-\d{2})$/.exec(action)?.[1] ?? str(form, "m");
      const from = /^from:(\d{4}-\d{2}-\d{2})$/.exec(action)?.[1] ?? str(form, "d");
      const tapped = /^(?:addh?|span):(\d{4}-\d{2})/.exec(action)?.[1];
      const grew = body.options.length > draft.body.options.length;
      if (tapped !== undefined && grew) {
        q.set("m", tapped);
        q.set("added", String(body.options.length - 1));
      } else if (/^\d{4}-\d{2}$/.test(month)) q.set("m", month);
      if (view === "hours" && DAY.test(from)) q.set("d", from);
      if (filter !== null) q.set("f", filter);
      // rc49: "See A" is a view of one option, kept like the month until "Back"; the editor
      // behind Edit (A5b) is kept the same way until "Done". One at a time: each ends the other.
      const see = /^see:(\d*)$/.exec(action);
      const edit = /^edit:(\d*)(?::(.+))?$/.exec(action);
      const seeing = edit === null ? seeingOf(see === null ? str(form, "s") : see[1], body) : null;
      const editing = editingNext(form, action, draft.body, body, see !== null);
      if (seeing !== null) q.set("s", String(seeing));
      if (editing !== null) {
        q.set("x", String(editing.i));
        if (editing.sid !== null) q.set("e", editing.sid);
      }
      return c.redirect(
        `${ASK_PATH}/${id}?${q.toString()}${editing === null ? "" : `#o${editing.i}`}`,
        303,
      );
    }
    const saved: AskDraft = { ...draft, body, updatedAt: now };
    let asked: Awaited<ReturnType<typeof askDraft>>;
    try {
      // rc50: one time and nobody to ask is made as an event, and the page after is its own.
      if (await makesEvent(deps.storage, saved, me.personId)) {
        const made = await askAsEvent(deps.storage, { id, authorId: me.personId, now });
        if (made === null) return notFound(c);
        return c.redirect(`${EVENTS_PATH}/${made.eventId}`, 303);
      }
      asked = await askDraft(deps.storage, { id, authorId: me.personId, now });
    } catch (err) {
      const message = problem(err);
      if (message === null) throw err;
      return c.html(
        page(
          c,
          "Ask when",
          askPage(saved, me, {
            asked: await askedCount(deps, me, saved),
            makesEvent: await makesEvent(deps.storage, saved, me.personId),
            saved: true,
            problem: message,
            month: monthOf(body, str(form, "m"), now.slice(0, 10)),
            today: now.slice(0, 10),
            view: str(form, "v") === "hours" ? "hours" : "days",
            from: fromOf(body, str(form, "d"), now.slice(0, 10)),
            added: null,
            people: await askPeople(deps, me, saved),
            filter,
            seeing: seeingOf(str(form, "s"), body),
            editing: editingOf(str(form, "x"), str(form, "e"), body),
            noMail: deps.noMail === true,
          }),
        ),
        400,
      );
    }
    if (asked === null) return notFound(c);
    // Emailing them waits a minute with Undo (A0): the thread page shows it. rc60: with no
    // email nothing is held; the thread page lists each person's own link to copy.
    if (deps.noMail !== true)
      await holdAction(deps.storage, {
        actorId: me.personId,
        threadId: asked.threadId,
        kind: "vote_links",
        now,
      });
    return c.redirect(
      `${PLANS_PATH}/${asked.threadId}${deps.noMail === true ? "#links" : ""}`,
      303,
    );
  });
}
