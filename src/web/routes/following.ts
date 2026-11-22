// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { StoragePort } from "../../db/port.js";
import type { PublicGet } from "../../following/fetch.js";
import {
  FOLLOW_COLOURS,
  type FollowColour,
  type Follower,
  type FollowShown,
  follow,
  followsFor,
  MAX_FOLLOW_NAME,
  recolourFollow,
  refreshCalendar,
  renameFollow,
  stopFollowing,
} from "../../following/follow.js";
import { followableLink, type LinkRefusal, MAX_LINK_LENGTH } from "../../following/link.js";
import { listGroupsFor } from "../../people/group.js";
import { type Html, html } from "../layout.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  requireSignedIn,
  type SignedIn,
  verifyFormCsrf,
} from "../session.js";

// The calendars you and your groups follow (DESIGN §10 rc56): paste a link to follow it, for
// yourself or — as one of its organizers — for a group; rename, recolour and stop each. A
// group's follows are shown to all its members and changed only by its organizers. Every
// action is a POST form, so it all works without JavaScript; the GET writes nothing.

export const FOLLOWING_PATH = "/following";

export interface FollowingDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
  /**
   * The safe GET (rc57), so following a link fetches it at once (rc56). Absent, a new follow
   * is read in its turn of the six-hourly pass.
   */
  readonly publicGet?: PublicGet;
}

/**
 * A followed calendar's colour (rc56): six of its own, never an option's letter colour (rc46).
 * Muted, as a followed event isn't yours: each is about as far from every option colour, from
 * the status colours and from the attention amber (rc50), in OKLab, as two option colours are
 * from each other, in light and dark alike.
 */
const FOLLOW_TOKENS: Readonly<Record<FollowColour, string>> = {
  f1: "light-dark(#603f62, #e3bbe4)",
  f2: "light-dark(#5d492d, #dec7a7)",
  f3: "light-dark(#295171, #a5d0f6)",
  f4: "light-dark(#74607d, #bda8c7)",
  f5: "light-dark(#626e4f, #aab795)",
  f6: "light-dark(#2a583c, #a7d9b7)",
};

/** The follow colours, for any page that draws a followed calendar (F2 too). */
export const FOLLOW_STYLE = html`<style>
  :root { ${FOLLOW_COLOURS.map((k) => `--${k}: ${FOLLOW_TOKENS[k]};`).join(" ")} }
  ${FOLLOW_COLOURS.map((k) => `.fc-${k} { --fc: var(--${k}); }`).join("\n  ")}
  .fc-dot { display: inline-block; width: .8em; height: .8em; border-radius: 50%; background: var(--fc);
    vertical-align: -.05em; margin-right: .4em; }
  .follows { list-style: none; padding: 0; display: grid; gap: .75rem; }
  .follows > li { border-left: 4px solid var(--fc); padding: .25rem 0 .25rem .75rem; }
  .follows details form { margin: .5rem 0; }
  .follows input[type=text] { font: inherit; padding: .4rem; width: 100%; box-sizing: border-box; }
  .colours { display: flex; flex-wrap: wrap; gap: .5rem; border: 0; padding: 0; margin: 0 0 .5rem; }
  .colours label { display: inline-flex; align-items: center; gap: .25rem; }
  .follow-new input { font: inherit; padding: .5rem; width: 100%; box-sizing: border-box; }
</style>`;

const REFUSED: Readonly<Record<LinkRefusal, string>> = {
  "not-a-link":
    "That isn't a link we can read. Paste the calendar's address, as its page gives it.",
  "not-https": "Only https: and webcal: links can be followed.",
  credentials: "A link with a name or password in it can't be followed: only public calendars.",
  port: "A link with a port number in it can't be followed.",
};

/** Who a form acts as: `for` is "me", or the id of a group the person organizes. */
function followerOf(me: SignedIn, form: Record<string, unknown>): Follower {
  const forWhom = typeof form.for === "string" ? form.for : "me";
  return forWhom === "me"
    ? { kind: "person", personId: me.personId }
    : { kind: "group", groupId: forWhom, actorId: me.personId };
}

