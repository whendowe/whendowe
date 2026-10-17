// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Hono } from "hono";
import { Temporal } from "temporal-polyfill";
import { ZodError } from "zod";
import type { StoragePort } from "../../db/port.js";
import {
  type CanonicalEvent,
  createEvent,
  type EventAccess,
  type EventFieldsInput,
  editEvent,
  findEventForParticipant,
  listHistory,
  setCancelled,
  type TransitionResult,
  withdrawProposal,
} from "../../events/event.js";
import { canSee, canSeeField, listParticipants } from "../../events/participation.js";
import {
  type Answer,
  answerSchema,
  confirmCandidate,
  createPoll,
  MAX_CANDIDATES,
  PollInputError,
  type PollResults,
  pollResults,
  vote,
} from "../../events/poll.js";
import {
  type ChangeProposal,
  decideProposal,
  listProposals,
  proposeChange,
  withdrawChange,
} from "../../events/proposal.js";
import {
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
  revokeUndeliveredLink,
  setAttendance,
} from "../../events/response.js";
import { MailCapReachedError } from "../../mail/capped.js";
import type { MailPort } from "../../mail/port.js";
import { findGroupForMember, type GroupMembership, listMembers } from "../../people/group.js";
import {
  formatRRule,
  parseRRule,
  type RRuleSubset,
  upcomingOccurrences,
} from "../../recurrence.js";
import { type Html, html, renderPage } from "../layout.js";
import { type AppEnv, requireSignedIn, verifyFormCsrf } from "../session.js";
import { sendResponseLink } from "./respond.js";

// Event pages (MVP-2 slice 2B). Every read goes through findEventForParticipant (no
// IDOR), and every rendering goes through canSee / canSeeField — the single rule for
// what each visibility tier may see — INCLUDING the change history, where a diff of a
// hidden field would leak it (WORKFLOWS US-6).

export const EVENTS_PATH = "/events";

export interface EventRouteDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
  /** Always the capped port; response links go out through it. */
  readonly mail: MailPort;
  /** Links are built from this, never the Host header. */
  readonly publicBaseUrl: string;
}

export const BUSY_LABEL = "Busy";

function notFound(): string {
  return renderPage("Not found", html`<h1>Not found</h1><p><a href="/groups">Your groups</a></p>`);
}

