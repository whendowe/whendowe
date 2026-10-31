// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { ZodError } from "zod";
import type { StoragePort } from "../../db/port.js";
import {
  appearanceIn,
  type Container,
  findPersonById,
  handleSchema,
  setAccountHandle,
  setAppearance,
} from "../../people/person.js";
import { ACCOUNT_PATH, appearanceForm, html } from "../layout.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  requireSignedIn,
  type SessionDeps,
  verifyFormCsrf,
} from "../session.js";

// Your account (DESIGN §10 rc21 *Privacy basics*): the handle others see by default.
// Export and deleting the account join this page in later slices (R3).
//
//   GET  /account   your handle
//   POST /account   change it
//
// And the POST every group, event and thread page uses for "you appear here as…"
// (saveAppearance below), so the three behave the same.

export { ACCOUNT_PATH };

function accountForm(csrf: string, handle: string, error: string | null) {
  return html`<h1>Your name</h1>
<p class="muted">This is the name people see in your groups, events and plans. Nobody sees your email address unless you choose to show it, one group, event or plan at a time.</p>
${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${ACCOUNT_PATH}">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><label>Your name<br /><input name="handle" maxlength="40" required value="${handle}" /></label></p>
  <p><button type="submit">Save</button></p>
</form>`;
}

/** The first ZodError message, for a form; anything else is a bug and propagates. */
function reason(error: unknown): string {
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Please check that.";
  throw error;
}

export function registerAccountRoutes(app: Hono<AppEnv>, deps: SessionDeps): void {
  app.get(ACCOUNT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const person = await findPersonById(deps.storage, me.personId);
    return c.html(page(c, "Your name", accountForm(me.csrfToken, person?.displayName ?? "", null)));
  });

  app.post(ACCOUNT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const raw = typeof form.handle === "string" ? form.handle : "";
    const parsed = handleSchema.safeParse(raw);
    if (!parsed.success) {
      return c.html(
        page(c, "Your name", accountForm(me.csrfToken, raw.slice(0, 40), reason(parsed.error))),
        400,
      );
    }
    await setAccountHandle(deps.storage, me.personId, parsed.data);
    return c.redirect("/", 303);
  });
}

/**
 * The "you appear here as…" POST, shared by group, event and thread pages. The caller
 * has checked the signed-in person may see the container; CSRF is checked here.
 */
export async function saveAppearance(
  c: Context<AppEnv>,
  storage: StoragePort,
  container: Container,
  back: string,
) {
  const me = requireSignedIn(c);
  if (me instanceof Response) return me;
  const form = await c.req.parseBody();
  if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
  try {
    const saved = await setAppearance(storage, container, me.personId, {
      handle: typeof form.handle === "string" ? form.handle : "",
      showEmail: form.show_email === "1",
    });
    if (!saved) return c.notFound();
  } catch (error) {
    return c.html(
      page(
        c,
        "Not saved",
        html`<h1>That name didn't work</h1><p class="error">${reason(error)}</p><p><a href="${back}">← Back</a></p>`,
      ),
      400,
    );
  }
  return c.redirect(back, 303);
}

/** The "you appear here as…" section for a container's page; empty if not a member. */
export async function appearanceSection(
  storage: StoragePort,
  container: Container,
  me: { readonly personId: string; readonly csrfToken: string },
  action: string,
  here: string,
) {
  const a = await appearanceIn(storage, container, me.personId);
  return a === null
    ? ""
    : appearanceForm({
        action,
        csrf: me.csrfToken,
        handle: a.handle,
        accountHandle: a.accountHandle,
        showEmail: a.showEmail,
        shownName: a.shown.name,
        here,
      });
}
