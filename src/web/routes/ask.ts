// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { Temporal } from "temporal-polyfill";
import { ZodError } from "zod";
import { groupDefaults, UnreachableAddressError } from "../../events/participation.js";
import { PollInputError } from "../../events/poll.js";
import { holdAction } from "../../held.js";
import { findGroupForMember } from "../../people/group.js";
import {
  type AskBody,
  type AskDraft,
  askDraft,
  discardAskDraft,
  findAskDraft,
  listAskDrafts,
  MAX_ASK_EMAILS,
  saveAskDraft,
  startAskDraft,
} from "../../plans/ask.js";
import { MAX_OPTION_EVENTS, MAX_OPTIONS } from "../../plans/plan.js";
import { addDays, dayLabel } from "../../plans/weeks.js";
import { type Html, html } from "../layout.js";
import { PLAN_STYLE } from "../plan-editor.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  requireSignedIn,
  type SignedIn,
  verifyFormCsrf,
} from "../session.js";
import type { AuthDeps } from "./auth.js";
import { zoneOptions } from "./events.js";
import { PLANS_PATH } from "./plans.js";

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
    return {
      allDay: false,
      startLocal: day === "" ? "" : `${day}T${r.from}`,
      endLocal: day === "" || to === "" ? "" : `${day}T${to}`,
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
    events.map((_, j) =>
      eventOf({
        day: str(form, `o${i}e${j}day`),
        from: str(form, `o${i}e${j}from`),
        to: str(form, `o${i}e${j}to`),
        last: str(form, `o${i}e${j}last`),
      }),
    ),
  );
  const emails = [
    ...new Set(
      str(form, "emails")
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter((e) => e !== ""),
    ),
  ].slice(0, MAX_ASK_EMAILS);
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
    defaults: {
      from: TIME.test(str(form, "new_from")) ? str(form, "new_from") : null,
      hours: HOURS.includes(Number(str(form, "new_hours"))) ? Number(str(form, "new_hours")) : 2,
    },
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
  const remove = /^remove:(\d+)$/.exec(action);
  if (remove !== null)
    return { ...body, options: body.options.filter((_, k) => k !== Number(remove[1])) };
  if (action === "option" && body.options.length < MAX_OPTIONS)
    return { ...body, options: [...body.options, [EMPTY_EVENT]] };
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
  return fromGroup.length + draft.body.emails.length;
}

