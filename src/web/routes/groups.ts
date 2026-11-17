// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Context, Hono } from "hono";
import type { StoragePort } from "../../db/port.js";
import { groupDefaultVerified, listGroupEvents } from "../../events/event.js";
import { MailCapReachedError } from "../../mail/capped.js";
import type { MailPort } from "../../mail/port.js";
import { type CapabilityConfig, UNAVAILABLE } from "../../people/capability.js";
import {
  createGroup,
  defaultOwnAnswersOnly,
  findGroupForMember,
  type GroupMembership,
  groupRetention,
  leaveGroup,
  listGroupsFor,
  listMembers,
  setDefaultOwnAnswersOnly,
  setGroupDefaultVerified,
  setGroupRetention,
} from "../../people/group.js";
import { acceptInvite, createInvite, INVITE_TTL_MS, peekInvite } from "../../people/invite.js";
import { type KnownPerson, knownAddresses, listKnownPeople } from "../../people/known.js";
import { appearanceIn, normalizeEmail } from "../../people/person.js";
import { retainDaysSchema } from "../../privacy/retention.js";
import {
  cappedText,
  GROUPS_PATH,
  type Html,
  html,
  ownAnswersForm,
  retentionSection,
  who,
} from "../layout.js";
import {
  applyPick,
  type Chip,
  carriedFilter,
  chipProblem,
  leversValid,
  peoplePicker,
  pickerAction,
  readChips,
} from "../people-picker.js";
import {
  type AppEnv,
  notVisible,
  page,
  rejectedPage,
  requireSignedIn,
  signInAs,
  verifyFormCsrf,
} from "../session.js";
import { appearanceSection, saveAppearance } from "./account.js";
import { ASK_PATH } from "./ask.js";
import { SIGN_IN_PATH } from "./auth.js";
import { eventSummary, mayVerify } from "./events.js";
import { feedSection, sharedLinksSection } from "./feeds.js";

// Groups (MVP-1 slice D1). Every route needs a signed-in person; every group page
// goes through findGroupForMember, which is the only way to read a group at all, so
// a non-member gets the same 404 as a group that does not exist (§13: no IDOR, and
// no confirming that a group exists to someone outside it).

export { GROUPS_PATH };
export const INVITE_PATH = "/invite";

export interface GroupDeps {
  readonly storage: StoragePort;
  /** The capped mail port (src/mail/capped.ts). */
  readonly mail: MailPort;
  /** Links are built from this, never the Host header (see routes/auth.ts). */
  readonly publicBaseUrl: string;
  readonly secureCookies: boolean;
  /** rc43: who may turn verifying on; absent, everyone may. */
  readonly capabilities?: CapabilityConfig;
  readonly now: () => string;
}

const DAYS = INVITE_TTL_MS / (24 * 60 * 60 * 1000);

/** At most this many invites from one form (the group's daily limit bounds them all). */
const INVITES_PER_FORM = 20;

interface InvitePicker {
  readonly chips: readonly Chip[];
  readonly known: readonly KnownPerson[];
  readonly members: ReadonlySet<string>;
  readonly filter: string | null;
}

/** People to invite (rc48): the people picker, each chip with the defaults it joins with. */
function inviteForm(
  membership: GroupMembership,
  csrf: string,
  notice: ReturnType<typeof html> | null,
  picker: InvitePicker,
) {
  return html`<h2>Invite people</h2>
${notice}
<form method="post" action="${GROUPS_PATH}/${membership.group.id}/invites">
  <input type="hidden" name="csrf" value="${csrf}" />
  ${peoplePicker({
    chips: picker.chips,
    known: picker.known,
    levers: { terms: true, asking: false },
    filter: picker.filter,
    lead: "Each gets an email with a link to join. What they can change and see is their default on this group's events.",
    group: null,
    exclude: picker.members,
  })}
  <p><button type="submit">Send invites</button></p>
</form>`;
}

async function invitePicker(
  storage: StoragePort,
  membership: GroupMembership,
  me: string,
  chips: readonly Chip[] = [],
  filter: string | null = null,
): Promise<InvitePicker> {
  const members = new Set((await listMembers(storage, membership)).map((m) => m.personId));
  return { chips, known: await listKnownPeople(storage, me), members, filter };
}

function sensitive(c: { header: (name: string, value: string) => void }): void {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
}

