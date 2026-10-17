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
  type Attendance,
  actionFor,
  addFeedback,
  attendanceSchema,
  issueResponseLinks,
  listResponses,
  revokeUndeliveredLink,
  setAttendance,
} from "../../events/response.js";
import { MailCapReachedError } from "../../mail/capped.js";
import type { MailPort } from "../../mail/port.js";
import { findGroupForMember } from "../../people/group.js";
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

/** One line for a list, at the viewer's tier. */
export function eventSummary(access: EventAccess): Html {
  const { event, participation } = access;
  const title = canSee(participation.visibility, "title") ? event.title : BUSY_LABEL;
  const cancelled =
    event.status === "cancelled" ? html` <span class="muted">(cancelled)</span>` : "";
  // An open poll's own time is only a placeholder: never show it as "the" time.
  const when = event.status === "proposed" ? "voting on a time" : formatWhen(event);
  return html`<a href="${EVENTS_PATH}/${event.id}">${title}</a>${cancelled} <span class="muted">· ${when}</span>`;
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
  };
}

/** Form values → domain input. All-day: date parts, end made EXCLUSIVE (+1 day). */
function toFields(v: FormValues): EventFieldsInput {
  const text = (s: string) => (s.trim() === "" ? null : s);
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

function eventForm(
  action: string,
  csrf: string,
  v: FormValues,
  extra: Html | string,
  error: string | null,
  submit: string,
): Html {
  return html`${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${action}">
  <input type="hidden" name="csrf" value="${csrf}" />
  ${extra}
  <p><label>Title<br /><input name="title" required maxlength="200" value="${v.title}" style="width:100%" /></label></p>
  <p><label>Where<br /><input name="location" maxlength="500" value="${v.location}" style="width:100%" /></label></p>
  <p><label><input type="checkbox" name="allDay" ${v.allDay ? html`checked` : ""} /> All day</label></p>
  <p><label>Starts<br /><input type="datetime-local" name="start" required value="${v.start}" /></label></p>
  <p><label>Ends <span class="muted">(for all-day events: the last day)</span><br /><input type="datetime-local" name="end" required value="${v.end}" /></label></p>
  <p><label>Time zone<br /><input id="tzid" name="tzid" list="zones" value="${v.tzid}" placeholder="Europe/Prague" /></label></p>
  ${zoneOptions()}
  <p><label>Notes <span class="muted">(only people who see full details see these)</span><br /><textarea name="description" rows="4" style="width:100%">${v.description}</textarea></label></p>
  <p><button type="submit">${submit}</button></p>
</form>
<script>
  // Progressive enhancement only: suggest the browser's own zone for a new event.
  var tz = document.getElementById("tzid");
  if (tz && !tz.value) tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>`;
}

const EMPTY: FormValues = {
  title: "",
  description: "",
  location: "",
  allDay: false,
  start: "",
  end: "",
  tzid: "",
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
  <p><button type="submit">${action === "vote" ? "Email everyone a link to vote" : "Email everyone a link to say if they're coming"}</button>
  <span class="muted">No account needed to answer.</span></p>
</form>`
      : "";
  return html`${scheduled ? html`<h2>Are you coming?</h2>${attendanceForm}${tally}` : ""}
<h2>Notes</h2>
${notes.length === 0 ? html`<p class="muted">No notes yet.</p>` : html`<ul>${notes.map((n) => html`<li><span class="muted">${n.at.slice(0, 16).replace("T", " ")}</span> · ${label(n)}: <span style="white-space:pre-wrap">${n.body}</span></li>`)}</ul>`}
${noteForm}
${sendLinks}`;
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

function renderHistoryValue(v: string | number | null): string {
  return v === null ? "—" : String(v);
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
  const voting = event.status === "proposed";
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
<h1>${see("title") ? event.title : BUSY_LABEL}${event.status === "cancelled" ? html` <span class="muted">(cancelled)</span>` : ""}</h1>
${notice === null ? "" : html`<p class="error">${notice}</p>`}
${poll === null ? html`<p>${formatWhen(event)}</p>` : pollSection(access, poll, csrf, see("participants"))}
${see("location") && event.location !== null ? html`<p>📍 ${event.location}</p>` : ""}
${see("description") && event.description !== null ? html`<p style="white-space:pre-wrap">${event.description}</p>` : ""}
${participation.editTier === "edit" && !voting ? html`<p><a href="${EVENTS_PATH}/${event.id}/edit">Edit</a></p>` : ""}
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
        html`<li><span class="muted">${h.at.slice(0, 16).replace("T", " ")}</span> · ${h.actorEmail ?? "someone"} ${h.revision === 1 ? "created it" : "changed"}${
          h.revision === 1
            ? ""
            : html`<ul>${h.fields.map(([field, c]) => html`<li>${field}: ${renderHistoryValue(c.before)} → ${renderHistoryValue(c.after)}</li>`)}</ul>`
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
${eventForm(`/groups/${membership.group.id}/events`, me.csrfToken, EMPTY, "", null, "Create event")}`,
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
    try {
      const event = await createEvent(deps.storage, {
        creatorId: me.personId,
        group: membership,
        fields: toFields(values),
        now: deps.now(),
      });
      return c.redirect(`${EVENTS_PATH}/${event.id}`, 303);
    } catch (error) {
      return c.html(
        renderPage(
          "New event",
          html`<h1>New event for ${membership.group.name}</h1>
${eventForm(`/groups/${membership.group.id}/events`, me.csrfToken, values, "", errorMessage(error), "Create event")}`,
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
    if (access.participation.editTier !== "edit")
      return c.html(renderPage("Not allowed", html`<h1>You can't edit this event</h1>`), 403);
    if (access.event.status === "proposed")
      return c.html(
        renderPage(
          "Voting open",
          html`<h1>Voting is still open</h1><p>Its time is chosen by confirming one of the options. <a href="${EVENTS_PATH}/${access.event.id}">Back to the poll</a></p>`,
        ),
        409,
      );
    const { event } = access;
    return c.html(
      renderPage(
        `Edit ${event.title}`,
        html`<p><a href="${EVENTS_PATH}/${event.id}">← ${event.title}</a></p>
<h1>Edit event</h1>
${eventForm(`${EVENTS_PATH}/${event.id}`, me.csrfToken, valuesFrom(event), html`<input type="hidden" name="revision" value="${event.revision}" />`, null, "Save")}`,
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
    const editForm = (error: string, v: FormValues, revision: number) =>
      renderPage(
        `Edit ${access.event.title}`,
        html`<h1>Edit event</h1>
${eventForm(`${EVENTS_PATH}/${access.event.id}`, me.csrfToken, v, html`<input type="hidden" name="revision" value="${revision}" />`, error, "Save")}`,
      );

    let result: Awaited<ReturnType<typeof editEvent>>;
    try {
      result = await editEvent(deps.storage, access, {
        fields: toFields(values),
        actorId: me.personId,
        now: deps.now(),
        // The revision the person SAW, from the form — not the one re-read just now.
        expectedRevision: Number.isInteger(seen) ? seen : -1,
      });
    } catch (error) {
      return c.html(editForm(errorMessage(error), values, seen), 400);
    }
    switch (result.kind) {
      case "updated":
      case "unchanged":
        return c.redirect(`${EVENTS_PATH}/${access.event.id}`, 303);
      case "forbidden":
        return c.html(renderPage("Not allowed", html`<h1>You can't edit this event</h1>`), 403);
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
}