const field = (form: Record<string, unknown>, key: string): string =>
  typeof form[key] === "string" ? form[key] : "";

const colourSchema = z.enum(FOLLOW_COLOURS);

/** What a followed calendar is called: its name, else the host its link is on. */
function shownName(f: FollowShown): string {
  return f.name ?? new URL(f.url).hostname;
}

/** How the last fetch went, in a line. */
function statusLine(f: FollowShown): Html {
  if (f.status === "refused")
    return html`<span class="error">This address can't be followed: it isn't a public one.</span>`;
  if (f.status === "unreadable")
    return html`<span class="error">Couldn't read this calendar.</span>`;
  if (f.fetchedAt === null) return html`<span class="muted">Not read yet.</span>`;
  const events = f.kept === 1 ? "1 event" : `${f.kept} events`;
  const left =
    f.leftOut === 0
      ? ""
      : f.leftOut === 1
        ? " · 1 event we couldn't read is left out"
        : ` · ${f.leftOut} events we couldn't read are left out`;
  return html`<span class="muted">${events} in the next 60 days${left}</span>`;
}

function changeForms(f: FollowShown, csrf: string): Html {
  const forWhom = f.group === null ? "me" : f.group.id;
  const hidden = html`<input type="hidden" name="csrf" value="${csrf}" />
    <input type="hidden" name="for" value="${forWhom}" />`;
  const action = (what: string) => `${FOLLOWING_PATH}/${f.followId}/${what}`;
  const colour = (k: FollowColour) =>
    html`<label class="fc-${k}"><input type="radio" name="colour" value="${k}"${
      k === f.colour ? " checked" : ""
    } /><span class="fc-dot" aria-hidden="true"></span><span class="muted">${k.slice(1)}</span></label>`;
  return html`<details><summary>Change</summary>
  <form method="post" action="${action("name")}">${hidden}
    <p><label>Name <input type="text" name="name" maxlength="${MAX_FOLLOW_NAME}" value="${f.ownName ?? ""}" placeholder="${shownName(f)}" /></label></p>
    <p><button type="submit">Rename</button> <span class="muted">Empty goes back to the calendar's own name.</span></p>
  </form>
  <form method="post" action="${action("colour")}">${hidden}
    <fieldset class="colours"><legend>Colour</legend>${FOLLOW_COLOURS.map(colour)}</fieldset>
    <p><button type="submit">Change colour</button></p>
  </form>
  <form method="post" action="${action("stop")}">${hidden}
    <p><button type="submit">Stop following</button></p>
  </form>
</details>`;
}

function followItem(f: FollowShown, csrf: string): Html {
  const mayChange = f.group === null || f.group.organizer;
  return html`<li id="f-${f.followId}" class="fc-${f.colour}"><strong>${shownName(f)}</strong><br />
${statusLine(f)}<br />
<a href="${f.url}" rel="noreferrer noopener" class="muted">${f.url}</a>
${mayChange ? changeForms(f, csrf) : html`<br /><span class="muted">The group's organizers follow this for it.</span>`}</li>`;
}

