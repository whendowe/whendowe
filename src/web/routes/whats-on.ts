// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { Temporal } from "temporal-polyfill";
import type { StoragePort } from "../../db/port.js";
import { followedEvent, type OnEvent, WHATS_ON_DAYS, whatsOn } from "../../following/whats-on.js";
import { uuidv7 } from "../../ids.js";
import { type AskBody, saveAskDraft, startAskDraft } from "../../plans/ask.js";
import { type Html, html } from "../layout.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  requireSignedIn,
  type SignedIn,
  verifyFormCsrf,
} from "../session.js";
import { ASK_PATH } from "./ask.js";
import { FOLLOW_STYLE, FOLLOWING_PATH } from "./following.js";

// What's on when you're free (DESIGN §10 rc58): the next two weeks of what you and your groups
// follow, by day, at whatever time it is. What overlaps anything of yours is left out, and
// "Show what clashes" — a link, so it works without JavaScript — shows it dimmed. A followed
// event's sheet is a page of its own, shown only to someone who follows its calendar; Invite
// people starts an Ask (rc46) with its time as the one option. GETs write nothing.

export const WHATS_ON_PATH = "/whats-on";

export interface WhatsOnDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
}

/** A followed event's sheet: its calendar in the path, its UID (which may hold "/") in `e`. */
export function sheetPath(e: Pick<OnEvent, "calendarId" | "uid">): string {
  return `${WHATS_ON_PATH}/${encodeURIComponent(e.calendarId)}?e=${encodeURIComponent(e.uid)}`;
}

const DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const dayText = (d: string) => DAY.format(new Date(`${d}T00:00:00Z`));

/** "Today", "Tomorrow", else "Thursday 26 November": today as the calendar's own zone has it. */
function dayHeading(day: string, zone: string | null, now: string): string {
  const today = Temporal.Instant.from(now)
    .toZonedDateTimeISO(zone ?? "UTC")
    .toPlainDate();
  if (day === today.toString()) return `Today · ${dayText(day)}`;
  if (day === today.add({ days: 1 }).toString()) return `Tomorrow · ${dayText(day)}`;
  return dayText(day);
}

/** "19:00–23:00", "20:00 – Sat 01:00", "All day", or "All day, to Sunday 29 November". */
function timeText(e: OnEvent): string {
  if (e.allDay) {
    const first = Temporal.PlainDate.from(e.startLocal);
    const last = Temporal.PlainDate.from(e.endLocal).subtract({ days: 1 });
    return Temporal.PlainDate.compare(last, first) > 0
      ? `All day, to ${dayText(last.toString())}`
      : "All day";
  }
  const from = e.startLocal.slice(11, 16);
  const to = e.endLocal.slice(11, 16);
  if (e.endLocal.slice(0, 10) === e.startLocal.slice(0, 10))
    return from === to ? from : `${from}–${to}`;
  return `${from} – ${WEEKDAY.format(new Date(`${e.endLocal.slice(0, 10)}T00:00:00Z`))} ${to}`;
}

/**
 * A feed's link, as a link (rc58). The reader keeps only http: and https: ones (read.ts); an
 * href from a feed is checked again here, as it is the one place its text becomes markup.
 */
