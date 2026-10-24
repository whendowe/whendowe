// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import type { StoragePort } from "../../db/port.js";
import { listGroupEvents } from "../../events/event.js";
import { MailCapReachedError } from "../../mail/capped.js";
import type { MailPort } from "../../mail/port.js";
import {
  createGroup,
  findGroupForMember,
  type GroupMembership,
  listGroupsFor,
  listMembers,
} from "../../people/group.js";
import {
  acceptInvite,
  createInvite,
  editTierSchema,
  INVITE_TTL_MS,
  peekInvite,
  visibilitySchema,
} from "../../people/invite.js";
import { normalizeEmail } from "../../people/person.js";
import { html } from "../layout.js";
import {
  type AppEnv,
  notVisible,
  page,
  rejectedPage,
  requireSignedIn,
  signInAs,
  verifyFormCsrf,
} from "../session.js";
import { eventSummary } from "./events.js";

// Groups (MVP-1 slice D1). Every route needs a signed-in person; every group page
// goes through findGroupForMember, which is the only way to read a group at all, so
// a non-member gets the same 404 as a group that does not exist (§13: no IDOR, and
// no confirming that a group exists to someone outside it).

export const GROUPS_PATH = "/groups";
export const INVITE_PATH = "/invite";

export interface GroupDeps {
  readonly storage: StoragePort;
  /** The capped mail port (src/mail/capped.ts). */
  readonly mail: MailPort;
  /** Links are built from this, never the Host header (see routes/auth.ts). */
  readonly publicBaseUrl: string;
  readonly secureCookies: boolean;
  readonly now: () => string;
}

const DAYS = INVITE_TTL_MS / (24 * 60 * 60 * 1000);

function inviteForm(
  membership: GroupMembership,
  csrf: string,
  notice: ReturnType<typeof html> | null,
) {
  return html`<h2>Invite someone</h2>
${notice}
<form method="post" action="${GROUPS_PATH}/${membership.group.id}/invites">
  <input type="hidden" name="csrf" value="${csrf}" />
  <label for="email">Their email</label>
  <input id="email" name="email" type="email" required />
  <p>
    <label>Can change events:
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
  <p><button type="submit">Send invite</button></p>
</form>`;
}

function sensitive(c: { header: (name: string, value: string) => void }): void {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
}

function inviteExpired(c: Context<AppEnv>) {
  return page(
    c,
    "Invite expired",
    html`<h1>This invite has expired or was already used</h1>
<p>Ask whoever invited you to send a new one. Invites last ${DAYS} days and work once.</p>`,
  );
}

function notFound(c: Context<AppEnv>) {
  return page(
    c,
    "Not found",
    html`<h1>Not found</h1><p><a href="${GROUPS_PATH}">Your groups</a></p>`,
  );
}

function createForm(csrf: string, name: string, error: string | null) {
  return html`<h2>New group</h2>
${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${GROUPS_PATH}">
  <input type="hidden" name="csrf" value="${csrf}" />
  <label for="name">Name</label>
  <input id="name" name="name" required maxlength="80" value="${name}" placeholder="Thursday Table" />
  <p><button type="submit">Create group</button></p>
</form>`;
}

