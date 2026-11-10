// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import type { TokenCipher } from "../../crypto/tokens.js";
import type { StoragePort } from "../../db/port.js";
import { busyQuerySchema, ownBusy } from "../../feeds/busy.js";
import {
  type FeedScope,
  feedEntries,
  issueFeedLink,
  listSharedLinks,
  makeSharedLink,
  type ResolvedSharedLink,
  replaceSharedLink,
  resolveFeed,
  resolveSharedLink,
  type SharedLink,
  sharedEntries,
  sharedLabelSchema,
  sharedTierSchema,
  shownFeedLink,
  shownSharedLinks,
  stopSharedLink,
} from "../../feeds/feed.js";
import { BUSY_SUMMARY, type FeedEntry, serializeFeed } from "../../feeds/ics.js";
import { findGroupForMember, type GroupMembership, listMembers } from "../../people/group.js";
import { hashToken } from "../../people/tokens.js";
import { whenText } from "../../plans/weeks.js";
import {
  ACCOUNT_PATH,
  BUSY_PATH,
  EVENTS_PATH,
  GROUPS_PATH,
  type Html,
  html,
  renderPage,
  SHARE_BUTTONS,
  shareBox,
} from "../layout.js";
import { PLAN_STYLE } from "../plan-editor.js";
import { type AppEnv, rejectedPage, requireSignedIn, verifyFormCsrf } from "../session.js";

// A calendar feed by its secret link (DESIGN §10 rc34): GET /feed/<token>.ics. A
// calendar app can't sign in, so the link is the key. It renders the feed from the
// database every time, with an ETag over the body: an unchanged feed answers 304.
// It never creates a session, never signs anyone in, and writes nothing — not even
// when it was last fetched. The token is in the path, which nothing here logs.

export const FEED_PATH = "/feed";

export interface FeedRouteDeps {
  readonly storage: StoragePort;
  /** Absolute origin, e.g. https://whendowe.org: the UIDs' host and the events' links. */
  readonly publicBaseUrl: string;
  readonly now: () => string;
  /** Absent: this instance has no TOKEN_ENCRYPTION_KEY, so it makes no feed links. */
  readonly feedCipher?: TokenCipher;
}

/** Where a person makes or replaces their own feed's link, and a group's. */
export const ACCOUNT_FEED_PATH = `${ACCOUNT_PATH}/feed`;
export const groupFeedPath = (groupId: string) => `${GROUPS_PATH}/${groupId}/feed`;

/**
 * "Your calendar feed" / "This group in your calendar" (§10 rc34), for the account page
 * and a group's page. A GET shows the link if there is one; only the POST makes one.
 */
export async function feedSection(
  deps: FeedRouteDeps,
  scope: FeedScope,
  csrf: string,
): Promise<Html> {
  const own = scope.groupId === null;
  const heading = own ? "Your calendar feed" : "These events in your calendar";
  const what = own
    ? "Every event you're in, in your own calendar app, as you see it here. It keeps itself up to date."
    : "The events made in this group that you're in, as a calendar of their own: give it its own colour.";
  if (deps.feedCipher === undefined)
    return html`<h2 id="feed">${heading}</h2><p class="muted">Calendar feeds aren't set up on this server.</p>`;
  const action = own ? ACCOUNT_FEED_PATH : groupFeedPath(scope.groupId ?? "");
  const button = (label: string) => html`<form method="post" action="${action}">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><button type="submit">${label}</button></p>
</form>`;
  const token = await shownFeedLink(deps.storage, deps.feedCipher, scope);
  if (token === null)
    return html`<h2 id="feed">${heading}</h2><p class="muted">${what}</p>${button("Make a feed link")}`;
  return html`${PLAN_STYLE}<div class="pl">${linkShown(deps, token, heading, what, button)}</div>`;
}

/**
 * "Shared with people outside the group" (§10 rc36), on a group's page. Every member sees
 * that links exist — who each is for, what it shows, who made and keeps it — so nobody's
 * schedule is published without them being able to see it. Organizers also see the links
 * themselves, make new ones, and replace or stop each.
 */