function feedLink(url: string | null): Html | string {
  if (url === null || !/^https?:\/\//i.test(url)) return "";
  return html`<p><a href="${url}" rel="noreferrer noopener">${url}</a></p>`;
}

const STYLE = html`<style>
  .on { list-style: none; padding: 0; display: grid; gap: .5rem; }
  .on > li { border-left: 4px solid var(--fc); padding: .2rem 0 .2rem .75rem; }
  .on > li.clash { opacity: .6; }
  .on .when { font-variant-numeric: tabular-nums; margin-right: .5rem; }
  .on h2, .day { font-size: 1.05rem; margin: 1.25rem 0 .5rem; }
  .sheet { border-left: 4px solid var(--fc); padding-left: .75rem; }
  .sheet .description { white-space: pre-line; }
</style>`;

function item(e: OnEvent): Html {
  return html`<li class="fc-${e.colour}${e.clashes ? " clash" : ""}" data-start="${e.startUtc ?? ""}" data-end="${e.endUtc ?? ""}">
<span class="when">${timeText(e)}</span><a href="${sheetPath(e)}"><strong>${e.title}</strong></a>${
    e.location === null ? "" : html` <span class="muted">· ${e.location}</span>`
  }<br /><span class="muted"><span class="fc-dot" aria-hidden="true"></span>${e.calendarName}</span>${
    e.clashes ? html` <span class="muted">· You have something then</span>` : ""
  }</li>`;
}

async function whatsOnPage(deps: WhatsOnDeps, me: SignedIn, showClashes: boolean): Promise<Html> {
  const now = deps.now();
  const all = await whatsOn(deps.storage, me.personId, now);
  const shown = showClashes ? all : all.filter((e) => !e.clashes);
  const hidden = all.length - shown.length;
  const days = new Map<string, OnEvent[]>();
  for (const e of shown) {
    const day = e.startLocal.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  const toggle = showClashes
    ? html`<a href="${WHATS_ON_PATH}">Hide what clashes</a>`
    : hidden === 0
      ? ""
      : html`<a href="${WHATS_ON_PATH}?clashes=1">Show what clashes</a> <span class="muted">(${
          hidden === 1 ? "1 event overlaps" : `${hidden} events overlap`
        } something of yours)</span>`;
  const body =
    all.length === 0
      ? html`<p class="muted">Nothing on in the next ${WHATS_ON_DAYS} days from the calendars you follow.</p>`
      : shown.length === 0
        ? html`<p class="muted">Nothing on when you're free in the next ${WHATS_ON_DAYS} days.</p>`
        : html`${[...days].map(
            ([day, events]) =>
              html`<h2 class="day">${dayHeading(day, events[0]?.tzid ?? null, now)}</h2><ul class="on">${events.map(item)}</ul>`,
          )}`;
  return html`${FOLLOW_STYLE}${STYLE}<h1>What's on</h1>
<p class="muted">The next ${WHATS_ON_DAYS} days from the calendars you and your groups follow, when you're free: what overlaps something of yours is left out. <a href="${FOLLOWING_PATH}">Calendars you follow</a></p>
${toggle === "" ? "" : html`<p>${toggle}</p>`}
${body}`;
}

function sheetPage(e: OnEvent & { readonly cancelled: boolean }, me: SignedIn): Html {
  const day = dayText(e.startLocal.slice(0, 10));
  return html`${FOLLOW_STYLE}${STYLE}<div class="sheet fc-${e.colour}">
<h1>${e.title}</h1>
${e.cancelled ? html`<p class="error">Cancelled.</p>` : ""}
<p>${day} · ${timeText(e)}${e.tzid === null ? "" : html` <span class="muted">${e.tzid}</span>`}</p>
${e.location === null ? "" : html`<p>${e.location}</p>`}
${e.description === null ? "" : html`<p class="description">${e.description}</p>`}
${feedLink(e.url)}
<p class="muted"><span class="fc-dot" aria-hidden="true"></span>From ${e.calendarName}. It isn't an event of yours: nobody is asked anything about it.</p>
${e.clashes ? html`<p class="muted">You have something then.</p>` : ""}
</div>
${
  e.cancelled
    ? ""
    : html`<form method="post" action="${WHATS_ON_PATH}/${encodeURIComponent(e.calendarId)}/invite">
  <input type="hidden" name="csrf" value="${me.csrfToken}" />
  <input type="hidden" name="e" value="${e.uid}" />
  <p><button type="submit">Invite people</button> <span class="muted">Ask who's coming, with this time as the one option.</span></p>
</form>`
}
<p><a href="${WHATS_ON_PATH}">What's on</a></p>`;
}

/** The Ask a followed event starts (rc58): its time the one option; title, place and link. */
export function inviteBody(e: OnEvent): AskBody {
  const event = e.allDay
    ? {
        allDay: true,
        startLocal: e.startLocal.slice(0, 10),
        endLocal: e.endLocal.slice(0, 10),
      }
    : { allDay: false, startLocal: e.startLocal.slice(0, 16), endLocal: e.endLocal.slice(0, 16) };
  return {
    title: e.title.slice(0, 200),
    location: e.location?.slice(0, 200) ?? null,
    note: e.url?.slice(0, 2000) ?? null,
    tzid: e.tzid,
    options: [[{ ...event, sid: uuidv7() }]],
    emails: [],
  };
}

export function registerWhatsOnRoutes(app: Hono<AppEnv>, deps: WhatsOnDeps): void {
  const notFound = (c: Context<AppEnv>) =>
    c.html(
      page(
        c,
        "Not found",
        html`<h1>Not found</h1><p>That isn't an event from a calendar you follow.</p><p><a href="${WHATS_ON_PATH}">What's on</a></p>`,
      ),
      404,
    );

  app.get(WHATS_ON_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    c.header("Cache-Control", "private, no-store");
    const clashes = c.req.query("clashes") === "1";
    return c.html(page(c, "What's on", await whatsOnPage(deps, me, clashes)));
  });

  app.get(`${WHATS_ON_PATH}/:calendar`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    c.header("Cache-Control", "private, no-store");
    const uid = c.req.query("e") ?? "";
    const e = await followedEvent(
      deps.storage,
      me.personId,
      c.req.param("calendar"),
      uid,
      deps.now(),
    );
    if (e === null) return notFound(c);
    return c.html(page(c, e.title, sheetPage(e, me)));
  });

  // Starting an Ask writes a draft, so it is a POST (§13: GET never mutates).
  app.post(`${WHATS_ON_PATH}/:calendar/invite`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const uid = typeof form.e === "string" ? form.e : "";
    const e = await followedEvent(
      deps.storage,
      me.personId,
      c.req.param("calendar"),
      uid,
      deps.now(),
    );
    if (e === null || e.cancelled) return notFound(c);
    const draft = await startAskDraft(deps.storage, {
      authorId: me.personId,
      groupId: null,
      now: deps.now(),
    });
    if (draft === null) return notFound(c);
    await saveAskDraft(deps.storage, {
      id: draft.id,
      authorId: me.personId,
      body: inviteBody(e),
      now: deps.now(),
    });
    return c.redirect(`${ASK_PATH}/${draft.id}`, 303);
  });
}
