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
import { listSessions, type SessionSummary, type SessionVia } from "../../people/session.js";
import { deviceSignInLink } from "../../people/setup.js";
import {
  type CalendarGrants,
  copiesSchema,
  DELETION_WAIT_MS,
  deleteNow,
  erasePreview,
  FORMER_MEMBER,
  googleCopiesOf,
  keepAccount,
  keepOwnAccount,
  peekDeletion,
  requestDeletion,
} from "../../privacy/erasure.js";
import { exportPerson } from "../../privacy/export.js";
import {
  deleteEverything,
  OPT_OUT_PATH,
  type OptOutLink,
  type OptOutView,
  optOutsOf,
  pairWarning,
  peekOptOut,
  suppress,
  undoOptOut,
} from "../../privacy/suppression.js";
import {
  ACCOUNT_PATH,
  appearanceForm,
  deletionDay,
  type Html,
  html,
  KEEP_ACCOUNT_PATH,
  SHARE_BUTTONS,
  shareBox,
} from "../layout.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  requireSignedIn,
  type SignedIn,
  verifyFormCsrf,
  writeAccountsCookie,
} from "../session.js";
import { type AuthDeps, CONFIRM_PATH } from "./auth.js";
import { feedSection } from "./feeds.js";

// Your account (DESIGN §10 rc21 *Privacy basics*): the handle others see by default,
// your data, and deleting the account.
//
//   GET  /account          your handle
//   POST /account          change it
//   GET  /account/export   everything about you, as one JSON file (a read: GET)
//   GET  /account/delete   what deleting it would take with it
//   POST /account/delete   ask for it to be deleted, once you've typed your address:
//                          signed out everywhere, emailed, deleted in 7 days (rc22)
//   POST /account/device   Sign in on another device (rc60): a sign-in link for this account,
//                          shown once on the page this POST returns, 15 minutes, used once
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
export const EMAIL_AGAIN_PATH = `${ACCOUNT_PATH}/email-again`;
export { KEEP_ACCOUNT_PATH };

export interface AccountOptions {
  /**
   * This person's calendar grants at the provider: revoked before their tokens are deleted,
   * and the WhenDoWe calendar deleted if asked. Present with Google credentials (app.ts).
   */
  readonly calendars?: CalendarGrants;
}

const events = (n: number) => (n === 1 ? "1 WhenDoWe event" : `${n} WhenDoWe events`);

/**
 * What happens to the copies in Google (rc40): the same question as disconnecting, with
 * Remove them chosen. Asked of a connection Google still answers for; for one it refuses,
 * the page says to remove them in Google yourself. Being disconnected already, nothing.
 */
