// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { Temporal } from "temporal-polyfill";
import { ZodError } from "zod";
import type { StoragePort } from "../../db/port.js";
import {
  type CanonicalEvent,
  canDelete,
  createEvent,
  deleteEvent,
  type EventAccess,
  type EventFieldsInput,
  editEvent,
  eventFieldsSchema,
  eventRetention,
  findEventForParticipant,
  type HistoryEntry,
  isOver,
  listEventsFor,
  listHistory,
  setCancelled,
  setEventRetention,
  type TransitionResult,
  withdrawProposal,
} from "../../events/event.js";
import {
  addParticipant,
  canSee,
  canSeeField,
  leaveEvent,
  listParticipantChanges,
  listParticipants,
  othersAfterLeaving,
  type ParticipantView,
  removeParticipant,
  resolveInvitees,
  TAKES_PEOPLE,
  UnreachableAddressError,
} from "../../events/participation.js";
import { MAX_CANDIDATES, PollInputError, validateCandidates } from "../../events/poll.js";
import {
  type ChangeProposal,
  decideProposal,
  listProposals,
  proposeChange,
  withdrawChange,
} from "../../events/proposal.js";
import {
  type Arrival,
  type Attendance,
  acknowledge,
  actionFor,
  addFeedback,
  answerProposal,
  attendanceSchema,
  issueResponseLinks,
  listRequests,
  listResponses,
  needsAcknowledgment,
  RESPONSE_TOKEN_TTL_MS,
  revokeUndeliveredLink,
  SIGNED_IN,
  setAttendance,
} from "../../events/response.js";
import { MailCapReachedError } from "../../mail/capped.js";
import type { MailPort } from "../../mail/port.js";
import { findGroupForMember, type GroupMembership, listMembers } from "../../people/group.js";
import {
  type EditTier,
  editTierSchema,
  type Visibility,
  visibilitySchema,
} from "../../people/invite.js";
import { appearanceIn, normalizeEmail } from "../../people/person.js";
import { createPollThread } from "../../plans/plan.js";
import {
  findThreadForMember,
  listThreadsFor,
  ThreadInputError,
  type ThreadSummary,
} from "../../plans/thread.js";
import { retainDaysSchema } from "../../privacy/retention.js";
import {
  formatRRule,
  parseRRule,
  type RRuleSubset,
  upcomingOccurrences,
} from "../../recurrence.js";
import {
  BUSY_PATH,
  cappedText,
  copiedLink,
  EVENTS_PATH,
  type Html,
  html,
  retentionSection,
  SHARE_BUTTONS,
  who,
  ZONE_GUESS,
} from "../layout.js";
import { pickerAssets } from "../picker.js";
import {
  type AppEnv,
  notVisible,
  page,
  rejectedPage,
  requireSignedIn,
  verifyFormCsrf,
} from "../session.js";
import { appearanceSection, saveAppearance } from "./account.js";
// A cycle (plans.ts links back to events), safe: both are read only inside handlers.
import { PLANS_PATH } from "./plans.js";
import { respondUrl, sendResponseLink } from "./respond.js";

// Event pages (MVP-2 slice 2B). Every read goes through findEventForParticipant (no
// IDOR), and every rendering goes through canSee / canSeeField — the single rule for
// what each visibility tier may see — INCLUDING the change history, where a diff of a
// hidden field would leak it (WORKFLOWS US-6).

export { EVENTS_PATH };

export interface EventRouteDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
  /** Always the capped port; response links go out through it. */
  readonly mail: MailPort;
  /** Links are built from this, never the Host header. */
  readonly publicBaseUrl: string;
}

export const BUSY_LABEL = "Busy";

/**
 * How an answer arrived, said after it (DESIGN §10 rc42): nothing for a signed-in answer or
 * one from before this was recorded; otherwise the emailed link, or the link someone copied
 * and who. Shown to everyone who sees the answer — attribution is the product (2E).
 */
export function arrivalNote(
  arrival: Arrival | null,
  subjectId: string,
  viewerId: string,
  names: ReadonlyMap<string, string>,
): Html | string {
  if (arrival === null || arrival.via === "session") return "";
  const mine = subjectId === viewerId;
  if (arrival.via === "mailed")
    return html` <span class="muted">· by ${mine ? "your" : "their"} emailed link</span>`;
  const by = arrival.by === viewerId ? "you" : (names.get(arrival.by ?? "") ?? "someone");
  return html` <span class="muted">· by the link ${by} copied for ${mine ? "you" : "them"}</span>`;
}

/** Everyone on the event by id, for naming who copied a link. */
async function namesOn(deps: EventRouteDeps, eventId: string): Promise<Map<string, string>> {
  const people = await listParticipants(deps.storage, eventId);
  return new Map(people.map((p) => [p.personId, p.shown.name]));
}
/** A poll's own path, for one made with people by email alone (DESIGN rc15). */
export const POLLS_PATH = "/polls";

/** A group page's answer when the active account isn't in the group (§13 rc18). */
const groupNotVisible = (c: Context<AppEnv>, deps: EventRouteDeps, groupId: string) =>
  notVisible(
    c,
    async (personId) => (await findGroupForMember(deps.storage, groupId, personId)) !== null,
  );

/** An event or poll page's answer when the active account may not see it (§13 rc18). */
const eventNotVisible = (c: Context<AppEnv>, deps: EventRouteDeps, eventId: string) =>
  notVisible(c, async (personId) => {
    const access = await findEventForParticipant(deps.storage, eventId, personId);
    return access !== null && access.participation.visibility !== "HIDDEN";
  });

function notFound(c: Context<AppEnv>): string {
  return page(c, "Not found", html`<h1>Not found</h1><p><a href="/groups">Your groups</a></p>`);
}

/** "2101-10-20 19:00 – 23:00 · Europe/Prague", or a date range for all-day events. */
export function formatWhen(
  e: Pick<CanonicalEvent, "allDay" | "startLocal" | "endLocal" | "tzid">,
): string {
  if (e.allDay) {
    // Stored end is EXCLUSIVE (RFC 5545); people read the last day inclusively.
    const last = Temporal.PlainDate.from(e.endLocal).subtract({ days: 1 }).toString();
    return last === e.startLocal
      ? `${e.startLocal} (all day)`
      : `${e.startLocal} – ${last} (all day)`;
  }
  const [startDate, startTime = ""] = e.startLocal.split("T");
  const [endDate, endTime = ""] = e.endLocal.split("T");
  const end = endDate === startDate ? endTime.slice(0, 5) : `${endDate} ${endTime.slice(0, 5)}`;
  return `${startDate} ${startTime.slice(0, 5)} – ${end} · ${e.tzid ?? ""}`;
}

/** "(cancelled)", "(waiting for agreement)", … — empty for an ordinary scheduled event. */
function statusBadge(access: EventAccess): Html | string {
  const label: Record<string, string> = {
    cancelled: "cancelled",
    declined: "declined",
    withdrawn: "withdrawn",
    proposed: "waiting for agreement",
  };
  const text = label[access.event.status] ?? "";
  return text === "" ? "" : html` <span class="muted">(${text})</span>`;
}

// --- Series (slice 2E-3) ---------------------------------------------------------------

const UNIT: Record<RRuleSubset["freq"], string> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
};
const WEEKDAY: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};
const ORDINAL: Record<string, string> = {
  "1": "first",
  "2": "second",
  "3": "third",
  "4": "fourth",
  "-1": "last",
  "-2": "second to last",
  "-3": "third to last",
  "-4": "fourth to last",
};

