// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { ZodError } from "zod";
import type { StoragePort } from "../../db/port.js";
import { signOutActive } from "../../people/accounts.js";
import {
  appearanceIn,
  type Container,
  findPersonById,
  handleSchema,
  setAccountHandle,
  setAppearance,
} from "../../people/person.js";
import {
  type ConnectionToRevoke,
  connectionsOf,
  eraseAccount,
  erasePreview,
  FORMER_MEMBER,
} from "../../privacy/erasure.js";
import { exportPerson } from "../../privacy/export.js";
import { ACCOUNT_PATH, appearanceForm, html } from "../layout.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  requireSignedIn,
  type SessionDeps,
  verifyFormCsrf,
  writeAccountsCookie,
} from "../session.js";

// Your account (DESIGN §10 rc21 *Privacy basics*): the handle others see by default,
// your data, and deleting the account.
//
//   GET  /account          your handle
//   POST /account          change it
//   GET  /account/export   everything about you, as one JSON file (a read: GET)
//   GET  /account/delete   what deleting it would take with it
//   POST /account/delete   delete it, once you've typed your address
//
// And the POST every group, event and thread page uses for "you appear here as…"
// (saveAppearance below), so the three behave the same.

export { ACCOUNT_PATH };
export const EXPORT_PATH = `${ACCOUNT_PATH}/export`;
export const DELETE_ACCOUNT_PATH = `${ACCOUNT_PATH}/delete`;

export interface AccountOptions {
  /**
   * Revoke this person's calendar grants at the provider, before their tokens are
   * deleted. Present when the instance has Google credentials (app.ts).
   */
  readonly revokeCalendars?: (connections: readonly ConnectionToRevoke[]) => Promise<void>;
}

function accountForm(csrf: string, handle: string, error: string | null) {
  return html`<h1>Your name</h1>
<p class="muted">This is the name people see in your groups, events and plans. Nobody sees your email address unless you choose to show it, one group, event or plan at a time.</p>
${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${ACCOUNT_PATH}">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><label>Your name<br /><input name="handle" maxlength="40" required value="${handle}" /></label></p>
  <p><button type="submit">Save</button></p>
</form>
<h2>Your data</h2>
<p><a href="${EXPORT_PATH}">Download everything about you</a> <span class="muted">(one file: your groups, events, plans and what you said in them)</span></p>
<p><a href="${DELETE_ACCOUNT_PATH}">Delete your account</a></p>`;
}

/** The first ZodError message, for a form; anything else is a bug and propagates. */
function reason(error: unknown): string {
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Please check that.";
  throw error;
}

export function registerAccountRoutes(
  app: Hono<AppEnv>,
  deps: SessionDeps,
  options: AccountOptions = {},
): void {
  app.get(EXPORT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    c.header("Cache-Control", "no-store");
    c.header("Content-Disposition", 'attachment; filename="whendowe-data.json"');
    return c.json(await exportPerson(deps.storage, me.personId, deps.now()));
  });

  app.get(DELETE_ACCOUNT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const p = await erasePreview(deps.storage, me.personId);
    const loses: string[] = [];
    if (p.eventsDeleted > 0)
      loses.push(
        `${p.eventsDeleted} ${p.eventsDeleted === 1 ? "event only you can edit" : "events only you can edit"} will be deleted${
          p.peopleAffected > 0
            ? `, for ${p.peopleAffected} other ${p.peopleAffected === 1 ? "person" : "people"} too`
            : ""
        }`,
      );
    if (p.groupsDeleted > 0)
      loses.push(
        `${p.groupsDeleted} ${p.groupsDeleted === 1 ? "group" : "groups"} with nobody else in will be deleted`,
      );
    if (p.threadsDeleted > 0)
      loses.push(
        `${p.threadsDeleted} ${p.threadsDeleted === 1 ? "plan" : "plans"} with nobody else in will be deleted`,
      );
    return c.html(
      page(
        c,
        "Delete your account",
        html`<h1>Delete your account?</h1>
<p>Everything that is yours goes: your name, your address, your answers, votes and notes, your drafts and your calendar connections. You're signed out of it everywhere.</p>
<p>In other people's events and plans, what you changed stays, but it says <strong>${FORMER_MEMBER}</strong> — a different one in each, so nobody can tell they were all you.</p>
${loses.length === 0 ? "" : html`<p class="error">${loses.join(". ")}. To keep them for the others, make someone else an editor, or leave them to someone, first.</p>`}
<p class="muted">Copies in our backups are gone within 35 days. <a href="${EXPORT_PATH}">Download your data</a> first if you want it.</p>
<form method="post" action="${DELETE_ACCOUNT_PATH}">
  <input type="hidden" name="csrf" value="${me.csrfToken}" />
  <p><label>To confirm, type your email address<br /><input name="confirm" type="email" autocomplete="off" required /></label></p>
  <p><button type="submit">Delete my account</button> <a href="${ACCOUNT_PATH}">Keep it</a></p>
</form>`,
      ),
    );
  });

  app.post(DELETE_ACCOUNT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const typed = typeof form.confirm === "string" ? form.confirm.trim().toLowerCase() : "";
    if (typed !== me.email) {
      return c.html(
        page(
          c,
          "Not deleted",
          html`<h1>Nothing was deleted</h1><p>That isn't the address of the account you're using. <a href="${DELETE_ACCOUNT_PATH}">Try again</a></p>`,
        ),
        400,
      );
    }
    if (options.revokeCalendars !== undefined)
      await options.revokeCalendars(await connectionsOf(deps.storage, me.personId));
    await eraseAccount(deps.storage, me.personId, { now: deps.now() });
    // Its sessions are gone; drop it from this browser too. Other accounts here stay.
    const { accounts } = signOutActive(c.get("accounts"));
    writeAccountsCookie(c, accounts, deps.secureCookies);
    return c.html(
      page(
        c,
        "Account deleted",
        html`<h1>Your account is deleted</h1><p>Thank you for using WhenDoWe.</p><p><a href="/">Home</a></p>`,
      ),
    );
  });

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