async function copiesQuestion(storage: StoragePort, personId: string) {
  const conn = await googleCopiesOf(storage, personId);
  if (conn === null || conn.status === "disconnected") return "";
  if (conn.status !== "active") {
    return conn.copies === 0
      ? ""
      : html`<p class="error">Google stopped accepting WhenDoWe's access, so the ${events(conn.copies)} in your Google calendar can't be removed from here: remove them in Google Calendar yourself.</p>`;
  }
  const option = (value: string, label: string, checked: boolean) =>
    html`<label><input type="radio" name="copies" value="${value}"${checked ? " checked" : ""} /> ${label}</label><br />`;
  return html`<fieldset>
  <legend>Your WhenDoWe events in your Google calendar${conn.copies === 0 ? "" : html` (${events(conn.copies)} now)`}</legend>
  ${option("remove", "Remove them", true)}
  ${option("keep", "Keep them", false)}
  ${conn.madeByUs ? option("calendar", "Delete the WhenDoWe calendar", false) : ""}
  <span class="muted">On the day, before the account goes. Kept, they're no longer updated.</span>
</fieldset>`;
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

/**
 * The opt-outs on your own address, each with an undo (rc24). A person you stopped is not
 * named: the only name we could give is one from a single group or event, which this page,
 * about the whole account, would join to the rest.
 */
function optOutSection(csrf: string, optOuts: readonly OptOutView[]): Html | string {
  if (optOuts.length === 0) return "";
  const what = (o: OptOutView) =>
    o.scope === "all"
      ? "Email from anyone on WhenDoWe"
      : o.scope === "group"
        ? `Email through “${o.groupName ?? "a group"}”`
        : `Email from one person, stopped on ${o.createdAt.slice(0, 10)}`;
  return html`<h2>Email you stopped</h2>
<p class="muted">Sign-in links you ask for always arrive.</p>
<ul>${optOuts.map(
    (
      o,
    ) => html`<li>${what(o)} <form method="post" action="${EMAIL_AGAIN_PATH}" style="display:inline">
  <input type="hidden" name="csrf" value="${csrf}" />
  <input type="hidden" name="scope" value="${o.scope}" />
  <input type="hidden" name="scope_id" value="${o.scopeId}" />
  <button type="submit">Email me again</button></form></li>`,
  )}</ul>`;
}

/** rc60: Sign in on another device. A POST, so a page that shows the link can't be made by looking. */
export const DEVICE_SIGN_IN_PATH = "/account/device";

/** How each session was made (rc42, rc60), as the account page's list says it. */
const MADE_BY: Record<SessionVia, string> = {
  magic: "by an emailed sign-in link",
  google: "with Google",
  invite: "by a group invite",
  setup: "by the setup link",
  console: "by a sign-in link from whoever runs this instance",
  device: "by Sign in on another device",
};

/** Where you're signed in (rc60): when each began and how, this browser marked. */
function sessionsSection(sessions: readonly SessionSummary[], thisOne: string): Html {
  return html`<h2>Where you're signed in</h2>
<ul>${sessions.map(
    (s) =>
      html`<li>Since ${s.createdAt.slice(0, 16).replace("T", " ")} UTC, ${s.via === null ? "how isn't recorded" : MADE_BY[s.via]}${s.id === thisOne ? html` <strong>· this browser</strong>` : ""}</li>`,
  )}</ul>`;
}

function deviceSection(csrf: string): Html {
  return html`<h2>Sign in on another device</h2>
<p class="muted">A link that signs this account in on your phone or another computer. It works once, for 15 minutes.</p>
<form method="post" action="${DEVICE_SIGN_IN_PATH}">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><button type="submit">Make a sign-in link</button></p>
</form>`;
}

function accountForm(
  csrf: string,
  handle: string,
  error: string | null,
  optOuts: readonly OptOutView[],
  feed: Html | string,
  /** rc60: Sign in on another device, and where this account is signed in. */
  signedIn: Html,
) {
  return html`<h1>Your name</h1>
<p class="muted">This is the name people see in your groups, events and plans. Nobody sees your email address unless you choose to show it, one group, event or plan at a time.</p>
${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${ACCOUNT_PATH}">
  <input type="hidden" name="csrf" value="${csrf}" />
  <p><label>Your name<br /><input name="handle" maxlength="40" required value="${handle}" /></label></p>
  <p><button type="submit">Save</button></p>
</form>
${feed}
${signedIn}
<h2>Your data</h2>
<p><a href="${EXPORT_PATH}">Download everything about you</a> <span class="muted">(one file: your groups, events, plans and what you said in them)</span></p>
<p><a href="${DELETE_ACCOUNT_PATH}">Delete your account</a></p>
${optOutSection(csrf, optOuts)}`;
}

function optOutGonePage(c: Context<AppEnv>) {
  return page(
    c,
    "Link no longer works",
    html`<h1>This link has expired</h1>
<p>Each email has its own link, and it works for 90 days. If these emails keep coming, the newest one has a link that works.</p>`,
  );
}

/**
 * Which of this link's own opt-outs — its sender, its group — the address has made, to start
 * again (rc51). Never "everyone": that one took the link with it (rc24).
 */
async function stoppedFrom(
  storage: StoragePort,
  link: OptOutLink,
): Promise<ReadonlySet<"all" | "group" | "person">> {
  const made = (await optOutsOf(storage, link.email)).filter(
    (o) =>
      (o.scope === "person" && o.scopeId === link.senderId) ||
      (o.scope === "group" && o.scopeId === link.groupId),
  );
  return new Set(made.map((o) => o.scope));
}

/**
 * Who sent it and through which group, named as that group sees them; null if gone. Never
 * by the sender's account name: someone may be "Kestrel" in one group and "Lena" in
 * another, and this page must not join the two (§10 rc21).
 */
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
  if (link.senderId === null || (await findPersonById(storage, link.senderId)) === null)
    return { group, sender: null };
  const inGroup =
    link.groupId === null
      ? null
      : await appearanceIn(storage, { kind: "group", id: link.groupId }, link.senderId);
  return { group, sender: inGroup?.shown.name ?? "the person who sent this" };
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
<p>It happens ${WAIT_DAYS} days after you confirm. You're signed out everywhere straight away, ${deps.noMail === true ? "and to keep the account you sign in again before then" : "and we email you a link to keep the account, or to delete it at once"}. Nothing is kept to bring it back afterwards: <a href="${EXPORT_PATH}">download your data</a> first if you want it.</p>
<p class="muted">Copies in our backups are gone within 35 days after that.</p>
<form method="post" action="${DELETE_ACCOUNT_PATH}">
  <input type="hidden" name="csrf" value="${me.csrfToken}" />
  <p><label>To confirm, type your email address<br /><input name="confirm" type="email" autocomplete="off" required /></label></p>
  ${await copiesQuestion(deps.storage, me.personId)}
  <p><label><input type="checkbox" name="suppress" value="1" /> Also stop anyone emailing this address</label><br />
  <span class="muted">Without it, someone could add the address again later, as a new person.</span></p>
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
    // No question asked (no connection), Remove them stands; anything else is refused.
    const copies = copiesSchema.default("remove").safeParse(form.copies);
    if (!copies.success) {
      return c.html(
        page(
          c,
          "Not deleted",
          html`<h1>Nothing was deleted</h1><p>That isn't one of the choices. <a href="${DELETE_ACCOUNT_PATH}">Try again</a></p>`,
        ),
        400,
      );
    }
    const asked = await requestDeletion(deps.storage, me.personId, deps.now(), {
      suppress: form.suppress === "1",
      copies: copies.data,
    });
    const day = deletionDay(asked.eraseAfter);
    // From the configured origin, never the Host header (auth.ts explains why).
    const link = new URL(DELETION_LINK_PATH, deps.publicBaseUrl);
    link.searchParams.set("t", asked.token);
    // rc60: with no email there is nothing to send; signing in again keeps the account.
    let mailed = deps.noMail !== true;
    if (mailed)
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
    : deps.noMail === true
      ? html`<p>To keep it, sign in again before then. This instance doesn't send email, so ask whoever runs it for a sign-in link.</p>`
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
      calendars: options.calendars,
    });
    if (deleted === "gone") return c.html(linkGonePage(c), 400);
    if (deleted === "removing") {
      return c.html(
        page(
          c,
          "Account being deleted",
          html`<h1>Your account is being deleted</h1><p>WhenDoWe is removing its events from your Google calendar first. Your account is deleted once they're gone, in a minute or two.</p><p><a href="/">Home</a></p>`,
        ),
      );
    }
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
    const stopped = await stoppedFrom(deps.storage, link);
    const pair = await pairWarning(deps.storage, link.email, link.senderId);
    const offered = [
      names.sender !== null && !stopped.has("person")
        ? button("person", `Stop emails from ${names.sender}`)
        : "",
      names.sender !== null && pair.sender
        ? button("links", `Stop emails — ${names.sender} can send me the link`)
        : "",
      names.group !== null && !stopped.has("group")
        ? button("group", `Stop emails through “${names.group}”`)
        : "",
      button("all", "Stop emails from anyone on WhenDoWe"),
    ];
    return c.html(
      page(
        c,
        "Stop these emails",
        html`<h1>Stop emails to ${link.email}</h1>
<p class="muted">Sign-in links you ask for yourself still arrive: none of these stop you signing in.</p>
${
  stopped.size === 0
    ? ""
    : html`<h2>You've stopped these emails</h2>
${stopped.has("person") && names.sender !== null ? button("again-person", `Start emails from ${names.sender} again`) : ""}
${stopped.has("group") && names.group !== null ? button("again-group", `Start emails through “${names.group}” again`) : ""}
`
}
${
  pair.warn
    ? html`<p class="attn">${
        pair.sender && names.sender !== null
          ? `${names.sender.charAt(0).toUpperCase()}${names.sender.slice(1)} will see in the history of a verified plan you share with only them that you stopped these emails, and when.`
          : "In a verified plan with only one other person, they'll see in its history that you stopped these emails, and when."
      }</p>`
    : ""
}
${offered}
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
    if (form.do === "links" && link.senderId !== null) {
      // Offered only where the sender is the other person in a verified plan of two (rc51).
      if (!(await pairWarning(deps.storage, link.email, link.senderId)).sender)
        return c.html(optOutGonePage(c), 400);
      await suppress(deps.storage, link.email, { kind: "person", id: link.senderId }, now, {
        prefersLinks: true,
      });
      return done(
        "You won't get email from that person any more. They'll see that you asked for the link instead.",
      );
    }
    // Starting them again (rc51): only what this link could have stopped. Stopping
    // everyone took this link with it (rc24), so that one starts again on the account page.
    if (form.do === "again-person" && link.senderId !== null) {
      await undoOptOut(deps.storage, link.email, "person", link.senderId, now);
      return done("Emails from that person will reach you again.");
    }
    if (form.do === "again-group" && link.groupId !== null) {
      await undoOptOut(deps.storage, link.email, "group", link.groupId, now);
      return done("Emails through that group will reach you again.");
    }
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

  // "Email me again" (rc24): undo one opt-out on your own address, never anyone else's.
  app.post(EMAIL_AGAIN_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const scope = z.enum(["all", "group", "person"]).safeParse(form.scope);
    const scopeId = z
      .string()
      .max(64)
      .safeParse(form.scope_id ?? "");
    if (!scope.success || !scopeId.success) return c.redirect(ACCOUNT_PATH, 303);
    await undoOptOut(deps.storage, me.email, scope.data, scopeId.data, deps.now());
    return c.redirect(ACCOUNT_PATH, 303);
  });

  const signedInSections = async (me: SignedIn) =>
    html`${deviceSection(me.csrfToken)}
${sessionsSection(await listSessions(deps.storage, me.personId, deps.now()), me.sessionId)}`;

  app.get(ACCOUNT_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const person = await findPersonById(deps.storage, me.personId);
    return c.html(
      page(
        c,
        "Your name",
        accountForm(
          me.csrfToken,
          person?.displayName ?? "",
          null,
          await optOutsOf(deps.storage, me.email),
          await feedSection(deps, { personId: me.personId, groupId: null }, me.csrfToken),
          await signedInSections(me),
        ),
      ),
    );
  });

  // rc60: Sign in on another device. The link is on the page this returns, and nowhere else.
  app.post(DEVICE_SIGN_IN_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const made = await deviceSignInLink(deps.storage, me.personId, { now: deps.now() });
    if (!made.ok) return c.redirect(ACCOUNT_PATH, 303);
    sensitive(c);
    // From the configured origin, never the request's Host (§13).
    const link = new URL(CONFIRM_PATH, deps.publicBaseUrl);
    link.searchParams.set("t", made.token);
    return c.html(
      page(
        c,
        "Sign in on another device",
        html`<h1>Sign in on another device</h1>
<p><strong>Anyone with this link can sign in as you until it's used.</strong> Open it on the other device, or send it only to yourself. It works once, for the next 15 minutes, and making another stops this one working.</p>
${shareBox("Your sign-in link", link.toString(), 2)}${SHARE_BUTTONS}
<p><a href="${ACCOUNT_PATH}">Back</a></p>`,
      ),
    );
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
        page(
          c,
          "Your name",
          accountForm(
            me.csrfToken,
            raw.slice(0, 40),
            reason(parsed.error),
            await optOutsOf(deps.storage, me.email),
            await feedSection(deps, { personId: me.personId, groupId: null }, me.csrfToken),
            await signedInSections(me),
          ),
        ),
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