export async function sharedLinksSection(
  deps: FeedRouteDeps,
  membership: GroupMembership,
  csrf: string,
): Promise<Html | string> {
  const groupId = membership.group.id;
  const heading = html`<h2 id="shared">Shared with people outside the group</h2>`;
  const organizer = membership.role === "organizer";
  if (deps.feedCipher === undefined)
    return organizer
      ? html`${heading}<p class="muted">Calendar links aren't set up on this server.</p>`
      : "";
  const links = await listSharedLinks(deps.storage, groupId);
  const names = new Map(
    (await listMembers(deps.storage, membership)).map((m) => [m.personId, m.shown.name]),
  );
  const nameOf = (id: string | null) =>
    id === null ? "a former member" : (names.get(id) ?? "a former member");
  const shown = organizer ? await shownSharedLinks(deps.storage, deps.feedCipher, groupId) : null;
  const action = (what: string) => `${GROUPS_PATH}/${groupId}/shared${what}`;
  const rowForm = (
    what: string,
    hash: string,
    label: string,
  ) => html`<form method="post" action="${action(what)}" style="display:inline">
  <input type="hidden" name="csrf" value="${csrf}" />
  <input type="hidden" name="link" value="${hash}" />
  <button type="submit">${label}</button>
</form>`;
  const row = (l: SharedLink) => {
    const token = shown?.get(l.hash);
    const by =
      l.madeBy === l.keeperId
        ? `made by ${nameOf(l.madeBy)}`
        : `made by ${nameOf(l.madeBy)}, now kept by ${nameOf(l.keeperId)}`;
    return html`<li><strong>${l.label}</strong> · ${l.tier === "BUSY" ? "busy only" : "details"} <span class="muted">· ${l.createdAt.slice(0, 10)}, ${by}</span>${
      token === undefined
        ? ""
        : html`${shareBox(`Link for ${l.label}`, new URL(sharedPath(token), deps.publicBaseUrl).toString(), 2)}
<p>${rowForm("/replace", l.hash, "New link")} ${rowForm("/stop", l.hash, "Stop sharing")}</p>`
    }</li>`;
  };
  const list =
    links.length === 0
      ? html`<p class="muted">Nobody outside the group can see its calendar.</p>`
      : html`<p class="muted">People outside the group can see its calendar through these links: what's coming, never notes or anyone's name.</p>
<ul class="stack">${links.map(row)}</ul>${organizer ? SHARE_BUTTONS : ""}`;
  const make = organizer
    ? html`<form method="post" action="${action("")}" class="stack">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><label>Who is it for? <input name="label" maxlength="40" required placeholder="Grandparents" /></label></p>
  <p><label>What it shows <select name="tier"><option value="DETAILS">Details: what, when and where</option><option value="BUSY">Busy only: just the times</option></select></label></p>
  <p><button type="submit">Make a link</button></p>
</form>
<p class="muted">Anyone with a link sees what it shows. If one gets out, make it a new link: the old one stops working at once.</p>`
    : "";
  return html`${PLAN_STYLE}<div class="pl">${heading}${list}${make}</div>`;
}

/** The link, the ways into a calendar app, and how slowly Google reads it. */
function linkShown(
  deps: FeedRouteDeps,
  token: string,
  heading: string,
  what: string,
  button: (label: string) => Html,
): Html {
  const https = new URL(feedPath(token), deps.publicBaseUrl).toString();
  const webcal = https.replace(/^https?:/, "webcal:");
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
  return html`<h2 id="feed">${heading}</h2><p class="muted">${what}</p>
${shareBox("Feed link", https, 2, false)}${SHARE_BUTTONS}
<p><a href="${webcal}">Open in your calendar app</a> · <a href="${google}" rel="noreferrer">Add to Google Calendar</a></p>
<p class="muted">Google Calendar checks a feed every few hours, so a change can take that long to show there. Apple Calendar and others check more often.</p>
<p class="muted">Anyone with this link sees what you see. If it got out, make a new one: the old link stops working at once.</p>
${button("Make a new link")}`;
}

/** The path of a feed link, for the pages that show it (F3). */
export function feedPath(token: string): string {
  return `${FEED_PATH}/${token}.ics`;
}

const FILE = /^([A-Za-z0-9_-]{43})\.ics$/;

/** A group calendar link (rc36): `/c/<token>` the page, `/c/<token>.ics` the feed. */
export const SHARED_PATH = "/c";
const SHARED_FILE = /^([A-Za-z0-9_-]{43})(?:\.ics)?$/;

