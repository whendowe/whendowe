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
import { findGroupForMember } from "../../people/group.js";
import { type Html, html, renderPage } from "../layout.js";
import { type AppEnv, requireSignedIn, verifyFormCsrf } from "../session.js";

// Event pages (MVP-2 slice 2B). Every read goes through findEventForParticipant (no
// IDOR), and every rendering goes through canSee / canSeeField — the single rule for
// what each visibility tier may see — INCLUDING the change history, where a diff of a
// hidden field would leak it (WORKFLOWS US-6).

export const EVENTS_PATH = "/events";

export interface EventRouteDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
}

const BUSY_LABEL = "Busy";

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
  return html`<a href="${EVENTS_PATH}/${event.id}">${title}</a>${cancelled} <span class="muted">· ${formatWhen(event)}</span>`;
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

function renderHistoryValue(v: string | number | null): string {
  return v === null ? "—" : String(v);
}

async function eventPage(deps: EventRouteDeps, access: EventAccess): Promise<string> {
  const { event, participation } = access;
  const vis = participation.visibility;
  const see = (part: Parameters<typeof canSee>[1]) => canSee(vis, part);

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
<p>${formatWhen(event)}</p>
${see("location") && event.location !== null ? html`<p>📍 ${event.location}</p>` : ""}
${see("description") && event.description !== null ? html`<p style="white-space:pre-wrap">${event.description}</p>` : ""}
${participation.editTier === "edit" ? html`<p><a href="${EVENTS_PATH}/${event.id}/edit">Edit</a></p>` : ""}
${
  people.length === 0
    ? ""
    : html`<h2>Taking part</h2><ul>${people.map(
        (p) =>
          html`<li>${p.displayName ?? p.email}${p.editTier === "edit" ? html` <span class="muted">· can edit</span>` : ""}</li>`,
      )}</ul>`
}
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
    return c.html(await eventPage(deps, access));
  });

  app.get(`${EVENTS_PATH}/:id/edit`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await findEventForParticipant(deps.storage, c.req.param("id"), me.personId);
    if (access === null || access.participation.visibility === "HIDDEN")
      return c.html(notFound(), 404);
    if (access.participation.editTier !== "edit")
      return c.html(renderPage("Not allowed", html`<h1>You can't edit this event</h1>`), 403);
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
}