/** rc42: whether new events start verified — shown to everyone, set by organizers. */
async function verifiedDefault(
  storage: StoragePort,
  membership: GroupMembership,
  csrf: string,
  /** rc43: whether this organizer may turn it on; turning it off is always theirs. */
  allowed: boolean,
): Promise<Html | string> {
  const on = await groupDefaultVerified(storage, membership.group.id);
  const said = on
    ? html`New events in this group are verified: answers count only from each person's own email, or signed in.`
    : html`New events in this group aren't verified unless whoever makes one says so.`;
  if (membership.role !== "organizer") return html`<p class="muted">${said}</p>`;
  if (!on && !allowed)
    return html`<p><label><input type="checkbox" name="on" disabled /> Verify answers on new events from this group</label><br />
  <span class="muted">${UNAVAILABLE.verify}</span></p>`;
  return html`<form method="post" action="${GROUPS_PATH}/${membership.group.id}/verified">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><label><input type="checkbox" name="on" value="1"${on ? html` checked` : ""} /> Verify answers on new events from this group</label> <button type="submit">Save</button><br />
  <span class="muted">Events already made keep theirs.</span></p>
</form>`;
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
    // Events from this group or shared with its members (DESIGN rc15); each rendered
    // at THIS viewer's visibility tier (eventSummary → canSee).
    const events = await listGroupEvents(deps.storage, membership, me.personId);
    return c.html(
      page(
        c,
        membership.group.name,
        html`<p><a href="${GROUPS_PATH}">← Your groups</a></p>
<h1>${membership.group.name}</h1>
<h2>Events with these people</h2>
${events.length === 0 ? html`<p class="muted">Nothing planned yet.</p>` : html`<ul>${events.map((a) => html`<li>${eventSummary(a)}</li>`)}</ul>`}
<form method="post" action="${ASK_PATH}" class="row wrap"><input type="hidden" name="csrf" value="${me.csrfToken}" /><input type="hidden" name="group" value="${membership.group.id}" /><button class="primary" type="submit">Ask ${membership.group.name} when</button></form>
<p class="muted"><a href="${GROUPS_PATH}/${membership.group.id}/events/new">New repeating event</a></p>
<h2>People</h2>
<ul>${members.map(
          (m) =>
            html`<li>${who(m.shown)}${m.personId === me.personId ? " (you)" : ""}${m.role === "organizer" ? html` <span class="muted">· organizer</span>` : ""}</li>`,
        )}</ul>
${await feedSection(deps, { personId: me.personId, groupId: membership.group.id }, me.csrfToken)}
${await sharedLinksSection(deps, membership, me.csrfToken)}
${await appearanceSection(deps.storage, { kind: "group", id: membership.group.id }, me, `${GROUPS_PATH}/${membership.group.id}/me`, "group")}
${ownAnswersForm({ action: `${GROUPS_PATH}/${membership.group.id}/own-answers`, hidden: { csrf: me.csrfToken }, on: await defaultOwnAnswersOnly(deps.storage, membership.group.id, me.personId), where: "on new events from this group" })}
${membership.role === "organizer" ? inviteForm(membership, me.csrfToken, null, await invitePicker(deps.storage, membership, me.personId)) : ""}
${retentionSection({
  days: await groupRetention(deps.storage, membership.group.id),
  subject: "Events made in this group are",
  ends: "they end",
  form:
    membership.role === "organizer"
      ? {
          action: `${GROUPS_PATH}/${membership.group.id}/retention`,
          csrf: me.csrfToken,
          note: "A change applies to events made from now on; events already made keep theirs.",
        }
      : null,
})}
${await verifiedDefault(deps.storage, membership, me.csrfToken, await mayVerify(deps, me.personId))}
<p class="muted"><a href="${GROUPS_PATH}/${membership.group.id}/leave">Leave this group</a></p>`,
      ),
    );
  });

  // "You appear here as…" (§10 rc21). Membership is the access check; saveAppearance
  // checks CSRF and writes only this person's own row.
  // Leaving (DESIGN §10 rc21). GET says what will happen; POST does it.
  app.get(`${GROUPS_PATH}/:id/leave`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
    if (membership === null) return c.notFound();
    const others = (await listMembers(deps.storage, membership)).length - 1;
    const id = membership.group.id;
    return c.html(
      page(
        c,
        "Leave group",
        html`<h1>Leave “${membership.group.name}”?</h1>
<p>Your events stay as they are: leaving a group doesn't take you off its events, and doesn't take anyone off yours.</p>
${
  others === 0
    ? html`<p class="error">You're the last one in it, so leaving deletes the group.</p>`
    : membership.role === "organizer"
      ? html`<p>Someone else will organize it: whoever has been in it longest.</p>`
      : ""
}
<form method="post" action="${GROUPS_PATH}/${id}/leave">
  <input type="hidden" name="csrf" value="${me.csrfToken}" />
  <p><button type="submit">${others === 0 ? "Leave and delete it" : "Leave"}</button> <a href="${GROUPS_PATH}/${id}">Stay</a></p>
</form>`,
      ),
    );
  });

  app.post(`${GROUPS_PATH}/:id/leave`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
    if (membership === null) return c.notFound();
    await leaveGroup(deps.storage, membership, me.personId, deps.now());
    return c.redirect(GROUPS_PATH, 303);
  });

  app.post(`${GROUPS_PATH}/:id/me`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
    if (membership === null) return c.notFound();
    const id = membership.group.id;
    return saveAppearance(c, deps.storage, { kind: "group", id }, `${GROUPS_PATH}/${id}`);
  });

  // rc42: whether the group's new events start verified; its organizers'.
  app.post(`${GROUPS_PATH}/:id/verified`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
    if (membership === null) return c.notFound();
    if (form.on === "1" && !(await mayVerify(deps, me.personId)))
      return c.html(page(c, "Not allowed", html`<h1>${UNAVAILABLE.verify}</h1>`), 403);
    if (!(await setGroupDefaultVerified(deps.storage, membership, form.on === "1")))
      return c.html(page(c, "Not allowed", html`<h1>Only organizers change that</h1>`), 403);
    return c.redirect(`${GROUPS_PATH}/${membership.group.id}`, 303);
  });

  // rc42: a member's default for their own answers, copied onto events made afterwards.
  app.post(`${GROUPS_PATH}/:id/own-answers`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
    if (membership === null) return c.notFound();
    await setDefaultOwnAnswersOnly(deps.storage, membership, me.personId, form.on === "1");
    return c.redirect(`${GROUPS_PATH}/${membership.group.id}`, 303);
  });

  // Retention (DESIGN §10 rc23): organizers only; the domain refuses anyone else too.
  app.post(`${GROUPS_PATH}/:id/retention`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
    if (membership === null) return c.notFound();
    const days = retainDaysSchema.safeParse(form.retain_days);
    if (!days.success)
      return c.html(page(c, "Not saved", html`<h1>Choose one of the periods</h1>`), 400);
    if (!(await setGroupRetention(deps.storage, membership, days.data)))
      return c.html(
        page(c, "Not allowed", html`<h1>Only the group's organizers can change this</h1>`),
        403,
      );
    return c.redirect(`${GROUPS_PATH}/${membership.group.id}`, 303);
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

    type Status = 200 | 400 | 409 | 422 | 429 | 502 | 503;
    const known = await listKnownPeople(deps.storage, me.personId);
    const typed = readChips(form, INVITES_PER_FORM);
    const reply = async (
      status: Status,
      notice: ReturnType<typeof html> | null,
      chips: readonly Chip[] = [],
      filter: string | null = null,
    ) =>
      c.html(
        page(
          c,
          membership.group.name,
          html`<p><a href="${GROUPS_PATH}/${membership.group.id}">← ${membership.group.name}</a></p>
${inviteForm(membership, me.csrfToken, notice, {
  ...(await invitePicker(deps.storage, membership, me.personId, chips, filter)),
  known,
})}`,
        ),
        status,
      );

    if (!leversValid(form, true))
      return reply(400, html`<p class="error">Choose what they can change and see.</p>`);
    // A picker button: the form again, with its chips; nobody is invited yet (rc48).
    const pick = pickerAction(form);
    if (pick !== null && pick !== "add") {
      const members = (await invitePicker(deps.storage, membership, me.personId)).members;
      const picked = applyPick({
        chips: typed,
        action: pick,
        known,
        max: INVITES_PER_FORM,
        filter: carriedFilter(form),
        exclude: members,
      });
      return reply(200, null, picked.chips, picked.filter);
    }
    if (pick === "add") return reply(200, null, typed, carriedFilter(form));
    if (typed.length === 0)
      return reply(400, html`<p class="error">Add someone to invite first.</p>`);
    const marked = typed.filter((t) => chipProblem(t, known) !== null);
    if (marked.length > 0) {
      const one = marked.length === 1 && typed.length === 1 && marked[0]?.kind === "email";
      return reply(
        400,
        one
          ? html`<p class="error">That doesn't look like an email address.</p>`
          : html`<p class="error">Some of these are marked: fix or remove them first.</p>`,
        typed,
        carriedFilter(form),
      );
    }
    // A person chosen from the suggestions is named by how they're shown, never by address.
    const addresses = await knownAddresses(
      deps.storage,
      me.personId,
      typed.filter((t) => t.kind === "person").map((t) => t.value),
    );
    // Named as the group sees them, never by address (§10 rc21).
    const from =
      (await appearanceIn(deps.storage, { kind: "group", id: membership.group.id }, me.personId))
        ?.shown.name ?? "Someone";
    const inviteOne = async (
      email: string,
      label: string,
      chip: Chip,
    ): Promise<{ status: Status; notice: Html }> => {
      const invite = await createInvite(deps.storage, membership, {
        email,
        invitedBy: me.personId,
        editTier: chip.editTier,
        visibility: chip.visibility,
        now: deps.now(),
      });
      if (!invite.ok) {
        if (invite.reason === "already_member")
          return { status: 409, notice: html`${label} is already in this group.` };
        if (invite.reason === "unreachable")
          return { status: 422, notice: html`Couldn't add ${label}.` };
        if (invite.reason === "rate_limited")
          return { status: 429, notice: html`That's a lot of invites today. Try again tomorrow.` };
        return { status: 422, notice: html`Couldn't add ${label}.` };
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
          subject: `${from} invited you to "${membership.group.name}" on WhenDoWe`,
          cause: {
            kind: "from",
            senderId: me.personId,
            groupId: membership.group.id,
            why: `${from} invited this address to the group "${membership.group.name}"`,
          },
          text: [
            `${from} invited you to the group "${membership.group.name}" on WhenDoWe.`,
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
          return { status: 503, notice: html`${cappedText(error, deps.now(), false)}` };
        return {
          status: 502,
          notice: html`We couldn't send the invite to ${label}. Please check the address and try again.`,
        };
      }
      return { status: 200, notice: html`Invite sent to <strong>${label}</strong>.` };
    };

    const outcomes: { status: Status; notice: Html }[] = [];
    for (const chip of typed) {
      const label =
        chip.kind === "email"
          ? normalizeEmail(chip.value)
          : (known.find((k) => k.personId === chip.value)?.shown.name ?? "Someone");
      const email = chip.kind === "email" ? label : addresses.get(chip.value);
      if (email === undefined) {
        outcomes.push({ status: 422, notice: html`Couldn't add ${label}.` });
        continue;
      }
      outcomes.push(await inviteOne(email, label, chip));
    }

    const failed = outcomes.filter((o) => o.status !== 200);
    const status = failed[0]?.status ?? 200;
    const one = outcomes.length === 1 ? outcomes[0] : undefined;
    return reply(
      status,
      one !== undefined
        ? html`<p${one.status === 200 ? "" : html` class="error"`}>${one.notice}</p>`
        : html`<ul>${outcomes.map((o) => html`<li${o.status === 200 ? "" : html` class="error"`}>${o.notice}</li>`)}</ul>`,
    );
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
<p><strong>${preview.inviter.name}</strong> invited <strong>${preview.email}</strong>.</p>
${
  signedIn !== null && signedIn.email !== preview.email && preview.newcomer
    ? html`<p class="muted">You're signed in as ${signedIn.email}. Joining also signs this browser in as ${preview.email}, and you can switch between them from the menu at the top.</p>`
    : preview.newcomer
      ? html`<p class="muted">Joining also signs you in as ${preview.email}.</p>`
      : html`<p class="muted">Joining adds ${preview.email} to the group. To see it, you then sign in as that address.</p>`
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
    const here = c.get("accounts").some((a) => a.personId === accepted.personId);
    // An account that has signed in before is joined, never signed in (rc42): a forwarded or
    // week-old invite must not open what that account already holds. The group was shown on
    // the invite's own page, so naming it tells the link's holder nothing new.
    if (!here && !accepted.newcomer)
      return c.html(
        page(
          c,
          "Joined",
          html`<h1>You've joined “${accepted.groupName}”</h1>
<p><a href="${SIGN_IN_PATH}">Sign in</a> to see it.</p>`,
        ),
      );
    if (!here && !(await signInAs(c, deps, accepted.personId, "invite"))) {
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