function readBack(draft: AskDraft, asked: number): Html {
  const n = draft.body.options.length;
  const letters = [...LETTERS.slice(0, n)];
  const which =
    n === 0
      ? "nothing yet"
      : n === 1
        ? html`<strong>A</strong>`
        : html`<strong>${letters.slice(0, -1).join(", ")} or ${letters.at(-1) ?? ""}</strong>`;
  const what = draft.body.title.trim() === "" ? "this" : `“${draft.body.title.trim()}”`;
  const who =
    asked === 0 ? "nobody yet — add people below" : `${asked} ${asked === 1 ? "person" : "people"}`;
  return html`<p class="readback">Asking emails ${who} one question: does ${which} suit for ${what}? ${
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
  body.options.forEach((events, i) => {
    for (const e of events) {
      const a = e.startLocal.slice(0, 10);
      if (!DAY.test(a)) continue;
      const z = e.allDay && DAY.test(e.endLocal) ? addDays(e.endLocal, -1) : a;
      for (let d = a; d <= z; d = addDays(d, 1))
        onDay.set(d, [...new Set([...(onDay.get(d) ?? []), i])]);
    }
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
          ? html`<span class="day has${out}"><b>${label}</b>${here.map(
              (i) =>
                html`<a class="letter" href="#o${i}" style="background:var(--o${i % 8})" aria-label="Option ${LETTERS[i] ?? ""}">${LETTERS[i] ?? ""}</a>`,
            )}</span>`
          : body.options.length < MAX_OPTIONS
            ? html`<button class="day${out}${key === today ? " today" : ""}" type="submit" name="act" value="add:${key}" aria-label="Add ${key}">${label}</button>`
            : html`<span class="day${out}">${label}</span>`,
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
  const rows: Html[] = [];
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    const hh = String(h).padStart(2, "0");
    rows.push(
      html`<div class="hrow"><span class="hr">${hh}</span>${days.map((day) => {
        const here = inHour(body, day, h);
        return here.length > 0
          ? html`<span class="hour has">${letters(here)}</span>`
          : full
            ? html`<span class="hour"></span>`
            : html`<button class="hour" type="submit" name="act" value="addh:${day}T${hh}:00" aria-label="Add ${day} ${hh}:00"></button>`;
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

function eventRow(i: number, j: number, r: EventRow, many: boolean): Html {
  const k = `o${i}e${j}`;
  return html`<div class="ev">${j > 0 ? html`<p class="and">and</p>` : ""}<div class="row wrap">
<label>Day<br /><input type="date" name="${k}day" value="${r.day}" /></label>
<label>From <span class="muted small">(empty: all day)</span><br /><input type="time" name="${k}from" value="${r.from}" /></label>
<label>To<br /><input type="time" name="${k}to" value="${r.to}" /></label>
<label>Last day <span class="muted small">(all day, several days)</span><br /><input type="date" name="${k}last" value="${r.last}" /></label>
${many ? html`<button class="link" type="submit" name="act" value="drop:${i}:${j}">Remove</button>` : ""}</div></div>`;
}

/** Right after a day was tapped (rc46): what it became, and Undo. */
function addedBar(b: AskBody, added: number | null): Html | "" {
  if (added === null) return "";
  const e = b.options[added]?.[0];
  if (e === undefined) return "";
  const when = e.allDay
    ? dayLabel(e.startLocal.slice(0, 10))
    : `${dayLabel(e.startLocal.slice(0, 10))}, ${e.startLocal.slice(11, 16)}`;
  return html`<p class="undo">Added ${when} as ${LETTERS[added] ?? ""} <button class="link" type="submit" name="act" value="remove:${String(added)}">Undo</button></p>`;
}

function askPage(
  draft: AskDraft,
  me: SignedIn,
  input: {
    readonly asked: number;
    readonly saved: boolean;
    readonly problem: string | null;
    readonly month: string;
    readonly today: string;
    readonly view: "days" | "hours";
    /** The first day the Hours view shows. */
    readonly from: string;
    /** An option just added by tapping a day (rc46): its Undo. */
    readonly added: number | null;
  },
): Html {
  const b = draft.body;
  const options = b.options.map(
    (events, i) =>
      html`${i > 0 ? html`<p class="or">or</p>` : ""}<fieldset class="option" id="o${i}"><legend><span class="letter" style="background:var(--o${i % 8})">${LETTERS[i] ?? "?"}</span></legend>
${events.map((e, j) => eventRow(i, j, rowOf(e), events.length > 1 || b.options.length > 1))}
${events.length < MAX_OPTION_EVENTS ? html`<p><button type="submit" name="act" value="and:${i}">+ and</button> <span class="muted small">another event, in this option</span></p>` : ""}
</fieldset>`,
  );
  return html`${PLAN_STYLE}<div class="pl ask">
<p class="askstatus"><strong>Draft</strong> · step 1 of 4 · nobody has been told${input.saved ? html` · <span class="muted">Saved</span>` : ""}</p>
${input.problem === null ? "" : html`<p class="error">${input.problem}</p>`}
<form method="post" action="${ASK_PATH}/${draft.id}">
<input type="hidden" name="csrf" value="${me.csrfToken}" />
<input type="hidden" name="m" value="${input.month}" />
<input type="hidden" name="v" value="${input.view}" />
<input type="hidden" name="d" value="${input.from}" />
<button type="submit" name="act" value="save" hidden></button>
<p><label>What<br /><input name="title" maxlength="200" value="${b.title}" class="wide" required /></label></p>
<p><label>Where <span class="muted">(optional)</span><br /><input name="location" maxlength="200" value="${b.location ?? ""}" class="wide" /></label></p>
<div class="row spread"><h2>When could it be</h2>${viewSwitch(input.view)}</div>
${input.view === "hours" ? hoursView(b, input.from, input.today) : daysView(b, input.month, input.today)}
${newOnes(b)}
${addedBar(b, input.added)}
${b.options.length === 0 ? html`<p class="muted">No times yet. Tap ${input.view === "hours" ? "an hour" : "a day"} to add one.</p>` : options}
${b.options.length < MAX_OPTIONS ? html`<p><button type="submit" name="act" value="option">+ A time</button> <span class="muted small">another option to choose between</span></p>` : ""}
<p><label>Time zone<br /><input name="tzid" list="zones" value="${b.tzid ?? ""}" placeholder="Europe/Prague" /></label></p>
${zoneOptions()}
<h2>Who</h2>
<p><label>Their email addresses <span class="muted">(spaces, commas or new lines between them)</span><br /><textarea name="emails" rows="3" class="wide">${b.emails.join("\n")}</textarea></label></p>
<p><label>Note <span class="muted">(optional — everyone asked sees it)</span><br /><textarea name="note" rows="2" maxlength="2000" class="wide">${b.note ?? ""}</textarea></label></p>
${readBack(draft, input.asked)}
<div class="row wrap"><button class="primary" type="submit" name="act" value="ask">${
    input.asked === 0
      ? "Ask"
      : `Ask ${input.asked} ${input.asked === 1 ? "person" : "people"} by email`
  }</button><button type="submit" name="act" value="save">Save</button></div>
<p class="muted small">Asking emails them a minute later; until then you can undo it.</p>
<p class="discard"><button class="link" type="submit" name="act" value="discard">Throw this question away</button></p>
</form></div>`;
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
      body: { ...draft.body, options: [[EMPTY_EVENT]] },
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
          saved: c.req.query("saved") === "1",
          problem: null,
          month: monthOf(draft.body, c.req.query("m") ?? null, deps.now().slice(0, 10)),
          today: deps.now().slice(0, 10),
          view: c.req.query("v") === "hours" ? "hours" : "days",
          from: fromOf(draft.body, c.req.query("d") ?? null, deps.now().slice(0, 10)),
          added: addedOf(c.req.query("added"), draft.body),
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
    const body = act(bodyOf(form, draft.body), action);
    const now = deps.now();
    await saveAskDraft(deps.storage, { id, authorId: me.personId, body, now });
    if (action !== "ask") {
      // The view, month and days stay where they were shown; a tap's Undo comes back too.
      const q = new URLSearchParams({ saved: "1" });
      const view = /^view:(days|hours)$/.exec(action)?.[1] ?? str(form, "v");
      if (view === "hours") q.set("v", "hours");
      const month = /^month:(\d{4}-\d{2})$/.exec(action)?.[1] ?? str(form, "m");
      const from = /^from:(\d{4}-\d{2}-\d{2})$/.exec(action)?.[1] ?? str(form, "d");
      const tapped = /^addh?:(\d{4}-\d{2})/.exec(action)?.[1];
      const grew = body.options.length > draft.body.options.length;
      if (tapped !== undefined && grew) {
        q.set("m", tapped);
        q.set("added", String(body.options.length - 1));
      } else if (/^\d{4}-\d{2}$/.test(month)) q.set("m", month);
      if (view === "hours" && DAY.test(from)) q.set("d", from);
      return c.redirect(`${ASK_PATH}/${id}?${q.toString()}`, 303);
    }
    const saved: AskDraft = { ...draft, body, updatedAt: now };
    let asked: Awaited<ReturnType<typeof askDraft>>;
    try {
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
            saved: true,
            problem: message,
            month: monthOf(body, str(form, "m"), now.slice(0, 10)),
            today: now.slice(0, 10),
            view: str(form, "v") === "hours" ? "hours" : "days",
            from: fromOf(body, str(form, "d"), now.slice(0, 10)),
            added: null,
          }),
        ),
        400,
      );
    }
    if (asked === null) return notFound(c);
    // Emailing them waits a minute with Undo (A0): the thread page shows it.
    await holdAction(deps.storage, {
      actorId: me.personId,
      threadId: asked.threadId,
      kind: "vote_links",
      now,
    });
    return c.redirect(`${PLANS_PATH}/${asked.threadId}`, 303);
  });
}