export function sharedPath(token: string, ics = false): string {
  return `${SHARED_PATH}/${token}${ics ? ".ics" : ""}`;
}

export function registerFeedRoutes(app: Hono<AppEnv>, deps: FeedRouteDeps): void {
  // Busy times for the picker (rc41): JSON for the signed-in asker, times only. A
  // GET, so it reads and writes nothing else; the picker works without it.
  app.get(BUSY_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    const me = c.get("signedIn");
    if (me === null) return c.json({ busy: [] }, 401);
    const query = busyQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ busy: [] }, 400);
    return c.json({ busy: await ownBusy(deps.storage, me.personId, query.data, deps.now()) });
  });
  const cipher = deps.feedCipher;
  if (cipher !== undefined) {
    // Make or replace a link (GET never mutates): your own feed, or a group's for a member.
    app.post(ACCOUNT_FEED_PATH, async (c) => {
      const me = requireSignedIn(c);
      if (me instanceof Response) return me;
      const form = await c.req.parseBody();
      if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
      await issueFeedLink(deps.storage, cipher, {
        personId: me.personId,
        groupId: null,
        now: deps.now(),
      });
      return c.redirect(`${ACCOUNT_PATH}#feed`, 303);
    });
    app.post(`${GROUPS_PATH}/:id/feed`, async (c) => {
      const me = requireSignedIn(c);
      if (me instanceof Response) return me;
      const form = await c.req.parseBody();
      if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
      const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
      if (membership === null) return c.text("Not found", 404);
      await issueFeedLink(deps.storage, cipher, {
        personId: me.personId,
        groupId: membership.group.id,
        now: deps.now(),
      });
      return c.redirect(`${GROUPS_PATH}/${membership.group.id}#feed`, 303);
    });

    // Group calendar links (rc36): make, replace, stop. Organizers only, which the domain
    // checks in the statement that writes; anyone else changes nothing.
    const organizerPost = async (
      c: Context<AppEnv>,
      act: (
        groupId: string,
        organizerId: string,
        form: Record<string, unknown>,
      ) => Promise<boolean>,
    ) => {
      const me = requireSignedIn(c);
      if (me instanceof Response) return me;
      const form = await c.req.parseBody();
      if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
      const membership = await findGroupForMember(
        deps.storage,
        c.req.param("id") ?? "",
        me.personId,
      );
      if (membership === null) return c.text("Not found", 404);
      if (membership.role !== "organizer")
        return c.text("Only the group's organizers share its calendar.", 403);
      if (!(await act(membership.group.id, me.personId, form)))
        return c.text("That link isn't this group's.", 409);
      return c.redirect(`${GROUPS_PATH}/${membership.group.id}#shared`, 303);
    };
    const field = (form: Record<string, unknown>, key: string) =>
      typeof form[key] === "string" ? form[key] : "";
    app.post(`${GROUPS_PATH}/:id/shared`, (c) =>
      organizerPost(c, async (groupId, organizerId, form) => {
        const label = sharedLabelSchema.safeParse(field(form, "label"));
        const tier = sharedTierSchema.safeParse(field(form, "tier"));
        if (!label.success || !tier.success) return false;
        const made = await makeSharedLink(deps.storage, cipher, {
          groupId,
          organizerId,
          label: label.data,
          tier: tier.data,
          now: deps.now(),
        });
        return made !== null;
      }),
    );
    app.post(`${GROUPS_PATH}/:id/shared/replace`, (c) =>
      organizerPost(c, async (groupId, organizerId, form) => {
        const made = await replaceSharedLink(deps.storage, cipher, {
          groupId,
          organizerId,
          hash: field(form, "link"),
          now: deps.now(),
        });
        return made !== null;
      }),
    );
    app.post(`${GROUPS_PATH}/:id/shared/stop`, (c) =>
      organizerPost(c, (groupId, organizerId, form) =>
        stopSharedLink(deps.storage, { groupId, organizerId, hash: field(form, "link") }),
      ),
    );
  }

  app.get(`${FEED_PATH}/:file`, async (c) => {
    c.header("Referrer-Policy", "no-referrer");
    const token = FILE.exec(c.req.param("file"))?.[1];
    const feed = token === undefined ? null : await resolveFeed(deps.storage, token);
    if (feed === null) {
      c.header("Cache-Control", "no-store");
      return c.text("This feed link no longer works.", 404);
    }
    const base = new URL(deps.publicBaseUrl);
    const now = deps.now();
    const body = serializeFeed({
      name: feed.groupName === null ? "WhenDoWe" : `WhenDoWe · ${feed.groupName}`,
      host: base.host,
      entries: await feedEntries(deps.storage, feed, {
        now,
        eventUrl: (id) => new URL(`${EVENTS_PATH}/${id}`, base).toString(),
      }),
      now,
    });
    return serveCalendar(c, body);
  });

  // A group calendar link (rc36): /c/<token> is a read-only page of what is coming,
  // /c/<token>.ics the same events as a feed. For people outside the group: no names,
  // no notes, no links into pages only members can open, nothing for search engines.
  app.get(`${SHARED_PATH}/:file`, async (c) => {
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
    const file = c.req.param("file");
    const token = SHARED_FILE.exec(file)?.[1];
    const link = token === undefined ? null : await resolveSharedLink(deps.storage, token);
    if (token === undefined || link === null) {
      c.header("Cache-Control", "no-store");
      return c.html(
        renderPage(
          "Link no longer works",
          html`<h1>This link no longer works</h1><p>Ask whoever sent it for a new one.</p>`,
          null,
        ),
        404,
      );
    }
    const now = deps.now();
    const entries = await sharedEntries(deps.storage, link, now);
    if (file.endsWith(".ics"))
      return serveCalendar(
        c,
        serializeFeed({
          name: link.groupName,
          host: new URL(deps.publicBaseUrl).host,
          entries,
          now,
        }),
      );
    c.header("Cache-Control", "private, no-cache");
    return c.html(
      renderPage(
        link.groupName,
        sharedPage(link, entries, new URL(sharedPath(token, true), deps.publicBaseUrl), now),
        null,
        // A link preview names the group, never an event: a card in a chat is how it spreads.
        { title: link.groupName, description: "What's coming, shared by its organizers." },
      ),
    );
  });
}