export function registerGroupRoutes(app: Hono<AppEnv>, deps: GroupDeps): void {
  app.get(GROUPS_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const groups = await listGroupsFor(deps.storage, me.personId);
    return c.html(
      page(
        c,
        "Your groups",
        html`<p><a href="/">← Home</a></p>
<h1>Your groups</h1>
${
  groups.length === 0
    ? html`<p class="muted">No groups yet. A group is the people you plan with — a household, a game night.</p>`
    : html`<ul>${groups.map(
        (g) =>
          html`<li><a href="${GROUPS_PATH}/${g.id}">${g.name}</a> <span class="muted">· ${g.memberCount} ${g.memberCount === 1 ? "person" : "people"}${g.role === "organizer" ? " · you organize" : ""}</span></li>`,
      )}</ul>`
}
${createForm(me.csrfToken, "", null)}`,
      ),
    );
  });

  app.post(GROUPS_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) {
      return rejectedPage(c, form);
    }
    const raw = typeof form.name === "string" ? form.name : "";
    try {
      const group = await createGroup(deps.storage, {
        name: raw,
        creatorId: me.personId,
        now: deps.now(),
      });
      return c.redirect(`${GROUPS_PATH}/${group.id}`, 303);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create the group.";
      return c.html(page(c, "New group", createForm(me.csrfToken, raw.slice(0, 80), message)), 400);
    }
  });

  app.get(`${GROUPS_PATH}/:id`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
    if (membership === null) {
      const id = c.req.param("id");
      return notVisible(
        c,
        async (personId) => (await findGroupForMember(deps.storage, id, personId)) !== null,
      );
    }
    const members = await listMembers(deps.storage, membership);
    // Each event rendered at THIS viewer's visibility tier (eventSummary → canSee).
    const events = await listGroupEvents(deps.storage, membership, me.personId);
    return c.html(
      page(
        c,
        membership.group.name,
        html`<p><a href="${GROUPS_PATH}">← Your groups</a></p>
<h1>${membership.group.name}</h1>
<h2>Events</h2>
${events.length === 0 ? html`<p class="muted">Nothing planned yet.</p>` : html`<ul>${events.map((a) => html`<li>${eventSummary(a)}</li>`)}</ul>`}
<p><a href="${GROUPS_PATH}/${membership.group.id}/events/new">+ New event</a> · <a href="${GROUPS_PATH}/${membership.group.id}/polls/new">+ Find a time (poll)</a></p>
<h2>People</h2>
<ul>${members.map(
          (m) =>
            html`<li>${m.displayName ?? m.email}${m.personId === me.personId ? " (you)" : ""}${m.role === "organizer" ? html` <span class="muted">· organizer</span>` : ""}</li>`,
        )}</ul>
${membership.role === "organizer" ? inviteForm(membership, me.csrfToken, null) : ""}`,
      ),
    );
  });

  app.post(`${GROUPS_PATH}/:id/invites`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) {
      return rejectedPage(c, form);
    }
    const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
    if (membership === null) return c.html(notFound(c), 404);
    if (membership.role !== "organizer") {
      return c.html(
        page(c, "Not allowed", html`<h1>Only the group's organizer can invite people</h1>`),
        403,
      );
    }

    const reply = (status: 200 | 400 | 409 | 429 | 502 | 503, notice: ReturnType<typeof html>) =>
      c.html(
        page(
          c,
          membership.group.name,
          html`<p><a href="${GROUPS_PATH}/${membership.group.id}">← ${membership.group.name}</a></p>
${inviteForm(membership, me.csrfToken, notice)}`,
        ),
        status,
      );

    const raw = typeof form.email === "string" ? form.email : "";
    const editTier = editTierSchema.safeParse(form.editTier);
    const visibility = visibilitySchema.safeParse(form.visibility);
    let email: string;
    try {
      email = normalizeEmail(raw);
    } catch {
      return reply(400, html`<p class="error">That doesn't look like an email address.</p>`);
    }
    if (!editTier.success || !visibility.success) {
      return reply(400, html`<p class="error">Choose what they can change and see.</p>`);
    }

    const invite = await createInvite(deps.storage, membership, {
      email,
      invitedBy: me.personId,
      editTier: editTier.data,
      visibility: visibility.data,
      now: deps.now(),
    });
    if (!invite.ok) {
      if (invite.reason === "already_member")
        return reply(409, html`<p class="error">${email} is already in this group.</p>`);
      if (invite.reason === "rate_limited")
        return reply(
          429,
          html`<p class="error">That's a lot of invites today. Try again tomorrow.</p>`,
        );
      return c.html(
        page(c, "Not allowed", html`<h1>Only the group's organizer can invite people</h1>`),
        403,
      );
    }

    const link = new URL(INVITE_PATH, deps.publicBaseUrl);
    link.searchParams.set("t", invite.token);
    try {
      // The group name is user-written text inside an email from our domain. It is
      // plain text (no HTML to inject) and capped at 80 characters; within a group of
      // people who know each other that is acceptable, but it is a phishing surface to
      // revisit before discoverable groups exist.
      await deps.mail.send({
        to: invite.email,
        subject: `${me.email} invited you to "${membership.group.name}" on WhenDoWe`,
        text: [
          `${me.email} invited you to the group "${membership.group.name}" on WhenDoWe.`,
          "",
          "Join (this also signs you in — no password, nothing to install):",
          link.toString(),
          "",
          `The link works once and expires in ${DAYS} days.`,
          "If you don't know this person, ignore this email — nothing happens unless the link is used.",
        ].join("\n"),
      });
    } catch (error) {
      if (error instanceof MailCapReachedError)
        return reply(
          503,
          html`<p class="error">We can't send email right now. Please try again later.</p>`,
        );
      return reply(
        502,
        html`<p class="error">We couldn't send the invite. Please check the address and try again.</p>`,
      );
    }
    return reply(200, html`<p>Invite sent to <strong>${invite.email}</strong>.</p>`);
  });

  app.get(INVITE_PATH, async (c) => {
    sensitive(c);
    const token = c.req.query("t");
    const preview =
      token === undefined || token.length > 256
        ? null
        : await peekInvite(deps.storage, token, deps.now());
    if (token === undefined || preview === null) return c.html(inviteExpired(c), 400);
    const signedIn = c.get("signedIn");
    return c.html(
      page(
        c,
        "Join group",
        html`<h1>Join “${preview.groupName}”?</h1>
<p><strong>${preview.inviterEmail}</strong> invited <strong>${preview.email}</strong>.</p>
${
  signedIn !== null && signedIn.email !== preview.email
    ? html`<p class="muted">You're signed in as ${signedIn.email}. Joining also signs this browser in as ${preview.email}, and you can switch between them from the menu at the top.</p>`
    : html`<p class="muted">Joining also signs you in as ${preview.email}.</p>`
}
<form method="post" action="${INVITE_PATH}">
  <input type="hidden" name="t" value="${token}" />
  <button type="submit">Join</button>
</form>`,
      ),
    );
  });

  app.post(INVITE_PATH, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = typeof form.t === "string" && form.t.length <= 256 ? form.t : null;
    const now = deps.now();
    const accepted = token === null ? null : await acceptInvite(deps.storage, token, now);
    if (accepted === null) return c.html(inviteExpired(c), 400);

    // Sign the browser in as the invited account too (§13 rc18): it joins this browser's
    // accounts, the others stay. With four others already here the invite still counts,
    // but signing in waits until there is room.
    const current = c.get("signedIn");
    if (current?.personId !== accepted.personId && !(await signInAs(c, deps, accepted.personId))) {
      return c.html(
        page(
          c,
          "Joined",
          html`<h1>You've joined</h1>
<p>Four accounts are already signed in on this browser, the most it holds, so this one isn't yet. Sign out of one from the menu at the top, then sign in as the invited address.</p>`,
        ),
      );
    }
    return c.redirect(`${GROUPS_PATH}/${accepted.groupId}`, 303);
  });
}