async function followingPage(
  deps: FollowingDeps,
  me: SignedIn,
  problem: { readonly link: string; readonly message: string } | null,
): Promise<Html> {
  const follows = await followsFor(deps.storage, me.personId);
  const organized = (await listGroupsFor(deps.storage, me.personId)).filter(
    (g) => g.role === "organizer",
  );
  const forWhom =
    organized.length === 0
      ? html`<input type="hidden" name="for" value="me" />`
      : html`<p><label>For <select name="for"><option value="me">You</option>${organized.map(
          (g) => html`<option value="${g.id}">${g.name}: everyone in it</option>`,
        )}</select></label></p>`;
  const own = follows.filter((f) => f.group === null);
  const groups = new Map<string, { name: string; follows: FollowShown[] }>();
  for (const f of follows) {
    if (f.group === null) continue;
    const g = groups.get(f.group.id) ?? { name: f.group.name, follows: [] };
    g.follows.push(f);
    groups.set(f.group.id, g);
  }
  const list = (items: readonly FollowShown[]) =>
    html`<ul class="follows">${items.map((f) => followItem(f, me.csrfToken))}</ul>`;
  return html`${FOLLOW_STYLE}<h1>Calendars you follow</h1>
<p class="muted">What's on beside what you're in: a dance school's classes, a venue's programme. A followed event is never yours: it isn't in your calendar or your feed, and it doesn't make you busy.</p>
<form method="post" action="${FOLLOWING_PATH}" class="follow-new">
  <input type="hidden" name="csrf" value="${me.csrfToken}" />
  ${problem === null ? "" : html`<p class="error" role="alert">${problem.message}</p>`}
  <p><label>Calendar link <input type="text" inputmode="url" name="link" required maxlength="${MAX_LINK_LENGTH}" value="${problem?.link ?? ""}" placeholder="webcal://… or https://calendar.google.com/…" /></label></p>
  ${forWhom}
  <p><button type="submit">Follow</button></p>
  <p class="muted">An iCal link, or a Google calendar's embed or share link. Only public calendars: nothing is signed in to read it. Each calendar is read again every six hours.</p>
</form>
<h2>Yours</h2>
${own.length === 0 ? html`<p class="muted">You don't follow any calendars yet.</p>` : list(own)}
${[...groups.values()].map((g) => html`<h2>${g.name}</h2>${list(g.follows)}`)}`;
}

export function registerFollowingRoutes(app: Hono<AppEnv>, deps: FollowingDeps): void {
  app.get(FOLLOWING_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    c.header("Cache-Control", "private, no-store");
    return c.html(page(c, "Calendars you follow", await followingPage(deps, me, null)));
  });

  app.post(FOLLOWING_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const pasted = field(form, "link");
    const link = followableLink(pasted);
    if (!link.ok) {
      const problem = { link: pasted.slice(0, MAX_LINK_LENGTH), message: REFUSED[link.reason] };
      return c.html(page(c, "Calendars you follow", await followingPage(deps, me, problem)), 400);
    }
    const now = deps.now();
    const followed = await follow(deps.storage, followerOf(me, form), link.url, now);
    if (!followed.ok) return c.text("Only a group's organizers follow calendars for it.", 403);
    // Following a link fetches it at once (rc56), bounded by the fetch's own limits (rc57).
    if (followed.fetchNow && deps.publicGet !== undefined)
      await refreshCalendar(deps.storage, deps.publicGet, followed.calendarId, now);
    return c.redirect(`${FOLLOWING_PATH}#f-${followed.followId}`, 303);
  });

  const change =
    (
      act: (
        me: SignedIn,
        follower: Follower,
        followId: string,
        form: Record<string, unknown>,
      ) => Promise<boolean>,
    ) =>
    async (c: Context<AppEnv>) => {
      const me = requireSignedIn(c);
      if (me instanceof Response) return me;
      const form = await c.req.parseBody();
      if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
      const followId = c.req.param("id") ?? "";
      if (!(await act(me, followerOf(me, form), followId, form)))
        return c.text("That isn't a calendar you can change.", 404);
      return c.redirect(`${FOLLOWING_PATH}#f-${followId}`, 303);
    };

  app.post(
    `${FOLLOWING_PATH}/:id/name`,
    change((_, follower, id, form) =>
      renameFollow(deps.storage, follower, id, field(form, "name")),
    ),
  );
  app.post(
    `${FOLLOWING_PATH}/:id/colour`,
    change(async (_, follower, id, form) => {
      const colour = colourSchema.safeParse(field(form, "colour"));
      return colour.success && recolourFollow(deps.storage, follower, id, colour.data);
    }),
  );
  app.post(
    `${FOLLOWING_PATH}/:id/stop`,
    change((_, follower, id) => stopFollowing(deps.storage, follower, id)),
  );
}
