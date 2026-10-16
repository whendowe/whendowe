// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Hono } from "hono";
import type { StoragePort } from "../../db/port.js";
import { createGroup, findGroupForMember, listGroupsFor, listMembers } from "../../people/group.js";
import { html, renderPage } from "../layout.js";
import { type AppEnv, requireSignedIn, verifyFormCsrf } from "../session.js";

// Groups (MVP-1 slice D1). Every route needs a signed-in person; every group page
// goes through findGroupForMember, which is the only way to read a group at all, so
// a non-member gets the same 404 as a group that does not exist (§13: no IDOR, and
// no confirming that a group exists to someone outside it).

export const GROUPS_PATH = "/groups";

export interface GroupDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
}

function notFound() {
  return renderPage(
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
      renderPage(
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
      return c.html(
        renderPage("Request rejected", html`<h1>Request rejected</h1><p>Please try again.</p>`),
        403,
      );
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
      return c.html(
        renderPage("New group", createForm(me.csrfToken, raw.slice(0, 80), message)),
        400,
      );
    }
  });

  app.get(`${GROUPS_PATH}/:id`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const membership = await findGroupForMember(deps.storage, c.req.param("id"), me.personId);
    if (membership === null) return c.html(notFound(), 404);
    const members = await listMembers(deps.storage, membership);
    return c.html(
      renderPage(
        membership.group.name,
        html`<p><a href="${GROUPS_PATH}">← Your groups</a></p>
<h1>${membership.group.name}</h1>
<h2>People</h2>
<ul>${members.map(
          (m) =>
            html`<li>${m.displayName ?? m.email}${m.personId === me.personId ? " (you)" : ""}${m.role === "organizer" ? html` <span class="muted">· organizer</span>` : ""}</li>`,
        )}</ul>
${membership.role === "organizer" ? html`<p class="muted">Inviting people arrives in the next slice.</p>` : ""}`,
      ),
    );
  });
}
