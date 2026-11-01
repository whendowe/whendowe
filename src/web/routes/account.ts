// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { ZodError, z } from "zod";
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
  DELETION_WAIT_MS,
  deleteNow,
  erasePreview,
  FORMER_MEMBER,
  keepAccount,
  keepOwnAccount,
  peekDeletion,
  type RevokeCalendars,
  requestDeletion,
} from "../../privacy/erasure.js";
import { exportPerson } from "../../privacy/export.js";
import {
  deleteEverything,
  OPT_OUT_PATH,
  type OptOutLink,
  peekOptOut,
  suppress,
} from "../../privacy/suppression.js";
import { ACCOUNT_PATH, appearanceForm, deletionDay, html, KEEP_ACCOUNT_PATH } from "../layout.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  requireSignedIn,
  verifyFormCsrf,
  writeAccountsCookie,
} from "../session.js";
import type { AuthDeps } from "./auth.js";

// Your account (DESIGN §10 rc21 *Privacy basics*): the handle others see by default,
// your data, and deleting the account.
//
//   GET  /account          your handle
//   POST /account          change it
//   GET  /account/export   everything about you, as one JSON file (a read: GET)
//   GET  /account/delete   what deleting it would take with it
//   POST /account/delete   ask for it to be deleted, once you've typed your address:
//                          signed out everywhere, emailed, deleted in 7 days (rc22)
//   POST /account/keep     keep it, signed in during the wait
//   GET  /account/deletion the emailed link: keep it, or delete it now (GET renders)
//   POST /account/deletion …and acts
//   GET  /opt-out          the link in every email someone else caused (rc24): stop
//                          their mail, a group's, or everyone's; delete everything if
//                          the address never signed in
//   POST /opt-out          …and acts
//
// And the POST every group, event and thread page uses for "you appear here as…"
// (saveAppearance below), so the three behave the same.

export { ACCOUNT_PATH };
export const EXPORT_PATH = `${ACCOUNT_PATH}/export`;
export const DELETE_ACCOUNT_PATH = `${ACCOUNT_PATH}/delete`;
export const DELETION_LINK_PATH = `${ACCOUNT_PATH}/deletion`;
export { KEEP_ACCOUNT_PATH };

export interface AccountOptions {
  /**
   * Revoke this person's calendar grants at the provider, before their tokens are
   * deleted. Present when the instance has Google credentials (app.ts).
   */
  readonly revokeCalendars?: RevokeCalendars;
}

const WAIT_DAYS = DELETION_WAIT_MS / (24 * 60 * 60 * 1000);

const tokenSchema = z.string().min(1).max(256);

/** The emailed link's pages carry its token: out of Referer headers and every cache. */
function sensitive(c: Context): void {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
}