/** A calendar body with an ETag over it: an unchanged one answers 304 (rc34). */
async function serveCalendar(c: Context<AppEnv>, body: string): Promise<Response> {
  const etag = `"${await hashToken(body)}"`;
  c.header("ETag", etag);
  // Private: each link is one view at one tier, never a shared cache's.
  c.header("Cache-Control", "private, max-age=900");
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  c.header("Content-Type", "text/calendar; charset=utf-8");
  return c.body(body, 200);
}

/** A group calendar link's page: what is coming, at the link's tier, and ways to subscribe. */
function sharedPage(
  link: ResolvedSharedLink,
  entries: readonly FeedEntry[],
  ics: URL,
  now: string,
): Html {
  const today = now.slice(0, 10);
  // Coming up: anything that repeats, or ends today or later. Past ones are in the feed.
  const coming = entries.filter((e) => e.rrule !== null || e.endLocal.slice(0, 10) >= today);
  const webcal = ics.toString().replace(/^https?:/, "webcal:");
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
  const line = (e: FeedEntry) => {
    const busy = e.visibility === "BUSY";
    return html`<li><strong>${busy ? BUSY_SUMMARY : e.title}</strong>${
      e.status === "cancelled" ? html` <span class="muted">(cancelled)</span>` : ""
    }<br /><span class="muted">${whenText(e)}${e.tzid === null ? "" : ` · ${e.tzid}`}${
      e.rrule === null ? "" : " · repeats"
    }${!busy && e.location !== null ? html` · 📍 ${e.location}` : ""}</span></li>`;
  };
  return html`<h1>${link.groupName}</h1>
<p class="muted">What's coming, shared by its organizers${link.tier === "BUSY" ? ": when they're busy, not what with" : ""}.</p>
${coming.length === 0 ? html`<p>Nothing coming up.</p>` : html`<ul class="shared-cal">${coming.map(line)}</ul>`}
<p><a href="${webcal}">Open in your calendar app</a> · <a href="${google}" rel="noreferrer">Add to Google Calendar</a></p>
<p class="muted">Google Calendar checks a calendar like this every few hours. Apple Calendar and others check more often.</p>`;
}