/** "Every 2 weeks on Tuesday, Thursday, until 2102-06-30" — a stored rule, in words. */
export function describeRRule(rrule: string): string {
  let rule: RRuleSubset;
  try {
    rule = parseRRule(rrule);
  } catch {
    return "Repeats";
  }
  const n = rule.interval ?? 1;
  const unit = UNIT[rule.freq];
  const days = (rule.byday ?? []).map((entry) => {
    const m = /^(-?\d)?([A-Z]{2})$/.exec(entry);
    const day = WEEKDAY[m?.[2] ?? ""] ?? entry;
    return m?.[1] === undefined ? day : `the ${ORDINAL[m[1]] ?? m[1]} ${day}`;
  });
  return [
    n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`,
    days.length === 0 ? "" : ` on ${days.join(", ")}`,
    rule.count === undefined ? "" : `, ${rule.count} times`,
    rule.until === undefined ? "" : `, until ${rule.until.slice(0, 10)}`,
  ].join("");
}

/** The next few dates of a series, from `now`, in the series' own zone. */
function nextDates(event: CanonicalEvent, now: string, count: number): string[] {
  if (event.rrule === null) return [];
  const fromLocal = Temporal.Instant.from(now)
    .toZonedDateTimeISO(event.tzid ?? "UTC")
    .toPlainDateTime()
    .toString();
  return upcomingOccurrences({ ...event, exdates: [] }, fromLocal, count).map((o) =>
    formatWhen({
      allDay: event.allDay,
      tzid: event.tzid,
      // An all-day occurrence comes back as midnight; show it as the date it is.
      startLocal: event.allDay ? o.startLocal.slice(0, 10) : o.startLocal,
      endLocal: event.allDay ? o.endLocal.slice(0, 10) : o.endLocal,
    }),
  );
}

/** One line for a list, at the viewer's tier. */
export function eventSummary(access: EventAccess): Html {
  const { event, participation } = access;
  const title = canSee(participation.visibility, "title") ? event.title : BUSY_LABEL;
  const when = formatWhen(event);
  const repeats = event.rrule === null ? "" : ` · ↻ ${describeRRule(event.rrule)}`;
  return html`<a href="${EVENTS_PATH}/${event.id}">${title}</a>${statusBadge(access)} <span class="muted">· ${when}${repeats}</span>`;
}

/** A thread with a plan on the table, as one line of "Finding a time" (rc28). */
function threadSummary(t: ThreadSummary): Html {
  return html`<a href="${PLANS_PATH}/${t.id}">${t.name}</a> <span class="muted">·</span> ${
    t.waiting > 0
      ? html`<strong>${t.waiting} waiting for your vote</strong>`
      : html`<span class="muted">${t.onTable} on the table</span>`
  }`;
}

/**
 * Home for a signed-in person: Your events (DESIGN rc15). Everything still being decided
 * first, in ONE list (rc28) — threads waiting for this person's vote, then threads
 * waiting for others — then what's coming up, soonest first, then the past,
 * folded away. Every event line at the viewer's own tier (eventSummary → canSee).
 */
export async function yourEvents(
  storage: StoragePort,
  personId: string,
  now: string,
): Promise<Html> {
  const all = await listEventsFor(storage, personId);
  const open = (await listThreadsFor(storage, personId)).filter((t) => t.onTable > 0);
  const deciding = [
    ...open.filter((t) => t.waiting > 0).map(threadSummary),
    ...open.filter((t) => t.waiting === 0).map(threadSummary),
  ];
  const upcoming = all.filter((a) => !isOver(a.event, now));
  const past = all.filter((a) => isOver(a.event, now)).reverse();
  const list = (items: readonly EventAccess[]) =>
    html`<ul>${items.map((a) => html`<li>${eventSummary(a)}</li>`)}</ul>`;
  return html`<h1>Your events</h1>
${deciding.length === 0 ? "" : html`<h2>Finding a time</h2><ul>${deciding.map((line) => html`<li>${line}</li>`)}</ul>`}
${
  upcoming.length === 0
    ? deciding.length === 0
      ? html`<p class="muted">Nothing planned yet. Events you create, or are added to, show up here.</p>`
      : ""
    : html`<h2>Coming up</h2>${list(upcoming)}`
}
${past.length === 0 ? "" : html`<details><summary>Past (${past.length})</summary>${list(past)}</details>`}`;
}

interface FormValues {
  readonly title: string;
  readonly description: string;
  readonly location: string;
  readonly allDay: boolean;
  /** datetime-local values, "YYYY-MM-DDTHH:mm". */
  readonly start: string;
  readonly end: string;
  readonly tzid: string;
  /** A rule without its UNTIL ("" = doesn't repeat), and that UNTIL as a date. */
  readonly repeat: string;
  readonly until: string;
}

function repeatValues(rrule: string | null): Pick<FormValues, "repeat" | "until"> {
  if (rrule === null) return { repeat: "", until: "" };
  const { until, ...rest } = parseRRule(rrule);
  return { repeat: formatRRule(rest), until: until?.slice(0, 10) ?? "" };
}

function valuesFrom(event: CanonicalEvent): FormValues {
  // All-day: show the last day inclusively, as people expect.
  const end = event.allDay
    ? `${Temporal.PlainDate.from(event.endLocal).subtract({ days: 1 }).toString()}T00:00`
    : event.endLocal.slice(0, 16);
  return {
    title: event.title,
    description: event.description ?? "",
    location: event.location ?? "",
    allDay: event.allDay,
    start: event.allDay ? `${event.startLocal}T00:00` : event.startLocal.slice(0, 16),
    end,
    tzid: event.tzid ?? "",
    ...repeatValues(event.rrule),
  };
}

type Vis = EventAccess["participation"]["visibility"];

/**
 * Saving the edit form at the viewer's tier: eventForm doesn't render a field they can't
 * see (an `edit` or `propose` + DETAILS member must not read the notes in a textarea), so
 * it keeps the event's current value rather than being blanked.
 */
function withHidden(fields: EventFieldsInput, access: EventAccess): EventFieldsInput {
  const vis = access.participation.visibility;
  const { event } = access;
  return {
    ...fields,
    title: canSee(vis, "title") ? fields.title : event.title,
    location: canSee(vis, "location") ? fields.location : event.location,
    description: canSee(vis, "description") ? fields.description : event.description,
  };
}

function str(form: Record<string, unknown>, key: string): string {
  const v = form[key];
  return typeof v === "string" ? v : "";
}

function readForm(form: Record<string, unknown>): FormValues {
  return {
    title: str(form, "title"),
    description: str(form, "description"),
    location: str(form, "location"),
    allDay: form.allDay === "on",
    start: str(form, "start"),
    end: str(form, "end"),
    tzid: str(form, "tzid"),
    repeat: str(form, "repeat"),
    until: str(form, "until"),
  };
}

/** "Until" is the last day: the rule's UNTIL is that day's end, local (§10). */
function toRRuleText(v: FormValues): string | null {
  if (v.repeat === "") return null;
  return v.until === "" ? v.repeat : `${v.repeat};UNTIL=${v.until.replaceAll("-", "")}T235959`;
}

/** Form values → domain input. All-day: date parts, end made EXCLUSIVE (+1 day). */
function toFields(v: FormValues): EventFieldsInput {
  const text = (s: string) => (s.trim() === "" ? null : s);
  const rrule = toRRuleText(v);
  if (v.allDay) {
    const startDate = v.start.slice(0, 10);
    let endExclusive = v.end.slice(0, 10);
    try {
      endExclusive = Temporal.PlainDate.from(endExclusive).add({ days: 1 }).toString();
    } catch {
      // Leave as typed; eventFieldsSchema reports it as an invalid date.
    }
    return {
      title: v.title,
      description: text(v.description),
      location: text(v.location),
      allDay: true,
      startLocal: startDate,
      endLocal: endExclusive,
      tzid: null,
      rrule,
    };
  }
  return {
    title: v.title,
    description: text(v.description),
    location: text(v.location),
    allDay: false,
    startLocal: v.start,
    endLocal: v.end,
    tzid: v.tzid === "" ? null : v.tzid,
    rrule,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Please check the form.";
  if (error instanceof PollInputError) return error.message;
  if (error instanceof ThreadInputError) return error.message;
  if (error instanceof UnreachableAddressError) return error.message;
  return "Please check the form.";
}

function zoneOptions(): Html {
  const zones =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return html`<datalist id="zones">${zones.map((z) => html`<option value="${z}"></option>`)}</datalist>`;
}

const REPEATS: readonly (readonly [string, string])[] = [
  ["", "Doesn't repeat"],
  ["FREQ=DAILY", "Every day"],
  ["FREQ=WEEKLY", "Every week"],
  ["FREQ=WEEKLY;INTERVAL=2", "Every 2 weeks"],
  ["FREQ=MONTHLY", "Every month"],
  ["FREQ=YEARLY", "Every year"],
];

/**
 * The whole series is edited at once (DESIGN §10 rc13). A rule the presets don't cover
 * — one that came from a calendar — is offered as itself, so saving keeps it.
 */
function repeatInputs(v: FormValues): Html {
  const options: (readonly [string, string])[] = REPEATS.some(([value]) => value === v.repeat)
    ? [...REPEATS]
    : [...REPEATS, [v.repeat, describeRRule(v.repeat)]];
  return html`<p><label>Repeats<br /><select name="repeat">${options.map(
    ([value, label]) =>
      html`<option value="${value}" ${value === v.repeat ? html`selected` : ""}>${label}</option>`,
  )}</select></label>
  <label>until <span class="muted">(optional, the last day)</span> <input type="date" name="until" value="${v.until}" /></label></p>`;
}

function eventForm(
  action: string,
  csrf: string,
  v: FormValues,
  extra: Html | string,
  error: string | null,
  submit: string,
  vis: Vis = "FULL",
  /** Who it's for: after the what and when, before the button (a new event only). */
  people: Html | string = "",
  /** The event being edited, whose own time the picker doesn't count as busy (rc41). */
  editing: string | null = null,
): Html {
  return html`${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${action}" data-picker="event" data-busy="${BUSY_PATH}"${editing === null ? "" : html` data-busy-except="${editing}"`}>
  <input type="hidden" name="csrf" value="${csrf}" />
  ${extra}
  ${canSee(vis, "title") ? html`<p><label>Title<br /><input name="title" required maxlength="200" value="${v.title}" style="width:100%" /></label></p>` : ""}
  ${canSee(vis, "location") ? html`<p><label>Where<br /><input name="location" maxlength="500" value="${v.location}" style="width:100%" /></label></p>` : ""}
  <div data-picker-plain>
  <p><label><input type="checkbox" name="allDay" ${v.allDay ? html`checked` : ""} /> All day</label></p>
  <p><label>Starts<br /><input type="datetime-local" name="start" required value="${v.start}" /></label></p>
  <p><label>Ends <span class="muted">(for all-day events: the last day)</span><br /><input type="datetime-local" name="end" required value="${v.end}" /></label></p>
  </div>
  <p><label>Time zone<br /><input id="tzid" name="tzid" list="zones" value="${v.tzid}" placeholder="Europe/Prague" /></label></p>
  ${zoneOptions()}
  ${repeatInputs(v)}
  ${canSee(vis, "description") ? html`<p><label>Notes <span class="muted">(only people who see full details see these)</span><br /><textarea name="description" rows="4" style="width:100%">${v.description}</textarea></label></p>` : ""}
  ${people}
  <p><button type="submit">${submit}</button></p>
</form>
${ZONE_GUESS}
${pickerAssets()}`;
}

type Request = "accept" | "ack";
const REQUESTS: readonly Request[] = ["accept", "ack"];
const REQUEST_LABEL: Record<Request, string> = { accept: "must agree", ack: "please acknowledge" };

/**
 * On create: who must agree and who should acknowledge (DESIGN §10 rc13). One select
 * per fellow member; field names carry the person id, validated against the group by
 * createEvent itself.
 */
async function requestsFieldset(
  deps: EventRouteDeps,
  membership: GroupMembership,
  meId: string,
  chosen: ReadonlyMap<string, Request>,
): Promise<Html | string> {
  const others = (await listMembers(deps.storage, membership)).filter((m) => m.personId !== meId);
  if (others.length === 0) return "";
  return html`<fieldset style="margin-bottom:1em"><legend>Ask people <span class="muted">(optional)</span></legend>
<p class="muted">If anyone must agree, the event waits — and only they and you see it — until all of them do. "Please acknowledge" never holds it up.</p>
${others.map(
  (m) => html`<p><label>${who(m.shown)}
  <select name="req_${m.personId}">
    <option value="">—</option>
    ${REQUESTS.map((r) => html`<option value="${r}" ${chosen.get(m.personId) === r ? html`selected` : ""}>${REQUEST_LABEL[r]}</option>`)}
  </select></label></p>`,
)}
</fieldset>`;
}

function readRequests(form: Record<string, unknown>): Map<string, Request> {
  const requests = new Map<string, Request>();
  for (const [key, value] of Object.entries(form)) {
    const id = /^req_([0-9a-f-]{36})$/.exec(key)?.[1];
    if (id !== undefined && (value === "accept" || value === "ack")) requests.set(id, value);
  }
  return requests;
}

// --- People named on a new event, by email (DESIGN rc15) -------------------------------

/** Rows on a new event's form: enough for a small group, and the most one form takes. */
const PEOPLE_ROWS = 20;

interface PersonRow {
  /** As typed (trimmed), so a refused form shows it back; normalized on use. */
  readonly email: string;
  readonly editTier: EditTier;
  readonly visibility: Visibility;
  readonly ask: Request | "";
}

const shownVisibility = visibilitySchema.exclude(["HIDDEN"]);

/** The filled-in rows, and any that aren't an email address. Unknown tiers fall back to the defaults. */
function readPeople(form: Record<string, unknown>): { rows: PersonRow[]; bad: string[] } {
  const rows: PersonRow[] = [];
  const bad: string[] = [];
  for (let i = 0; i < PEOPLE_ROWS; i++) {
    const email = str(form, `email_${i}`).trim();
    if (email === "") continue;
    try {
      normalizeEmail(email);
    } catch {
      bad.push(email);
    }
    const tier = editTierSchema.safeParse(form[`tier_${i}`]);
    const vis = shownVisibility.safeParse(form[`vis_${i}`]);
    const ask = form[`ask_${i}`];
    rows.push({
      email,
      editTier: tier.success ? tier.data : "view",
      visibility: vis.success ? vis.data : "FULL",
      ask: ask === "accept" || ask === "ack" ? ask : "",
    });
  }
  return { rows, bad };
}

function badPeople(bad: readonly string[]): string {
  return `Not an email address: ${bad.join(", ")}`;
}

/**
 * Who it's for, by email: each with what they may change, what they see and — on an
 * event, not a poll — what they're asked. Plain fields, so it works without JavaScript.
 */
function peopleFieldset(
  rows: readonly PersonRow[],
  asking: boolean,
  lead: string,
  /** False for a poll: everyone in it sees what it says (rc26), so there are no terms to pick. */
  terms = true,
): Html {
  const shown = Math.min(PEOPLE_ROWS, Math.max(3, rows.length + 2));
  const option = (value: string, label: string, chosen: string) =>
    html`<option value="${value}" ${value === chosen ? html`selected` : ""}>${label}</option>`;
  return html`<fieldset style="margin-bottom:1em"><legend>People</legend>
<p class="muted">${lead}</p>
${Array.from({ length: shown }, (_, i) => {
  const r = rows[i] ?? { email: "", editTier: "view", visibility: "FULL", ask: "" };
  if (!terms)
    return html`<p><input name="email_${i}" type="email" value="${r.email}" placeholder="their email" aria-label="Email ${i + 1}" style="width:100%" /></p>`;
  return html`<p><input name="email_${i}" type="email" value="${r.email}" placeholder="their email" aria-label="Email ${i + 1}" style="width:100%" />
  <select name="tier_${i}" aria-label="Can change it (${i + 1})">${option("view", "can't change it", r.editTier)}${option("propose", "can propose changes", r.editTier)}${option("edit", "can edit it", r.editTier)}</select>
  <select name="vis_${i}" aria-label="Sees (${i + 1})">${option("FULL", "sees everything", r.visibility)}${option("DETAILS", "sees title, time and place", r.visibility)}${option("BUSY", "sees only that the time is taken", r.visibility)}</select>
  ${asking ? html`<select name="ask_${i}" aria-label="Ask (${i + 1})">${option("", "asked nothing", r.ask)}${REQUESTS.map((q) => option(q, REQUEST_LABEL[q], r.ask))}</select>` : ""}</p>`;
})}
</fieldset>`;
}

/** The rows' people, created if new, and what each was asked. Call once the form is otherwise valid. */
async function invitees(
  deps: EventRouteDeps,
  rows: readonly PersonRow[],
  from: { readonly senderId: string; readonly groupId: string | null },
) {
  const people = await resolveInvitees(deps.storage, rows, { now: deps.now(), from });
  const asked = new Map<string, Request>();
  for (const row of rows) {
    const person = people.find((p) => p.email === normalizeEmail(row.email));
    if (person !== undefined && row.ask !== "") asked.set(person.personId, row.ask);
  }
  return { people, asked };
}

const LEAD_ALONE = "Who is it for? They can answer from an emailed link, with no account.";
const leadFor = (m: GroupMembership) =>
  `Everyone in ${m.group.name} takes part, on their usual terms. Add anyone else here.`;
const POLL_ALONE =
  "Who are you finding a time with? Add them here and they vote from an emailed link, no account needed — or leave this empty and share one link in your group chat.";
const pollLeadFor = (m: GroupMembership) =>
  `Everyone in ${m.group.name} who sees what the group plans votes; anyone who sees only busy time gets the result. Add anyone else here.`;

const EMPTY: FormValues = {
  title: "",
  description: "",
  location: "",
  allDay: false,
  start: "",
  end: "",
  tzid: "",
  repeat: "",
  until: "",
};

// --- Attendance & notes (slice 2D) -------------------------------------------------

const ATTENDANCE_LABEL: Record<Attendance, string> = {
  going: "Going",
  maybe: "Maybe",
  not_going: "Can't make it",
};

/**
 * Attendance and notes, at the viewer's tier. Who said what is participant-list
 * information: names and everyone's notes for tiers that see participants; counts
 * plus your OWN notes for everyone else.
 */
async function responsesSection(
  deps: EventRouteDeps,
  access: EventAccess,
  csrf: string,
): Promise<Html> {
  const { event, participation } = access;
  const names = canSee(participation.visibility, "participants");
  const responses = await listResponses(deps.storage, access);
  const arrivalNames = await namesOn(deps, event.id);
  const via = (arrival: Arrival | null, subjectId: string) =>
    arrivalNote(arrival, subjectId, participation.personId, arrivalNames);
  const count = (a: Attendance) => responses.attendance.filter((r) => r.attendance === a).length;
  const notes = names
    ? responses.feedback
    : responses.feedback.filter((f) => f.personId === participation.personId);
  const scheduled = event.status === "scheduled";
  const open = scheduled || event.status === "proposed";

  const attendanceForm = scheduled
    ? html`<form method="post" action="${EVENTS_PATH}/${event.id}/attendance">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p>${attendanceSchema.options.map(
    (a) =>
      html`<label style="margin-right:.8em"><input type="radio" name="attendance" value="${a}" ${participation.attendance === a ? html`checked` : ""} /> ${ATTENDANCE_LABEL[a]}</label>`,
  )} <button type="submit">Save</button></p>
</form>`
    : "";
  const tally = scheduled
    ? html`<p class="muted">${count("going")} going · ${count("maybe")} maybe · ${count("not_going")} can't make it</p>${
        names && responses.attendance.length > 0
          ? html`<ul>${responses.attendance.map((r) => html`<li>${who(r.shown)}: ${ATTENDANCE_LABEL[r.attendance]}${via(r.arrival, r.personId)}</li>`)}</ul>`
          : ""
      }`
    : "";
  const noteForm = open
    ? html`<form method="post" action="${EVENTS_PATH}/${event.id}/feedback">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><label>Add a note <span class="muted">(e.g. "might be late")</span><br /><textarea name="note" rows="2" maxlength="500" style="width:100%"></textarea></label></p>
  <p><button type="submit">Add note</button></p>
</form>`
    : "";
  const action = actionFor(access);
  const sendLinks =
    participation.editTier === "edit" && action !== null
      ? html`<form method="post" action="${EVENTS_PATH}/${event.id}/links">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><button type="submit">${action === "attend" ? "Email everyone a link to say if they're coming" : "Email a link to agree or decline"}</button>
  <span class="muted">No account needed to answer.</span></p>
</form>`
      : "";
  return html`${scheduled ? html`<h2>Are you coming?</h2>${attendanceForm}${tally}` : ""}
<h2>Notes</h2>
${notes.length === 0 ? html`<p class="muted">No notes yet.</p>` : html`<ul>${notes.map((n) => html`<li><span class="muted">${n.at.slice(0, 16).replace("T", " ")}</span> · ${who(n.shown)}: <span style="white-space:pre-wrap">${n.body}</span>${via(n.arrival, n.personId)}</li>`)}</ul>`}
${noteForm}
${sendLinks}`;
}

// --- Agreement & acknowledgment (slice 2E-1) -----------------------------------------

const GIVEN_STATES: ReadonlySet<string> = new Set(["accepted", "declined", "acknowledged"]);
const STATE_LABEL: Record<string, string> = {
  pending: "not answered yet",
  accepted: "agreed ✓",
  declined: "declined",
  acknowledged: "seen ✓",
  reack: "asked to look again",
};

function button(
  eventId: string,
  path: string,
  csrf: string,
  label: string,
  fields: Record<string, string> = {},
): Html {
  return html`<form method="post" action="${EVENTS_PATH}/${eventId}/${path}" style="display:inline-block;margin:0 .5em .5em 0">
  <input type="hidden" name="csrf" value="${csrf}" />
  ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
  <button type="submit">${label}</button>
</form>`;
}

/**
 * What this person is asked to do, who stands where (names only for tiers that see
 * participants — their own line always), and the organizer's lifecycle buttons.
 */
async function requestsSection(
  deps: EventRouteDeps,
  access: EventAccess,
  csrf: string,
): Promise<Html | string> {
  const { event, participation } = access;
  const me = participation.personId;
  const names = canSee(participation.visibility, "participants");
  const requests = (await listRequests(deps.storage, access)).filter(
    (r) => names || r.personId === me,
  );
  const namesById = await namesOn(deps, event.id);

  const mine: Html[] = [];
  if (event.status === "proposed" && participation.responseKind === "accept") {
    mine.push(html`<p><strong>You're asked to agree to this.</strong></p>
${button(event.id, "answer", csrf, "Agree", { answer: "accept" })}${button(event.id, "answer", csrf, "Decline", { answer: "decline" })}`);
  }
  if (needsAcknowledgment(access)) {
    const again = participation.responseState === "reack";
    mine.push(html`<p><strong>${again ? "This changed since you last saw it — please look again." : "You're asked to acknowledge this."}</strong></p>
${button(event.id, "acknowledge", csrf, again ? "I've seen the change" : "Seen it")}`);
  }
  const organizer: Html[] = [];
  if (event.status === "proposed" && event.ownerId === me) {
    organizer.push(button(event.id, "withdraw", csrf, "Withdraw the proposal"));
  }
  if (participation.editTier === "edit" && event.status === "scheduled") {
    organizer.push(button(event.id, "cancel", csrf, "Cancel the event"));
  }
  if (participation.editTier === "edit" && event.status === "cancelled") {
    organizer.push(button(event.id, "restore", csrf, "Restore the event"));
  }
  const list =
    requests.length === 0
      ? ""
      : html`<h2>Asked</h2><ul>${requests.map(
          (r) =>
            html`<li>${who(r.shown)}: ${REQUEST_LABEL[r.kind]} — ${STATE_LABEL[r.state] ?? r.state}${
              r.at === null
                ? ""
                : html` <span class="muted">${r.at.slice(0, 16).replace("T", " ")}</span>`
            }${
              // Only on an answer they gave: "asked to look again" is ours, not theirs.
              GIVEN_STATES.has(r.state) ? arrivalNote(r.arrival, r.personId, me, namesById) : ""
            }</li>`,
        )}</ul>`;
  return html`${mine}${list}${organizer.length === 0 ? "" : html`<p>${organizer}</p>`}`;
}

interface PollFormValues extends FormValues {
  readonly slots: readonly { readonly start: string; readonly end: string }[];
}

const POLL_ROWS = 5;

function readPollForm(form: Record<string, unknown>): PollFormValues {
  const slots = Array.from({ length: MAX_CANDIDATES }, (_, i) => ({
    start: str(form, `start_${i}`),
    end: str(form, `end_${i}`),
  }));
  return { ...readForm(form), slots };
}

function pollForm(
  action: string,
  csrf: string,
  v: PollFormValues,
  error: string | null,
  people: Html | string = "",
): Html {
  const shown = Math.max(POLL_ROWS, v.slots.filter((s) => s.start !== "" || s.end !== "").length);
  const slots = Array.from(
    { length: Math.min(shown, MAX_CANDIDATES) },
    (_, i) => v.slots[i] ?? { start: "", end: "" },
  );
  return html`${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${action}" data-picker="poll" data-max="${MAX_CANDIDATES}" data-busy="${BUSY_PATH}">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><label>What<br /><input name="title" required maxlength="200" value="${v.title}" style="width:100%" /></label></p>
  <p><label>Where<br /><input name="location" maxlength="500" value="${v.location}" style="width:100%" /></label></p>
  <p><label>Time zone<br /><input id="tzid" name="tzid" list="zones" value="${v.tzid}" placeholder="Europe/Prague" /></label></p>
  ${zoneOptions()}
  <h2>Options</h2>
  <div data-picker-plain>
  <p><label><input type="checkbox" name="allDay" ${v.allDay ? html`checked` : ""} /> All-day options</label></p>
  <p class="muted">One time asks who's in; a few let people choose. Leave the rows you don't need empty. For all-day options, "ends" is the last day.</p>
  ${slots.map(
    (
      slot,
      i,
    ) => html`<p><label>Starts <input type="datetime-local" name="start_${i}" value="${slot.start}" /></label>
  <label>Ends <input type="datetime-local" name="end_${i}" value="${slot.end}" /></label></p>`,
  )}
  </div>
  <p><label>Notes <span class="muted">(everyone in the poll sees these)</span><br /><textarea name="description" rows="3" style="width:100%">${v.description}</textarea></label></p>
  ${people}
  <p><button type="submit">Start the poll</button></p>
</form>
${ZONE_GUESS}
${pickerAssets()}`;
}

/** Poll form → domain input: shared fields once, a time pair per filled row. */
/**
 * The event form's fields as the server reads them, before validation. Exported for
 * the client–server agreement properties (DESIGN §9 rc17): whatever the picker writes
 * into the plain fields must survive exactly this.
 */
export function eventInputFromForm(form: Record<string, unknown>): EventFieldsInput {
  return toFields(readForm(form));
}

/** The poll form's fields as the server reads them, before validation (as above). */
export function pollInputFromForm(form: Record<string, unknown>) {
  return toPollInput(readPollForm(form));
}

function toPollInput(v: PollFormValues) {
  const filled = v.slots.filter((s) => s.start !== "" || s.end !== "");
  const times = filled.map((s) => {
    const f = toFields({ ...v, start: s.start, end: s.end });
    return { startLocal: f.startLocal, endLocal: f.endLocal };
  });
  const base = toFields({ ...v, start: "", end: "" });
  return {
    fields: {
      title: base.title,
      description: base.description,
      location: base.location,
      allDay: base.allDay,
      tzid: base.tzid,
    },
    candidates: times,
  };
}

function editHeading(proposing: boolean): Html {
  return proposing
    ? html`<h1>Propose a change</h1>
<p class="muted">Nothing changes yet: someone who can edit this event will accept or turn down your proposal.</p>`
    : html`<h1>Edit event</h1>`;
}

function renderHistoryValue(field: string, v: string | number | null): string {
  if (field === "rrule") return v === null ? "doesn't repeat" : describeRRule(String(v));
  return v === null ? "—" : String(v);
}

/** A diff as list items, minus every field this tier can't see (the history rule). */
function changeList(
  vis: EventAccess["participation"]["visibility"],
  change: Record<string, { before: string | number | null; after: string | number | null }>,
): Html {
  return html`<ul>${Object.entries(change)
    .filter(([field]) => canSeeField(vis, field))
    .map(
      ([field, c]) =>
        html`<li>${field}: ${renderHistoryValue(field, c.before)} → ${renderHistoryValue(field, c.after)}</li>`,
    )}</ul>`;
}

const OUTCOME: Record<Exclude<ChangeProposal["status"], "pending" | "withdrawn">, string> = {
  accepted: "was accepted",
  rejected: "was turned down",
  superseded: "wasn't decided before the event changed — propose it again if it still matters",
};

/**
 * Change proposals (slice 2E-2): editors decide what is pending; a proposer sees what
 * became of theirs, so a rejection or a supersede is never silent. Nobody else sees any.
 */
async function proposalsSection(
  deps: EventRouteDeps,
  access: EventAccess,
  csrf: string,
): Promise<Html | string> {
  const { event, participation } = access;
  const vis = participation.visibility;
  const { pending, mine } = await listProposals(deps.storage, access);
  const forEditor = pending.map(
    (p) => html`<li><strong>${who(p.proposer)}</strong> proposes:
${p.change === null ? "" : changeList(vis, p.change)}
${button(event.id, "proposal", csrf, "Accept", { proposal: p.id, decision: "accept" })}${button(event.id, "proposal", csrf, "Reject", { proposal: p.id, decision: "reject" })}</li>`,
  );
  let own: Html | string = "";
  if (mine !== null) {
    const { status } = mine;
    if (status === "pending") {
      own = html`<p>You proposed a change — waiting for someone who can edit to accept it.</p>
${mine.change === null ? "" : changeList(vis, mine.change)}
${button(event.id, "proposal/withdraw", csrf, "Withdraw my proposal", { proposal: mine.id })}`;
    } else if (status !== "withdrawn") {
      const by =
        status === "superseded" || mine.decidedBy === null ? "" : ` by ${mine.decidedBy.name}`;
      own = html`<p class="muted">Your proposal ${OUTCOME[status]}${by}.</p>`;
    }
  }
  if (forEditor.length === 0 && own === "") return "";
  return html`<h2>Proposed changes</h2>${forEditor.length === 0 ? "" : html`<ul>${forEditor}</ul>`}${own}`;
}

/** How a series repeats and its next dates — time, so every tier that sees the event. */
function seriesSection(event: CanonicalEvent, now: string): Html | string {
  if (event.rrule === null) return "";
  const next = event.status === "scheduled" ? nextDates(event, now, 5) : [];
  return html`<p>↻ ${describeRRule(event.rrule)}</p>${
    next.length === 0
      ? ""
      : html`<p class="muted">Next:</p><ul>${next.map((d) => html`<li>${d}</li>`)}</ul>`
  }`;
}

/** One edit in the trail, already filtered to the fields this viewer may see. */
function historyEntry(
  h: HistoryEntry & { readonly fields: [string, HistoryEntry["change"][string]][] },
): Html {
  return html`<span class="muted">${h.at.slice(0, 16).replace("T", " ")}</span> · ${h.actor === null ? "someone" : who(h.actor)} ${
    h.revision === 1
      ? "created it"
      : h.proposedBy === null
        ? "changed"
        : `accepted ${h.proposedBy.name}'s proposal`
  }${
    h.revision === 1
      ? ""
      : html`<ul>${h.fields.map(([field, c]) => html`<li>${field}: ${renderHistoryValue(field, c.before)} → ${renderHistoryValue(field, c.after)}</li>`)}</ul>`
  }`;
}

/**
 * Who takes part. An `edit` participant also adds people by email and removes them
 * (DESIGN rc15): never the creator, and never someone a proposal still waits on.
 */
function peopleSection(
  access: EventAccess,
  people: readonly ParticipantView[],
  csrf: string,
): Html {
  const { event } = access;
  const editing = access.participation.editTier === "edit";
  const removable = (p: ParticipantView) =>
    editing &&
    p.personId !== event.ownerId &&
    !(event.status === "proposed" && p.responseKind === "accept");
  // Their own answer link, to send in a chat instead of by email (rc36).
  const copyable = (p: ParticipantView) =>
    editing &&
    actionFor(access) !== null &&
    p.personId !== access.participation.personId &&
    p.visibility !== "HIDDEN";
  return html`<h2>Taking part</h2><ul>${people.map(
    (p) =>
      html`<li>${who(p.shown)}${p.editTier === "edit" ? html` <span class="muted">· can edit</span>` : ""}${
        removable(p)
          ? html` <form method="post" action="${EVENTS_PATH}/${event.id}/people/remove" style="display:inline"><input type="hidden" name="csrf" value="${csrf}" /><input type="hidden" name="person" value="${p.personId}" /><button type="submit">Remove</button></form>`
          : ""
      }${
        copyable(p)
          ? html` <form method="post" action="${EVENTS_PATH}/${event.id}/people/link" style="display:inline"><input type="hidden" name="csrf" value="${csrf}" /><input type="hidden" name="person" value="${p.personId}" /><button type="submit">Copy their link</button></form>`
          : ""
      }</li>`,
  )}</ul>
${
  editing && TAKES_PEOPLE.has(event.status)
    ? html`<form method="post" action="${EVENTS_PATH}/${event.id}/people">
  <input type="hidden" name="csrf" value="${csrf}" />
  <label for="add-email">Add someone by email</label>
  <input id="add-email" name="email" type="email" required />
  <p>
    <label>Can change it:
      <select name="editTier">
        <option value="view" selected>no — view only</option>
        <option value="propose">propose changes</option>
        <option value="edit">yes — edit directly</option>
      </select>
    </label>
  </p>
  <p>
    <label>Sees:
      <select name="visibility">
        <option value="FULL" selected>everything</option>
        <option value="DETAILS">title, time and place</option>
        <option value="BUSY">only that time is taken</option>
      </select>
    </label>
  </p>
  <p><button type="submit">Add and email them a link</button></p>
</form>`
    : ""
}`;
}

async function eventPage(
  c: Context<AppEnv>,
  deps: EventRouteDeps,
  access: EventAccess,
  csrf: string,
  notice: string | null = null,
): Promise<string> {
  const { event, participation } = access;
  const vis = participation.visibility;
  const see = (part: Parameters<typeof canSee>[1]) => canSee(vis, part);
  const people = see("participants") ? await listParticipants(deps.storage, event.id) : [];
  const edits = (await listHistory(deps.storage, access))
    .map((entry) => ({
      ...entry,
      // The integrity rule applied to history: drop every field this tier can't see.
      fields: Object.entries(entry.change).filter(([field]) => canSeeField(vis, field)),
    }))
    .filter((entry) => entry.fields.length > 0);
  // Who was added and removed names people: only for a tier that sees them.
  const peopleChanges = see("participants")
    ? await listParticipantChanges(deps.storage, access)
    : [];
  // One attributed trail, newest first (DESIGN rc15): edits and people changes together.
  const history = [
    ...edits.map((h) => ({ at: h.at, entry: historyEntry(h) })),
    ...peopleChanges.map((h) => ({
      at: h.at,
      entry: html`<span class="muted">${h.at.slice(0, 16).replace("T", " ")}</span> · ${
        h.actorId === h.personId
          ? html`${who(h.person)} ${h.action === "added" ? "joined" : "left"}`
          : html`${who(h.actor)} ${h.action === "added" ? "added" : "removed"} ${who(h.person)}`
      }`,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return page(
    c,
    see("title") ? event.title : BUSY_LABEL,
    html`<p>${event.groupId === null ? html`<a href="/">← Your events</a>` : html`<a href="/groups/${event.groupId}">← Back to the group</a>`}</p>
<h1>${see("title") ? event.title : BUSY_LABEL}${statusBadge(access)}</h1>
${notice === null ? "" : html`<p class="error">${notice}</p>`}
<p>${formatWhen(event)}</p>
${seriesSection(event, deps.now())}
${see("location") && event.location !== null ? html`<p>📍 ${event.location}</p>` : ""}
${see("description") && event.description !== null ? html`<p style="white-space:pre-wrap">${event.description}</p>` : ""}
${
  participation.editTier === "edit" &&
  (event.status === "scheduled" || event.status === "cancelled")
    ? html`<p><a href="${EVENTS_PATH}/${event.id}/edit">Edit</a></p>`
    : participation.editTier === "propose" && event.status === "scheduled"
      ? html`<p><a href="${EVENTS_PATH}/${event.id}/edit">Propose a change</a></p>`
      : ""
}
${await requestsSection(deps, access, csrf)}
${await proposalsSection(deps, access, csrf)}
${people.length === 0 ? "" : peopleSection(access, people, csrf)}
${see("participants") ? await appearanceSection(deps.storage, { kind: "event", id: event.id }, { personId: participation.personId, csrfToken: csrf }, `${EVENTS_PATH}/${event.id}/me`, "event") : ""}
${await responsesSection(deps, access, csrf)}
${retentionSection({
  days: await eventRetention(deps.storage, access),
  subject: "This event is",
  ends: "it ends",
  form:
    participation.editTier === "edit"
      ? { action: `${EVENTS_PATH}/${event.id}/retention`, csrf, note: null }
      : null,
})}
<h2>History</h2>
<ul>${history.map((h) => html`<li>${h.entry}</li>`)}</ul>
<p class="muted"><a href="${EVENTS_PATH}/${event.id}/leave">Leave this event</a>${
      participation.editTier === "edit"
        ? html` · <a href="${EVENTS_PATH}/${event.id}/delete">Delete it for everyone</a>`
        : ""
    }</p>`,
  );
}

/** How the event's people see this person: mail names them this way, never by address. */
async function nameIn(storage: StoragePort, access: EventAccess, personId: string) {
  const a = await appearanceIn(storage, { kind: "event", id: access.event.id }, personId);
  return a?.shown.name ?? "Someone";
}

export function registerEventRoutes(app: Hono<AppEnv>, deps: EventRouteDeps): void {
  /** The new-event page, for a group (its members included) or for people by email alone. */
  const newEventPage = async (
    c: Context<AppEnv>,
    csrf: string,
    meId: string,
    membership: GroupMembership | null,
    form: { values: FormValues; rows: readonly PersonRow[]; asks: ReadonlyMap<string, Request> },
    error: string | null,
  ) =>
    page(
      c,
      "New event",
      membership === null
        ? html`<p><a href="/">← Your events</a></p>
<h1>New event</h1>
${eventForm(EVENTS_PATH, csrf, form.values, "", error, "Create event", "FULL", peopleFieldset(form.rows, true, LEAD_ALONE))}`
        : html`<p><a href="/groups/${membership.group.id}">← ${membership.group.name}</a></p>
<h1>New event for ${membership.group.name}</h1>
${eventForm(`/groups/${membership.group.id}/events`, csrf, form.values, "", error, "Create event", "FULL", html`${await requestsFieldset(deps, membership, meId, form.asks)}${peopleFieldset(form.rows, true, leadFor(membership))}`)}`,
    );

  const createEventFrom = async (c: Context<AppEnv>, groupId: string | null) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const membership =
      groupId === null ? null : await findGroupForMember(deps.storage, groupId, me.personId);
    if (groupId !== null && membership === null) return c.html(notFound(c), 404);
    const values = readForm(form);
    const asks = readRequests(form);
    const { rows, bad } = readPeople(form);
    const again = async (error: string) =>
      c.html(
        await newEventPage(c, me.csrfToken, me.personId, membership, { values, rows, asks }, error),
        400,
      );
    if (bad.length > 0) return again(badPeople(bad));
    try {
      const fields = toFields(values);
      // Fully valid BEFORE anyone is created for an address: a refused form creates no one.
      eventFieldsSchema.parse(fields);
      const { people, asked } = await invitees(deps, rows, {
        senderId: me.personId,
        groupId: membership?.group.id ?? null,
      });
      const event = await createEvent(deps.storage, {
        creatorId: me.personId,
        group: membership,
        fields,
        now: deps.now(),
        requests: new Map([...asks, ...asked]),
        people,
      });
      return c.redirect(`${EVENTS_PATH}/${event.id}`, 303);
    } catch (error) {
      return again(errorMessage(error));
    }
  };

  const NOTHING = { values: EMPTY, rows: [], asks: new Map<string, Request>() };

  app.get(`${EVENTS_PATH}/new`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    return c.html(await newEventPage(c, me.csrfToken, me.personId, null, NOTHING, null));
  });

  app.post(EVENTS_PATH, (c) => createEventFrom(c, null));

  app.get("/groups/:groupId/events/new", async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const membership = await findGroupForMember(deps.storage, c.req.param("groupId"), me.personId);
    if (membership === null) return groupNotVisible(c, deps, c.req.param("groupId"));
    return c.html(await newEventPage(c, me.csrfToken, me.personId, membership, NOTHING, null));
  });

  app.post("/groups/:groupId/events", (c) => createEventFrom(c, c.req.param("groupId")));

  app.get(`${EVENTS_PATH}/:id`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    // HIDDEN means "no projection at all" (WORKFLOWS §3): indistinguishable from absent.
    if (access === null || access.participation.visibility === "HIDDEN")
      return eventNotVisible(c, deps, c.req.param("id"));
    return c.html(await eventPage(c, deps, access, me.csrfToken));
  });

  app.get(`${EVENTS_PATH}/:id/edit`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return eventNotVisible(c, deps, c.req.param("id"));
    const proposing = access.participation.editTier === "propose";
    if (access.participation.editTier === "view")
      return c.html(page(c, "Not allowed", html`<h1>You can't edit this event</h1>`), 403);
    if (proposing && access.event.status !== "scheduled")
      return c.html(
        page(
          c,
          "Not now",
          html`<h1>Changes can't be proposed right now</h1><p>Only a scheduled event takes proposals. <a href="${EVENTS_PATH}/${access.event.id}">Back to the event</a></p>`,
        ),
        409,
      );
    if (access.event.status === "proposed")
      return c.html(
        page(
          c,
          "Not now",
          html`<h1>This is waiting for agreement</h1><p>It can be changed once it's settled. <a href="${EVENTS_PATH}/${access.event.id}">Back to it</a></p>`,
        ),
        409,
      );
    const { event } = access;
    const vis = access.participation.visibility;
    return c.html(
      page(
        c,
        canSee(vis, "title") ? `Edit ${event.title}` : "Edit",
        html`<p><a href="${EVENTS_PATH}/${event.id}">← ${canSee(vis, "title") ? event.title : BUSY_LABEL}</a></p>
${editHeading(proposing)}
${eventForm(`${EVENTS_PATH}/${event.id}`, me.csrfToken, valuesFrom(event), html`<input type="hidden" name="revision" value="${event.revision}" />`, null, proposing ? "Send proposal" : "Save", vis, "", event.id)}`,
      ),
    );
  });

  app.post(`${EVENTS_PATH}/:id`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(c), 404);

    const seen = Number.parseInt(str(form, "revision"), 10);
    const values = readForm(form);
    const proposing = access.participation.editTier === "propose";
    const vis = access.participation.visibility;
    const editForm = (error: string, v: FormValues, revision: number) =>
      page(
        c,
        canSee(vis, "title") ? `Edit ${access.event.title}` : "Edit",
        html`${editHeading(proposing)}
${eventForm(`${EVENTS_PATH}/${access.event.id}`, me.csrfToken, v, html`<input type="hidden" name="revision" value="${revision}" />`, error, proposing ? "Send proposal" : "Save", vis, "", access.event.id)}`,
      );

    let result: Awaited<ReturnType<typeof editEvent>> | Awaited<ReturnType<typeof proposeChange>>;
    try {
      const input = {
        // Fields this tier can't see aren't in the form; they keep their current values.
        fields: withHidden(toFields(values), access),
        now: deps.now(),
        // The revision the person SAW, from the form — not the one re-read just now.
        expectedRevision: Number.isInteger(seen) ? seen : -1,
      };
      // The propose tier's edit doesn't apply: it waits for an editor (slice 2E-2).
      result = proposing
        ? await proposeChange(deps.storage, access, input)
        : await editEvent(deps.storage, access, { ...input, actorId: me.personId });
    } catch (error) {
      return c.html(editForm(errorMessage(error), values, seen), 400);
    }
    switch (result.kind) {
      case "updated":
      case "unchanged":
      case "proposed":
        return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
      case "forbidden":
        return c.html(page(c, "Not allowed", html`<h1>You can't edit this event</h1>`), 403);
      case "closed":
        return c.html(
          await eventPage(c, deps, access, me.csrfToken, "Only a scheduled event takes proposals."),
          409,
        );
      case "limit":
        return c.html(
          editForm(
            "You've proposed changes to this event too many times.",
            values,
            access.event.revision,
          ),
          400,
        );
      case "conflict": {
        // Show the CURRENT version; their typed change is lost on purpose rather than
        // silently overwriting someone else's. The message says so.
        const fresh = await findEventForParticipant(deps.storage, access.event.id, me.personId);
        const current = fresh ?? access;
        return c.html(
          editForm(
            "Someone else changed this event while you were editing. This is the current version — please make your change again.",
            valuesFrom(current.event),
            current.event.revision,
          ),
          409,
        );
      }
    }
  });

  /** The new-poll page, for a group (its members included) or for people by email alone. */
  const newPollPage = (
    c: Context<AppEnv>,
    csrf: string,
    membership: GroupMembership | null,
    values: PollFormValues,
    rows: readonly PersonRow[],
    error: string | null,
  ) =>
    page(
      c,
      "Find a time",
      membership === null
        ? html`<p><a href="/">← Your events</a></p>
<h1>Find a time</h1>
${pollForm(POLLS_PATH, csrf, values, error, peopleFieldset(rows, false, POLL_ALONE, false))}`
        : html`<p><a href="/groups/${membership.group.id}">← ${membership.group.name}</a></p>
<h1>Find a time with ${membership.group.name}</h1>
${pollForm(`/groups/${membership.group.id}/polls`, csrf, values, error, peopleFieldset(rows, false, pollLeadFor(membership), false))}`,
    );

  const createPollFrom = async (c: Context<AppEnv>, groupId: string | null) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const membership =
      groupId === null ? null : await findGroupForMember(deps.storage, groupId, me.personId);
    if (groupId !== null && membership === null) return c.html(notFound(c), 404);
    const values = readPollForm(form);
    const { rows, bad } = readPeople(form);
    const again = (error: string) =>
      c.html(newPollPage(c, me.csrfToken, membership, values, rows, error), 400);
    if (bad.length > 0) return again(badPeople(bad));
    try {
      const input = toPollInput(values);
      validateCandidates(input.fields, input.candidates); // as above: valid before anyone is created
      const { people } = await invitees(deps, rows, {
        senderId: me.personId,
        groupId: membership?.group.id ?? null,
      });
      // A poll is a thread of one-event plans (rc26).
      const { threadId } = await createPollThread(deps.storage, {
        creatorId: me.personId,
        group: membership,
        fields: input.fields,
        candidates: input.candidates,
        people: people.map((p) => p.personId),
        now: deps.now(),
      });
      // Nobody else in it yet: it was made to be shared, so it opens on that step (rc29).
      const made = await findThreadForMember(deps.storage, threadId, me.personId);
      const alone = made?.members.length === 1;
      return c.redirect(`${PLANS_PATH}/${threadId}${alone ? "#share" : ""}`, 303);
    } catch (error) {
      return again(errorMessage(error));
    }
  };

  const NO_POLL: PollFormValues = { ...EMPTY, slots: [] };

  app.get(`${POLLS_PATH}/new`, (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    return c.html(newPollPage(c, me.csrfToken, null, NO_POLL, [], null));
  });

  app.post(POLLS_PATH, (c) => createPollFrom(c, null));

  app.get("/groups/:groupId/polls/new", async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const membership = await findGroupForMember(deps.storage, c.req.param("groupId"), me.personId);
    if (membership === null) return groupNotVisible(c, deps, c.req.param("groupId"));
    return c.html(newPollPage(c, me.csrfToken, membership, NO_POLL, [], null));
  });

  app.post("/groups/:groupId/polls", (c) => createPollFrom(c, c.req.param("groupId")));

  // Leaving and deleting (DESIGN §10 rc21). GET says what will happen; POST does it.
  const visible = async (c: Context<AppEnv>, personId: string) => {
    const access = await findEventForParticipant(deps.storage, c.req.param("id") ?? "", personId);
    return access === null || access.participation.visibility === "HIDDEN" ? null : access;
  };
  const titleOf = (access: EventAccess) =>
    canSee(access.participation.visibility, "title") ? access.event.title : BUSY_LABEL;
  const confirmPage = (
    c: Context<AppEnv>,
    title: string,
    body: Html,
    action: string,
    button: string,
    csrf: string,
  ) =>
    page(
      c,
      title,
      html`<h1>${title}</h1>${body}
<form method="post" action="${action}">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><button type="submit">${button}</button> <a href="${action.replace(/\/(leave|delete)$/, "")}">Keep it</a></p>
</form>`,
    );

  app.get(`${EVENTS_PATH}/:id/leave`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await visible(c, me.personId);
    if (access === null) return c.html(notFound(c), 404);
    const after = await othersAfterLeaving(deps.storage, access);
    const lastEditor = access.participation.editTier === "edit" && after.editors === 0;
    return c.html(
      confirmPage(
        c,
        `Leave “${titleOf(access)}”?`,
        html`<p>Your answers, votes and notes here go, and it leaves your events. What you changed stays in its history under your name.</p>${
          lastEditor
            ? html`<p class="error">Nobody else can edit it, so leaving deletes it${
                after.people > 0
                  ? ` for the ${after.people} other ${after.people === 1 ? "person" : "people"} on it too`
                  : ""
              }. To keep it for them, make someone else an editor first.</p>`
            : ""
        }`,
        `${EVENTS_PATH}/${access.event.id}/leave`,
        lastEditor ? "Leave and delete it" : "Leave",
        me.csrfToken,
      ),
    );
  });

  app.post(`${EVENTS_PATH}/:id/leave`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await visible(c, me.personId);
    if (access === null) return c.html(notFound(c), 404);
    const left = await leaveEvent(deps.storage, access, { now: deps.now() });
    if (left.kind === "awaited")
      return c.html(
        page(
          c,
          "Answer first",
          html`<h1>It's waiting for your answer</h1><p>This won't happen unless you agree. Decline it instead of leaving: then everyone knows.</p><p><a href="${EVENTS_PATH}/${access.event.id}">← Back</a></p>`,
        ),
        409,
      );
    return c.redirect("/", 303);
  });

  app.get(`${EVENTS_PATH}/:id/delete`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await visible(c, me.personId);
    if (access === null) return c.html(notFound(c), 404);
    const allowed = canDelete(access, deps.now());
    if (allowed === "forbidden")
      return c.html(page(c, "Not allowed", html`<h1>Only its editors can delete it</h1>`), 403);
    if (allowed === "upcoming")
      return c.html(
        page(
          c,
          "Cancel it first",
          html`<h1>Cancel it first</h1><p>It's still ahead, and its people think it's on. Cancel it so they're told; then you can delete it.</p><p><a href="${EVENTS_PATH}/${access.event.id}">← Back</a></p>`,
        ),
        409,
      );
    return c.html(
      confirmPage(
        c,
        `Delete “${titleOf(access)}” for everyone?`,
        html`<p>It goes from everyone's events, with its answers, notes and history. This can't be undone.</p>`,
        `${EVENTS_PATH}/${access.event.id}/delete`,
        "Delete it",
        me.csrfToken,
      ),
    );
  });

  app.post(`${EVENTS_PATH}/:id/delete`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await visible(c, me.personId);
    if (access === null) return c.html(notFound(c), 404);
    const result = await deleteEvent(deps.storage, access, deps.now());
    switch (result.kind) {
      case "deleted":
        return c.redirect("/", 303);
      case "forbidden":
        return c.html(page(c, "Not allowed", html`<h1>Only its editors can delete it</h1>`), 403);
      case "upcoming":
        return c.html(page(c, "Cancel it first", html`<h1>Cancel it first</h1>`), 409);
      case "mirrored":
        return c.html(
          page(c, "Deleting", html`<h1>It will be gone once it's out of everyone's calendars</h1>`),
          202,
        );
      default: {
        const unreachable: never = result;
        return unreachable;
      }
    }
  });

  // "You appear here as…" (§10 rc21): participation is the access check.
  // Retention (DESIGN §10 rc23): editors only. Not an edit — no revision, history or sync.
  app.post(`${EVENTS_PATH}/:id/retention`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return eventNotVisible(c, deps, c.req.param("id"));
    const days = retainDaysSchema.safeParse(form.retain_days);
    if (!days.success)
      return c.html(page(c, "Not saved", html`<h1>Choose one of the periods</h1>`), 400);
    if (!(await setEventRetention(deps.storage, access, days.data)))
      return c.html(
        page(c, "Not allowed", html`<h1>Only the event's editors can change this</h1>`),
        403,
      );
    return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
  });

  app.post(`${EVENTS_PATH}/:id/me`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(c), 404);
    const id = access.event.id;
    return saveAppearance(c, deps.storage, { kind: "event", id }, `${EVENTS_PATH}/${id}`);
  });

  app.post(`${EVENTS_PATH}/:id/attendance`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(c), 404);
    const attendance = attendanceSchema.safeParse(form.attendance);
    if (!attendance.success)
      return c.html(
        await eventPage(c, deps, access, me.csrfToken, "Pick one of the answers."),
        400,
      );
    const result = await setAttendance(deps.storage, access, {
      attendance: attendance.data,
      now: deps.now(),
      arrival: SIGNED_IN,
    });
    if (result.kind !== "recorded")
      return c.html(
        await eventPage(c, deps, access, me.csrfToken, "This event isn't taking answers."),
        409,
      );
    return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
  });

  app.post(`${EVENTS_PATH}/:id/feedback`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(c), 404);
    const result = await addFeedback(deps.storage, access, {
      body: str(form, "note"),
      now: deps.now(),
      arrival: SIGNED_IN,
    });
    switch (result.kind) {
      case "recorded":
        return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
      case "invalid":
        return c.html(await eventPage(c, deps, access, me.csrfToken, result.reason), 400);
      case "closed":
      case "forbidden":
        return c.html(
          await eventPage(c, deps, access, me.csrfToken, "This event isn't taking notes."),
          409,
        );
    }
  });

  // People on an existing event (DESIGN rc15, slice 2F): its `edit` participants add by
  // email and remove. The participation is written first and is the truth; the mail
  // that follows can fail, and the page then says so.
  app.post(`${EVENTS_PATH}/:id/people`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(c), 404);
    const editTier = editTierSchema.safeParse(form.editTier);
    const visibility = visibilitySchema.exclude(["HIDDEN"]).safeParse(form.visibility);
    let email: string;
    try {
      email = normalizeEmail(str(form, "email"));
    } catch {
      return c.html(
        await eventPage(c, deps, access, me.csrfToken, "That isn't an email address."),
        400,
      );
    }
    if (!editTier.success || !visibility.success)
      return c.html(await eventPage(c, deps, access, me.csrfToken, "Please try again."), 400);

    const added = await addParticipant(deps.storage, access, {
      email,
      editTier: editTier.data,
      visibility: visibility.data,
      now: deps.now(),
    });
    switch (added.kind) {
      case "forbidden":
        return c.html(
          page(c, "Not allowed", html`<h1>Only people who can edit it add people</h1>`),
          403,
        );
      case "closed":
        return c.html(
          await eventPage(
            c,
            deps,
            access,
            me.csrfToken,
            "This event is over; it takes no one new.",
          ),
          409,
        );
      case "already":
        return c.html(
          await eventPage(c, deps, access, me.csrfToken, `${email} is already taking part.`),
          409,
        );
      case "rate_limited":
        return c.html(
          await eventPage(
            c,
            deps,
            access,
            me.csrfToken,
            "Too many people added to this event today. Please try again tomorrow.",
          ),
          429,
        );
      case "unreachable":
        return c.html(
          await eventPage(c, deps, access, me.csrfToken, `Couldn't add ${email}.`),
          422,
        );
      case "added":
        break;
    }

    const issued = await issueResponseLinks(deps.storage, access, {
      now: deps.now(),
      only: added.personId,
    });
    const link = issued.kind === "issued" ? issued.links[0] : undefined;
    if (link === undefined)
      return c.html(
        await eventPage(
          c,
          deps,
          access,
          me.csrfToken,
          `Added ${added.email}. There's nothing to ask them yet, so no email was sent.`,
        ),
      );
    try {
      await sendResponseLink(deps.mail, {
        link,
        access,
        from: await nameIn(deps.storage, access, me.personId),
        publicBaseUrl: deps.publicBaseUrl,
      });
    } catch (error) {
      // Withdraw the unsent link so "Email everyone a link" isn't throttled for them.
      await revokeUndeliveredLink(deps.storage, link);
      return c.html(
        await eventPage(
          c,
          deps,
          access,
          me.csrfToken,
          error instanceof MailCapReachedError
            ? `Added ${added.email}, but couldn't email them. ${cappedText(error, deps.now(), true)}`
            : `Added ${added.email}, but couldn't email them. Use "Email everyone a link" to try again later.`,
        ),
        503,
      );
    }
    return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
  });

  app.post(`${EVENTS_PATH}/:id/people/remove`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(c), 404);
    const removed = await removeParticipant(deps.storage, access, {
      personId: str(form, "person"),
      now: deps.now(),
    });
    const refused = (notice: string, status: 403 | 409) =>
      eventPage(c, deps, access, me.csrfToken, notice).then((body) => c.html(body, status));
    switch (removed.kind) {
      case "removed":
        // Removing yourself leaves a page you can no longer see.
        return c.redirect(
          str(form, "person") === me.personId ? "/" : `${EVENTS_PATH}/${access.event.id}`,
          303,
        );
      case "forbidden":
        return c.html(
          page(c, "Not allowed", html`<h1>Only people who can edit it remove people</h1>`),
          403,
        );
      case "creator":
        return refused("Whoever created the event can't be removed from it.", 409);
      case "last_editor":
        return refused("Someone has to be able to edit the event; add another editor first.", 409);
      case "awaited":
        return refused(
          "The event is waiting for their agreement. Withdraw the proposal instead.",
          409,
        );
      case "not_taking_part":
        return refused("They aren't taking part.", 409);
    }
  });

  // Copy one person's answer link instead of emailing it (rc36): a fresh link, shown once,
  // replacing theirs. A POST, so a page that shows it can't be made by looking.
  app.post(`${EVENTS_PATH}/:id/people/link`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(c), 404);
    const personId = str(form, "person");
    const issued = await issueResponseLinks(deps.storage, access, {
      now: deps.now(),
      only: personId,
      copy: true,
    });
    if (issued.kind === "forbidden")
      return c.html(
        page(c, "Not allowed", html`<h1>Only people who can edit it copy links</h1>`),
        403,
      );
    const link =
      issued.kind === "issued" ? issued.links.find((l) => l.personId === personId) : undefined;
    if (link === undefined)
      return c.html(
        await eventPage(c, deps, access, me.csrfToken, "They have nothing to answer here."),
        409,
      );
    const shown = (await listParticipants(deps.storage, access.event.id)).find(
      (p) => p.personId === personId,
    )?.shown.name;
    // The link is on this page: keep it out of caches and Referer headers.
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.html(
      page(
        c,
        "Their link",
        html`${copiedLink(
          shown ?? "them",
          respondUrl(deps.publicBaseUrl, link.token).toString(),
          RESPONSE_TOKEN_TTL_MS / (24 * 60 * 60 * 1000),
          `${EVENTS_PATH}/${access.event.id}`,
        )}${SHARE_BUTTONS}`,
      ),
    );
  });

  app.post(`${EVENTS_PATH}/:id/links`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(c), 404);
    const issued = await issueResponseLinks(deps.storage, access, { now: deps.now() });
    if (issued.kind === "forbidden")
      return c.html(page(c, "Not allowed", html`<h1>Only the organizers can send these</h1>`), 403);
    if (issued.kind === "closed")
      return c.html(
        await eventPage(c, deps, access, me.csrfToken, "This event has nothing to ask right now."),
        409,
      );

    let sent = 0;
    let failed = 0;
    let capped: MailCapReachedError | null = null;
    for (const link of issued.links) {
      if (capped !== null) {
        // The cap was reached: don't even try, but withdraw the link so a later retry
        // isn't throttled for someone who never got it.
        await revokeUndeliveredLink(deps.storage, link);
        failed += 1;
        continue;
      }
      try {
        await sendResponseLink(deps.mail, {
          link,
          access,
          from: await nameIn(deps.storage, access, me.personId),
          publicBaseUrl: deps.publicBaseUrl,
        });
        sent += 1;
      } catch (error) {
        await revokeUndeliveredLink(deps.storage, link);
        failed += 1;
        if (error instanceof MailCapReachedError) capped = error;
      }
    }
    const parts = [
      `Sent to ${sent} ${sent === 1 ? "person" : "people"}.`,
      issued.throttled > 0 ? `${issued.throttled} already got a link in the last hour.` : "",
      failed === 0
        ? ""
        : capped === null
          ? `Couldn't send to ${failed} — please try again later.`
          : `Couldn't send to ${failed}. ${cappedText(capped, deps.now(), true)}`,
    ].filter((p) => p !== "");
    return c.html(
      await eventPage(c, deps, access, me.csrfToken, parts.join(" ")),
      failed > 0 ? 503 : 200,
    );
  });

  /** The shared shape of the lifecycle buttons: resolve, act, redirect or explain. */
  const lifecycle = (
    path: string,
    act: (
      access: EventAccess,
      form: Record<string, unknown>,
      now: string,
    ) => Promise<TransitionResult | { readonly kind: "invalid" }>,
  ) =>
    app.post(`${EVENTS_PATH}/:id/${path}`, async (c) => {
      const me = requireSignedIn(c);
      if (me instanceof Response) return me;
      const form = await c.req.parseBody();
      if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
      const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
      if (access === null || access.participation.visibility === "HIDDEN")
        return c.html(notFound(c), 404);
      const result = await act(access, form, deps.now());
      const fresh = async () =>
        (await findEventForParticipant(deps.storage, access.event.id, me.personId)) ?? access;
      switch (result.kind) {
        case "done":
          // The person may no longer be a party (e.g. a declined proposal they weren't
          // asked about): back to the event if they can still see it, else the group.
          return (await findEventForParticipant(deps.storage, access.event.id, me.personId)) ===
            null
            ? c.redirect(
                access.event.groupId === null ? "/groups" : `/groups/${access.event.groupId}`,
                303,
              )
            : c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
        case "forbidden":
          return c.html(page(c, "Not allowed", html`<h1>That isn't yours to do</h1>`), 403);
        case "invalid":
          return c.html(
            await eventPage(c, deps, await fresh(), me.csrfToken, "There's nothing to do here."),
            400,
          );
        case "closed":
          return c.html(
            await eventPage(
              c,
              deps,
              await fresh(),
              me.csrfToken,
              "This changed while you were looking — here it is as it stands now.",
            ),
            409,
          );
      }
    });

  lifecycle("answer", async (access, form, now) => {
    const answer = form.answer === "accept" || form.answer === "decline" ? form.answer : null;
    if (answer === null) return { kind: "invalid" };
    const result = await answerProposal(deps.storage, access, {
      answer,
      now,
      arrival: SIGNED_IN,
    });
    return result.kind === "recorded" ? { kind: "done", status: result.status } : result;
  });
  lifecycle("acknowledge", async (access, _form, now) => {
    const result = await acknowledge(deps.storage, access, { now, arrival: SIGNED_IN });
    if (result.kind === "recorded") return { kind: "done", status: access.event.status };
    return result.kind === "invalid" ? { kind: "invalid" } : result;
  });
  lifecycle("withdraw", (access, _form, now) => withdrawProposal(deps.storage, access, { now }));
  lifecycle("proposal", async (access, form, now) => {
    const decision =
      form.decision === "accept" || form.decision === "reject" ? form.decision : null;
    if (decision === null || typeof form.proposal !== "string") return { kind: "invalid" };
    const result = await decideProposal(deps.storage, access, {
      proposalId: form.proposal,
      decision,
      now,
    });
    switch (result.kind) {
      case "accepted":
      case "rejected":
        return { kind: "done", status: access.event.status };
      // The event moved on since it was proposed: the page, re-read, shows it as it is.
      case "superseded":
        return { kind: "closed" };
      default:
        return result;
    }
  });
  lifecycle("proposal/withdraw", async (access, form, now) => {
    if (typeof form.proposal !== "string") return { kind: "invalid" };
    const result = await withdrawChange(deps.storage, access, { proposalId: form.proposal, now });
    return result.kind === "withdrawn" ? { kind: "done", status: access.event.status } : result;
  });
  lifecycle("cancel", (access, _form, now) =>
    setCancelled(deps.storage, access, { cancelled: true, now }),
  );
  lifecycle("restore", (access, _form, now) =>
    setCancelled(deps.storage, access, { cancelled: false, now }),
  );
}