function linkGonePage(c: Context<AppEnv>) {
  return page(
    c,
    "Link no longer works",
    html`<h1>This link no longer works</h1>
<p>The account was kept, or it has already been deleted. To delete an account, sign in and choose <em>Delete your account</em>.</p>`,
  );
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

function optOutGonePage(c: Context<AppEnv>) {
  return page(
    c,
    "Link no longer works",
    html`<h1>This link has expired</h1>
<p>Each email has its own link, and it works for 90 days. If these emails keep coming, the newest one has a link that works.</p>`,
  );
}

/** Who sent it and through which group, named as that group sees them; null if gone. */
async function optOutNames(storage: StoragePort, link: OptOutLink) {
  const group =
    link.groupId === null
      ? null
      : (z
          .object({ name: z.string() })
          .optional()
          .parse(
            (
              await storage.query({
                sql: "SELECT name FROM person_group WHERE id = ?",
                params: [link.groupId],
              })
            )[0],
          )?.name ?? null);
  let sender: string | null = null;
  if (link.senderId !== null) {
    const inGroup =
      link.groupId === null
        ? null
        : await appearanceIn(storage, { kind: "group", id: link.groupId }, link.senderId);
    const person = await findPersonById(storage, link.senderId);
    sender =
      inGroup?.shown.name ??
      person?.displayName ??
      (person === null ? null : "the person who sent it");
  }
  return { group, sender };
}

/** The first ZodError message, for a form; anything else is a bug and propagates. */
function reason(error: unknown): string {
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Please check that.";
  throw error;
}

export function registerAccountRoutes(
  app: Hono<AppEnv>,
  deps: AuthDeps,
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
    if (me.deletesAt !== null) {
      return c.html(
        page(
          c,
          "Delete your account",
          html`<h1>Your account is being deleted</h1>
<p>It will be deleted on ${deletionDay(me.deletesAt)}. Until then nothing changes for anyone else, and you can still <a href="${EXPORT_PATH}">download your data</a>.</p>`,
        ),
      );
    }
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
<p>It happens ${WAIT_DAYS} days after you confirm. You're signed out everywhere straight away, and we email you a link to keep the account, or to delete it at once. Nothing is kept to bring it back afterwards: <a href="${EXPORT_PATH}">download your data</a> first if you want it.</p>
<p class="muted">Copies in our backups are gone within 35 days after that.</p>
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
    const asked = await requestDeletion(deps.storage, me.personId, deps.now());
    const day = deletionDay(asked.eraseAfter);
    // From the configured origin, never the Host header (auth.ts explains why).
    const link = new URL(DELETION_LINK_PATH, deps.publicBaseUrl);
    link.searchParams.set("t", asked.token);
    let mailed = true;
    try {
      await deps.mail.send({
        to: me.email,
        subject: `Your WhenDoWe account will be deleted on ${day}`,
        cause: { kind: "self" },
        text: [
          `You asked to delete your WhenDoWe account, ${me.email}. It will be deleted on ${day}.`,
          "",
          "To keep it, or to delete it now instead:",
          "",
          link.toString(),
          "",
          "You've been signed out everywhere. If you didn't ask for this, open the link and keep your account: someone else may have used it.",
        ].join("\n"),
      });
    } catch {
      // The request stands either way (§10 rc22); the page says the email didn't go.
      mailed = false;
    }
    // Its sessions are revoked; drop it from this browser too. Other accounts here stay.
    const { accounts } = signOutActive(c.get("accounts"));
    writeAccountsCookie(c, accounts, deps.secureCookies);
    return c.html(
      page(
        c,
        "Account to be deleted",
        html`<h1>Your account will be deleted on ${day}</h1>
<p>You're signed out of it everywhere.</p>
${
  mailed
    ? html`<p>We've emailed ${me.email} a link to keep it, or to delete it now.</p>`
    : html`<p class="error">We couldn't email you just now. To keep the account, sign in again before then.</p>`
}
<p><a href="/">Home</a></p>`,
      ),
    );
  });

  app.post(KEEP_ACCOUNT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    await keepOwnAccount(deps.storage, me.personId);
    return c.redirect(ACCOUNT_PATH, 303);
  });

  app.get(DELETION_LINK_PATH, async (c) => {
    sensitive(c);
    const token = tokenSchema.safeParse(c.req.query("t"));
    const pending = token.success ? await peekDeletion(deps.storage, token.data) : null;
    if (!token.success || pending === null) return c.html(linkGonePage(c), 400);
    const button = (action: string, label: string) =>
      html`<form method="post" action="${DELETION_LINK_PATH}">
  <input type="hidden" name="t" value="${token.data}" />
  <input type="hidden" name="do" value="${action}" />
  <p><button type="submit">${label}</button></p>
</form>`;
    return c.html(
      page(
        c,
        "Your account",
        html`<h1>${pending.email} will be deleted on ${deletionDay(pending.eraseAfter)}</h1>
${button("keep", "Keep my account")}
<p class="muted">or, if you want it gone now — this can't be undone:</p>
${button("now", "Delete it now")}`,
      ),
    );
  });

  app.post(DELETION_LINK_PATH, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = tokenSchema.safeParse(form.t);
    if (!token.success) return c.html(linkGonePage(c), 400);
    if (form.do === "keep") {
      if (!(await keepAccount(deps.storage, token.data))) return c.html(linkGonePage(c), 400);
      return c.html(
        page(
          c,
          "Account kept",
          html`<h1>Your account is kept</h1><p>Nothing was deleted. <a href="/auth/sign-in">Sign in</a> to use it.</p>`,
        ),
      );
    }
    if (form.do !== "now") return c.html(linkGonePage(c), 400);
    const deleted = await deleteNow(deps.storage, token.data, {
      now: deps.now(),
      revokeCalendars: options.revokeCalendars,
    });
    if (!deleted) return c.html(linkGonePage(c), 400);
    return c.html(
      page(
        c,
        "Account deleted",
        html`<h1>Your account is deleted</h1><p>Thank you for using WhenDoWe.</p><p><a href="/">Home</a></p>`,
      ),
    );
  });

  // The opt-out link (rc24). No session: the link is the authority, re-checked on POST.
  app.get(OPT_OUT_PATH, async (c) => {
    sensitive(c);
    const token = tokenSchema.safeParse(c.req.query("t"));
    const link = token.success ? await peekOptOut(deps.storage, token.data, deps.now()) : null;
    if (!token.success || link === null) return c.html(optOutGonePage(c), 400);
    const names = await optOutNames(deps.storage, link);
    const button = (action: string, label: string) =>
      html`<form method="post" action="${OPT_OUT_PATH}">
  <input type="hidden" name="t" value="${token.data}" />
  <input type="hidden" name="do" value="${action}" />
  <p><button type="submit">${label}</button></p>
</form>`;
    return c.html(
      page(
        c,
        "Stop these emails",
        html`<h1>Stop emails to ${link.email}</h1>
<p class="muted">Sign-in links you ask for yourself still arrive: none of these stop you signing in.</p>
${names.sender === null ? "" : button("person", `Stop emails from ${names.sender}`)}
${names.group === null ? "" : button("group", `Stop emails through “${names.group}”`)}
${button("all", "Stop emails from anyone on WhenDoWe")}
${
  link.neverSignedIn
    ? html`<h2>Or delete everything</h2>
<p>This address has never signed in. Deleting removes it from every group, event and plan it was added to, at once, and stops all email to it. This can't be undone.</p>
${button("delete", "Delete everything about this address")}`
    : html`<p class="muted">This address has an account: to delete it, sign in and choose <a href="${DELETE_ACCOUNT_PATH}">Delete your account</a>.</p>`
}`,
      ),
    );
  });

  app.post(OPT_OUT_PATH, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = tokenSchema.safeParse(form.t);
    const now = deps.now();
    const link = token.success ? await peekOptOut(deps.storage, token.data, now) : null;
    if (link === null) return c.html(optOutGonePage(c), 400);
    const done = (what: string) => c.html(page(c, "Done", html`<h1>Done</h1><p>${what}</p>`));
    // The scope comes from the link, never the form: a link stops only what it came with.
    if (form.do === "person" && link.senderId !== null) {
      await suppress(deps.storage, link.email, { kind: "person", id: link.senderId }, now);
      return done("You won't get email from that person any more.");
    }
    if (form.do === "group" && link.groupId !== null) {
      await suppress(deps.storage, link.email, { kind: "group", id: link.groupId }, now);
      return done("You won't get email through that group any more.");
    }
    if (form.do === "all") {
      await suppress(deps.storage, link.email, { kind: "all" }, now);
      return done(
        "You won't get email from anyone on WhenDoWe. Sign-in links you ask for still arrive.",
      );
    }
    if (form.do === "delete") {
      if (!(await deleteEverything(deps.storage, link.email, now)))
        return c.html(
          page(
            c,
            "Not deleted",
            html`<h1>Nothing was deleted</h1><p>This address has an account now. To delete it, sign in and choose <a href="${DELETE_ACCOUNT_PATH}">Delete your account</a>.</p>`,
          ),
          409,
        );
      return done(
        "Everything about this address is deleted, and no more email will be sent to it.",
      );
    }
    return c.html(optOutGonePage(c), 400);
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