function rejected(): string {
  return renderPage("Request rejected", html`<h1>Request rejected</h1><p>Please try again.</p>`);
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

/**
 * A poll is the one kind of proposal whose own time is a placeholder. Everyone in a
 * poll — its creator included — takes part as `slot_vote` (poll.ts), so the viewer's
 * own row says which kind this is without another query.
 */
function isPoll(access: EventAccess): boolean {
  return access.participation.responseKind === "slot_vote";
}

/** "(cancelled)", "(waiting for agreement)", … — empty for an ordinary scheduled event. */
function statusBadge(access: EventAccess): Html | string {
  const label: Record<string, string> = {
    cancelled: "cancelled",
    declined: "declined",
    withdrawn: "withdrawn",
    proposed: isPoll(access) ? "" : "waiting for agreement",
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
  // An open poll's own time is only a placeholder: never show it as "the" time.
  const when =
    isPoll(access) && event.status === "proposed" ? "voting on a time" : formatWhen(event);
  const repeats = event.rrule === null ? "" : ` · ↻ ${describeRRule(event.rrule)}`;
  return html`<a href="${EVENTS_PATH}/${event.id}">${title}</a>${statusBadge(access)} <span class="muted">· ${when}${repeats}</span>`;
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
): Html {
  return html`${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${action}">
  <input type="hidden" name="csrf" value="${csrf}" />
  ${extra}
  ${canSee(vis, "title") ? html`<p><label>Title<br /><input name="title" required maxlength="200" value="${v.title}" style="width:100%" /></label></p>` : ""}
  ${canSee(vis, "location") ? html`<p><label>Where<br /><input name="location" maxlength="500" value="${v.location}" style="width:100%" /></label></p>` : ""}
  <p><label><input type="checkbox" name="allDay" ${v.allDay ? html`checked` : ""} /> All day</label></p>
  <p><label>Starts<br /><input type="datetime-local" name="start" required value="${v.start}" /></label></p>
  <p><label>Ends <span class="muted">(for all-day events: the last day)</span><br /><input type="datetime-local" name="end" required value="${v.end}" /></label></p>
  <p><label>Time zone<br /><input id="tzid" name="tzid" list="zones" value="${v.tzid}" placeholder="Europe/Prague" /></label></p>
  ${zoneOptions()}
  ${repeatInputs(v)}
  ${canSee(vis, "description") ? html`<p><label>Notes <span class="muted">(only people who see full details see these)</span><br /><textarea name="description" rows="4" style="width:100%">${v.description}</textarea></label></p>` : ""}
  <p><button type="submit">${submit}</button></p>
</form>
<script>
  // Progressive enhancement only: suggest the browser's own zone for a new event.
  var tz = document.getElementById("tzid");
  if (tz && !tz.value) tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>`;
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
  (m) => html`<p><label>${m.displayName ?? m.email}
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

// --- Time polls (slice 2C) ----------------------------------------------------------

const ANSWER_LABEL: Record<Answer, string> = { yes: "Yes", ifneedbe: "If need be", no: "No" };

/**
 * Candidates with this person's answers as one form, tallies, and — for editors — a
 * confirm button per candidate. Names next to answers only for tiers that see the
 * participant list; everyone sees the counts.
 */
function pollSection(
  access: EventAccess,
  poll: PollResults,
  csrf: string,
  showNames: boolean,
): Html {
  const { event, participation } = access;
  const editor = participation.editTier === "edit";
  const rows = poll.candidates.map((c) => {
    const radios = answerSchema.options.map(
      (a) =>
        html`<label style="margin-right:.8em"><input type="radio" name="slot_${c.slotIndex}" value="${a}" ${c.mine === a ? html`checked` : ""} /> ${ANSWER_LABEL[a]}</label>`,
    );
    const names = showNames
      ? html`<br /><span class="muted">${c.voters.map((v) => `${v.displayName ?? v.email}: ${ANSWER_LABEL[v.answer]}`).join(" · ")}</span>`
      : "";
    const everyone = poll.everyoneYes.includes(c.slotIndex)
      ? html` <strong>· works for everyone</strong>`
      : "";
    return html`<li style="margin-bottom:.8em"><strong>${formatWhen(c)}</strong>${everyone}<br />
${radios}<br /><span class="muted">${c.yes} yes · ${c.ifNeedBe} if need be · ${c.no} no</span>${names}</li>`;
  });
  const confirms = editor
    ? html`<h3>Pick the time</h3><p class="muted">Confirming schedules the event at that time and closes voting.</p>
${poll.candidates.map(
  (
    c,
  ) => html`<form method="post" action="${EVENTS_PATH}/${event.id}/confirm" style="display:inline-block;margin:0 .5em .5em 0">
  <input type="hidden" name="csrf" value="${csrf}" />
  <input type="hidden" name="revision" value="${event.revision}" />
  <input type="hidden" name="slot" value="${c.slotIndex}" />
  <button type="submit">Confirm ${formatWhen(c)}</button>
</form>`,
)}`
    : "";
  return html`<p><strong>Voting on a time.</strong> ${poll.electorate} ${poll.electorate === 1 ? "person" : "people"} can answer.</p>
<form method="post" action="${EVENTS_PATH}/${event.id}/votes">
  <input type="hidden" name="csrf" value="${csrf}" />
  <ul style="list-style:none;padding-left:0">${rows}</ul>
  <p><button type="submit">Save my answers</button></p>
</form>
${confirms}`;
}

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
  const count = (a: Attendance) => responses.attendance.filter((r) => r.attendance === a).length;
  const label = (p: { displayName: string | null; email: string }) => p.displayName ?? p.email;
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
          ? html`<ul>${responses.attendance.map((r) => html`<li>${label(r)}: ${ATTENDANCE_LABEL[r.attendance]}</li>`)}</ul>`
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
  <p><button type="submit">${action === "attend" ? "Email everyone a link to say if they're coming" : isPoll(access) ? "Email everyone a link to vote" : "Email a link to agree or decline"}</button>
  <span class="muted">No account needed to answer.</span></p>
</form>`
      : "";
  return html`${scheduled ? html`<h2>Are you coming?</h2>${attendanceForm}${tally}` : ""}
<h2>Notes</h2>
${notes.length === 0 ? html`<p class="muted">No notes yet.</p>` : html`<ul>${notes.map((n) => html`<li><span class="muted">${n.at.slice(0, 16).replace("T", " ")}</span> · ${label(n)}: <span style="white-space:pre-wrap">${n.body}</span></li>`)}</ul>`}
${noteForm}
${sendLinks}`;
}

// --- Agreement & acknowledgment (slice 2E-1) -----------------------------------------

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
    organizer.push(
      button(
        event.id,
        "withdraw",
        csrf,
        isPoll(access) ? "Withdraw the poll" : "Withdraw the proposal",
      ),
    );
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
            html`<li>${r.displayName ?? r.email}: ${REQUEST_LABEL[r.kind]} — ${STATE_LABEL[r.state] ?? r.state}${
              r.at === null
                ? ""
                : html` <span class="muted">${r.at.slice(0, 16).replace("T", " ")}</span>`
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

function pollForm(action: string, csrf: string, v: PollFormValues, error: string | null): Html {
  const shown = Math.max(POLL_ROWS, v.slots.filter((s) => s.start !== "" || s.end !== "").length);
  const slots = Array.from(
    { length: Math.min(shown, MAX_CANDIDATES) },
    (_, i) => v.slots[i] ?? { start: "", end: "" },
  );
  return html`${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${action}">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><label>What<br /><input name="title" required maxlength="200" value="${v.title}" style="width:100%" /></label></p>
  <p><label>Where<br /><input name="location" maxlength="500" value="${v.location}" style="width:100%" /></label></p>
  <p><label><input type="checkbox" name="allDay" ${v.allDay ? html`checked` : ""} /> All-day options</label></p>
  <p><label>Time zone<br /><input id="tzid" name="tzid" list="zones" value="${v.tzid}" placeholder="Europe/Prague" /></label></p>
  ${zoneOptions()}
  <h2>Options</h2>
  <p class="muted">Offer at least two. Leave the rows you don't need empty. For all-day options, "ends" is the last day.</p>
  ${slots.map(
    (
      slot,
      i,
    ) => html`<p><label>Starts <input type="datetime-local" name="start_${i}" value="${slot.start}" /></label>
  <label>Ends <input type="datetime-local" name="end_${i}" value="${slot.end}" /></label></p>`,
  )}
  <p><label>Notes <span class="muted">(only people who see full details see these)</span><br /><textarea name="description" rows="3" style="width:100%">${v.description}</textarea></label></p>
  <p><button type="submit">Start the poll</button></p>
</form>
<script>
  var tz = document.getElementById("tzid");
  if (tz && !tz.value) tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>`;
}

/** Poll form → domain input: shared fields once, a time pair per filled row. */
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
    (p) => html`<li><strong>${p.proposerName ?? p.proposerEmail}</strong> proposes:
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
        status === "superseded" || mine.decidedByEmail === null ? "" : ` by ${mine.decidedByEmail}`;
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

async function eventPage(
  deps: EventRouteDeps,
  access: EventAccess,
  csrf: string,
  notice: string | null = null,
): Promise<string> {
  const { event, participation } = access;
  const vis = participation.visibility;
  const see = (part: Parameters<typeof canSee>[1]) => canSee(vis, part);
  const voting = event.status === "proposed" && isPoll(access);
  const poll = voting ? await pollResults(deps.storage, access) : null;

  const people = see("participants") ? await listParticipants(deps.storage, event.id) : [];
  const history = (await listHistory(deps.storage, access))
    .map((entry) => ({
      ...entry,
      // The integrity rule applied to history: drop every field this tier can't see.
      fields: Object.entries(entry.change).filter(([field]) => canSeeField(vis, field)),
    }))
    .filter((entry) => entry.fields.length > 0);

  return renderPage(
    see("title") ? event.title : BUSY_LABEL,
    html`<p>${event.groupId === null ? html`<a href="/groups">← Your groups</a>` : html`<a href="/groups/${event.groupId}">← Back to the group</a>`}</p>
<h1>${see("title") ? event.title : BUSY_LABEL}${statusBadge(access)}</h1>
${notice === null ? "" : html`<p class="error">${notice}</p>`}
${poll === null ? html`<p>${formatWhen(event)}</p>` : pollSection(access, poll, csrf, see("participants"))}
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
${
  people.length === 0
    ? ""
    : html`<h2>Taking part</h2><ul>${people.map(
        (p) =>
          html`<li>${p.displayName ?? p.email}${p.editTier === "edit" ? html` <span class="muted">· can edit</span>` : ""}</li>`,
      )}</ul>`
}
${await responsesSection(deps, access, csrf)}
<h2>History</h2>
<ul>${history.map(
      (h) =>
        html`<li><span class="muted">${h.at.slice(0, 16).replace("T", " ")}</span> · ${h.actorEmail ?? "someone"} ${
          h.revision === 1
            ? "created it"
            : h.proposedByEmail === null
              ? "changed"
              : `accepted ${h.proposedByEmail}'s proposal`
        }${
          h.revision === 1
            ? ""
            : html`<ul>${h.fields.map(([field, c]) => html`<li>${field}: ${renderHistoryValue(field, c.before)} → ${renderHistoryValue(field, c.after)}</li>`)}</ul>`
        }</li>`,
    )}</ul>`,
  );
}

export function registerEventRoutes(app: Hono<AppEnv>, deps: EventRouteDeps): void {
  app.get("/groups/:groupId/events/new", async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const membership = await findGroupForMember(deps.storage, c.req.param("groupId"), me.personId);
    if (membership === null) return c.html(notFound(), 404);
    return c.html(
      renderPage(
        "New event",
        html`<p><a href="/groups/${membership.group.id}">← ${membership.group.name}</a></p>
<h1>New event for ${membership.group.name}</h1>
${eventForm(`/groups/${membership.group.id}/events`, me.csrfToken, EMPTY, await requestsFieldset(deps, membership, me.personId, new Map()), null, "Create event")}`,
      ),
    );
  });

  app.post("/groups/:groupId/events", async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return c.html(rejected(), 403);
    const membership = await findGroupForMember(deps.storage, c.req.param("groupId"), me.personId);
    if (membership === null) return c.html(notFound(), 404);
    const values = readForm(form);
    const requests = readRequests(form);
    try {
      const event = await createEvent(deps.storage, {
        creatorId: me.personId,
        group: membership,
        fields: toFields(values),
        now: deps.now(),
        requests,
      });
      return c.redirect(`${EVENTS_PATH}/${event.id}`, 303);
    } catch (error) {
      return c.html(
        renderPage(
          "New event",
          html`<h1>New event for ${membership.group.name}</h1>
${eventForm(`/groups/${membership.group.id}/events`, me.csrfToken, values, await requestsFieldset(deps, membership, me.personId, requests), errorMessage(error), "Create event")}`,
        ),
        400,
      );
    }
  });

  app.get(`${EVENTS_PATH}/:id`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    // HIDDEN means "no projection at all" (WORKFLOWS §3): indistinguishable from absent.
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(), 404);
    return c.html(await eventPage(deps, access, me.csrfToken));
  });

  app.get(`${EVENTS_PATH}/:id/edit`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(), 404);
    const proposing = access.participation.editTier === "propose";
    if (access.participation.editTier === "view")
      return c.html(renderPage("Not allowed", html`<h1>You can't edit this event</h1>`), 403);
    if (proposing && access.event.status !== "scheduled")
      return c.html(
        renderPage(
          "Not now",
          html`<h1>Changes can't be proposed right now</h1><p>Only a scheduled event takes proposals. <a href="${EVENTS_PATH}/${access.event.id}">Back to the event</a></p>`,
        ),
        409,
      );
    if (access.event.status === "proposed")
      return c.html(
        renderPage(
          "Voting open",
          html`<h1>Voting is still open</h1><p>Its time is chosen by confirming one of the options. <a href="${EVENTS_PATH}/${access.event.id}">Back to the poll</a></p>`,
        ),
        409,
      );
    const { event } = access;
    const vis = access.participation.visibility;
    return c.html(
      renderPage(
        canSee(vis, "title") ? `Edit ${event.title}` : "Edit",
        html`<p><a href="${EVENTS_PATH}/${event.id}">← ${canSee(vis, "title") ? event.title : BUSY_LABEL}</a></p>
${editHeading(proposing)}
${eventForm(`${EVENTS_PATH}/${event.id}`, me.csrfToken, valuesFrom(event), html`<input type="hidden" name="revision" value="${event.revision}" />`, null, proposing ? "Send proposal" : "Save", vis)}`,
      ),
    );
  });

  app.post(`${EVENTS_PATH}/:id`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return c.html(rejected(), 403);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(), 404);

    const seen = Number.parseInt(str(form, "revision"), 10);
    const values = readForm(form);
    const proposing = access.participation.editTier === "propose";
    const vis = access.participation.visibility;
    const editForm = (error: string, v: FormValues, revision: number) =>
      renderPage(
        canSee(vis, "title") ? `Edit ${access.event.title}` : "Edit",
        html`${editHeading(proposing)}
${eventForm(`${EVENTS_PATH}/${access.event.id}`, me.csrfToken, v, html`<input type="hidden" name="revision" value="${revision}" />`, error, proposing ? "Send proposal" : "Save", vis)}`,
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
        return c.html(renderPage("Not allowed", html`<h1>You can't edit this event</h1>`), 403);
      case "closed":
        return c.html(
          await eventPage(deps, access, me.csrfToken, "Only a scheduled event takes proposals."),
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

  app.get("/groups/:groupId/polls/new", async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const membership = await findGroupForMember(deps.storage, c.req.param("groupId"), me.personId);
    if (membership === null) return c.html(notFound(), 404);
    return c.html(
      renderPage(
        "Find a time",
        html`<p><a href="/groups/${membership.group.id}">← ${membership.group.name}</a></p>
<h1>Find a time with ${membership.group.name}</h1>
${pollForm(`/groups/${membership.group.id}/polls`, me.csrfToken, { ...EMPTY, slots: [] }, null)}`,
      ),
    );
  });

  app.post("/groups/:groupId/polls", async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return c.html(rejected(), 403);
    const membership = await findGroupForMember(deps.storage, c.req.param("groupId"), me.personId);
    if (membership === null) return c.html(notFound(), 404);
    const values = readPollForm(form);
    try {
      const input = toPollInput(values);
      const event = await createPoll(deps.storage, {
        creatorId: me.personId,
        group: membership,
        fields: input.fields,
        candidates: input.candidates,
        now: deps.now(),
      });
      return c.redirect(`${EVENTS_PATH}/${event.id}`, 303);
    } catch (error) {
      return c.html(
        renderPage(
          "Find a time",
          html`<h1>Find a time with ${membership.group.name}</h1>
${pollForm(`/groups/${membership.group.id}/polls`, me.csrfToken, values, errorMessage(error))}`,
        ),
        400,
      );
    }
  });

  app.post(`${EVENTS_PATH}/:id/votes`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return c.html(rejected(), 403);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(), 404);

    const answers = new Map<number, Answer>();
    for (const [key, value] of Object.entries(form)) {
      const slot = /^slot_(\d{1,2})$/.exec(key)?.[1];
      const answer = answerSchema.safeParse(value);
      if (slot !== undefined && answer.success) answers.set(Number.parseInt(slot, 10), answer.data);
    }
    const result = await vote(deps.storage, access, { answers, now: deps.now() });
    switch (result.kind) {
      case "recorded":
        return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
      case "invalid":
        return c.html(
          await eventPage(
            deps,
            access,
            me.csrfToken,
            "Pick an answer for at least one of the options.",
          ),
          400,
        );
      case "closed": {
        const fresh =
          (await findEventForParticipant(deps.storage, access.event.id, me.personId)) ?? access;
        return c.html(
          await eventPage(
            deps,
            fresh,
            me.csrfToken,
            "Voting has closed — a time was already picked.",
          ),
          409,
        );
      }
      case "forbidden":
        return c.html(notFound(), 404);
    }
  });

  app.post(`${EVENTS_PATH}/:id/confirm`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return c.html(rejected(), 403);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(), 404);
    const seen = Number.parseInt(str(form, "revision"), 10);
    const slot = Number.parseInt(str(form, "slot"), 10);
    const result = await confirmCandidate(deps.storage, access, {
      slotIndex: Number.isInteger(slot) ? slot : -1,
      // The revision the editor SAW: if the poll changed since, they decide again.
      expectedRevision: Number.isInteger(seen) ? seen : -1,
      actorId: me.personId,
      now: deps.now(),
    });
    const fresh = async () =>
      (await findEventForParticipant(deps.storage, access.event.id, me.personId)) ?? access;
    switch (result.kind) {
      case "confirmed":
        return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
      case "forbidden":
        return c.html(
          renderPage("Not allowed", html`<h1>Only the organizers can pick the time</h1>`),
          403,
        );
      case "invalid":
        return c.html(
          await eventPage(deps, access, me.csrfToken, "That option doesn't exist."),
          400,
        );
      case "closed":
      case "conflict":
        return c.html(
          await eventPage(
            deps,
            await fresh(),
            me.csrfToken,
            "The poll changed while you were looking — here it is as it stands now.",
          ),
          409,
        );
    }
  });

  app.post(`${EVENTS_PATH}/:id/attendance`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return c.html(rejected(), 403);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(), 404);
    const attendance = attendanceSchema.safeParse(form.attendance);
    if (!attendance.success)
      return c.html(await eventPage(deps, access, me.csrfToken, "Pick one of the answers."), 400);
    const result = await setAttendance(deps.storage, access, {
      attendance: attendance.data,
      now: deps.now(),
    });
    if (result.kind !== "recorded")
      return c.html(
        await eventPage(deps, access, me.csrfToken, "This event isn't taking answers."),
        409,
      );
    return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
  });

  app.post(`${EVENTS_PATH}/:id/feedback`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return c.html(rejected(), 403);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(), 404);
    const result = await addFeedback(deps.storage, access, {
      body: str(form, "note"),
      now: deps.now(),
    });
    switch (result.kind) {
      case "recorded":
        return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
      case "invalid":
        return c.html(await eventPage(deps, access, me.csrfToken, result.reason), 400);
      case "closed":
      case "forbidden":
        return c.html(
          await eventPage(deps, access, me.csrfToken, "This event isn't taking notes."),
          409,
        );
    }
  });

  app.post(`${EVENTS_PATH}/:id/links`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return c.html(rejected(), 403);
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(), 404);
    const issued = await issueResponseLinks(deps.storage, access, { now: deps.now() });
    if (issued.kind === "forbidden")
      return c.html(
        renderPage("Not allowed", html`<h1>Only the organizers can send these</h1>`),
        403,
      );
    if (issued.kind === "closed")
      return c.html(
        await eventPage(deps, access, me.csrfToken, "This event has nothing to ask right now."),
        409,
      );

    let sent = 0;
    let failed = 0;
    let capped = false;
    for (const link of issued.links) {
      if (capped) {
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
          from: me.email,
          publicBaseUrl: deps.publicBaseUrl,
        });
        sent += 1;
      } catch (error) {
        await revokeUndeliveredLink(deps.storage, link);
        failed += 1;
        if (error instanceof MailCapReachedError) capped = true;
      }
    }
    const parts = [
      `Sent to ${sent} ${sent === 1 ? "person" : "people"}.`,
      issued.throttled > 0 ? `${issued.throttled} already got a link in the last hour.` : "",
      failed > 0 ? `Couldn't send to ${failed} — please try again later.` : "",
    ].filter((p) => p !== "");
    return c.html(
      await eventPage(deps, access, me.csrfToken, parts.join(" ")),
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
      if (!(await verifyFormCsrf(me, form))) return c.html(rejected(), 403);
      const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
      if (access === null || access.participation.visibility === "HIDDEN")
        return c.html(notFound(), 404);
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
          return c.html(renderPage("Not allowed", html`<h1>That isn't yours to do</h1>`), 403);
        case "invalid":
          return c.html(
            await eventPage(deps, await fresh(), me.csrfToken, "There's nothing to do here."),
            400,
          );
        case "closed":
          return c.html(
            await eventPage(
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
    const result = await answerProposal(deps.storage, access, { answer, now });
    return result.kind === "recorded" ? { kind: "done", status: result.status } : result;
  });
  lifecycle("acknowledge", async (access, _form, now) => {
    const result = await acknowledge(deps.storage, access, { now });
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
