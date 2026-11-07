// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MailCapReachedError, SenderShareReachedError } from "../mail/capped.js";
import { RETAIN_CHOICES, retainLabel } from "../privacy/retention.js";
import { META_CONTENT_SECURITY_POLICY } from "./csp.js";
import { escapeHtml } from "./escape.js";

// The page shell, and a template tag that makes escaping the DEFAULT (§13).
//
// Before this, every page escaped by hand — escapeHtml(x) at each interpolation — and
// one forgotten call is an XSS hole. Here, `html` escapes every interpolated value
// unless it is itself an Html fragment produced by `html`. Raw HTML therefore has to
// be built from other `html` fragments; a plain string can never smuggle markup in.

/** HTML known to be safe: only ever constructed by the `html` tag below. */
export class Html {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

type Interpolation = Html | string | number | boolean | null | undefined | readonly Interpolation[];

function render(value: Interpolation): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  // null/undefined/false render as nothing, so `${cond && html`…`}` works.
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}

/** Tagged template: literal parts pass through, every interpolation is escaped. */
export function html(strings: TemplateStringsArray, ...values: readonly Interpolation[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + (strings[i + 1] ?? "");
  }
  return new Html(out);
}

/**
 * Who is looking (DESIGN §13 rc18): the header's view-model. Built per request from
 * this browser's accounts (src/web/session.ts `viewerOf`); never carries a token but
 * the active account's CSRF token, which every page already renders into its forms.
 */
export interface Viewer {
  readonly email: string;
  readonly csrfToken: string;
  /** The other accounts on this browser, each a switch button. */
  readonly others: readonly { readonly sessionId: string; readonly email: string }[];
  readonly canAddAccount: boolean;
  /** This page's path, so a switch comes back to it. */
  readonly here: string;
  /** When the active account will be deleted, if its deletion was asked for (§10 rc22). */
  readonly deletesAt: string | null;
}

// Paths the header posts to (src/web/routes/auth.ts registers them).
export const SWITCH_PATH = "/auth/switch";
export const SIGN_OUT_PATH = "/auth/sign-out";
export const SIGN_OUT_ALL_PATH = "/auth/sign-out-all";
export const ADD_ACCOUNT_PATH = "/auth/sign-in";
export const ACCOUNT_PATH = "/account";
export const KEEP_ACCOUNT_PATH = "/account/keep";
/** Plans (src/web/routes/plans.ts); here so routes that only link to it needn't import it. */
export const PLANS_PATH = "/plans";
/** Groups (src/web/routes/groups.ts); here for the same reason. */
export const GROUPS_PATH = "/groups";
/** Events (src/web/routes/events.ts); here for the same reason. */
export const EVENTS_PATH = "/events";

/** The day an account goes, as pages and mail say it: "2101-11-08 10:00 UTC". */
export function deletionDay(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * What a page says when mail went unsent because a cap was reached (§13 rc9, rc37, rc39):
 * the instance's, or this sender's share, and then when it comes back. `copy` adds that the
 * links can still be copied, where the page offers that (rc36).
 */
export function cappedText(error: MailCapReachedError, now: string, copy: boolean): string {
  if (!(error instanceof SenderShareReachedError))
    return "We can't send email right now. Please try again later.";
  const or = copy ? ", or copy their links to send yourself" : "";
  if (error.period === "month") {
    const next = new Date(`${now.slice(0, 7)}-01T00:00:00.000Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return `You've sent as much email this month as one person can. You can send more from ${next.toISOString().slice(0, 10)}${or}.`;
  }
  const first =
    error.newUntil === null
      ? "You've sent as much email today as one person can."
      : `New accounts send less email in their first week, until ${deletionDay(error.newUntil)}.`;
  return `${first} You can send more tomorrow${or}.`;
}

/** "Your account will be deleted on …", with a button to keep it (§10 rc22). */
export function deletionNotice(v: Pick<Viewer, "csrfToken">, deletesAt: string): Html {
  return html`<form class="wd-deleting error" method="post" action="${KEEP_ACCOUNT_PATH}">
  <input type="hidden" name="csrf" value="${v.csrfToken}" />
  <strong>This account will be deleted on ${deletionDay(deletesAt)}.</strong>
  <button type="submit">Keep my account</button>
</form>`;
}

/** A one-button form that makes another account on this browser active, then comes back here. */
export function switchForm(v: Viewer, to: { sessionId: string; email: string }): Html {
  return html`<form method="post" action="${SWITCH_PATH}"><input type="hidden" name="csrf" value="${v.csrfToken}" />
        <input type="hidden" name="session" value="${to.sessionId}" />
        <input type="hidden" name="back" value="${v.here}" />
        <button type="submit">Switch to <strong>${to.email}</strong></button>
      </form>`;
}

/**
 * Every signed-in page names the account in use, with a menu to switch, add one, or
 * sign out. Plain HTML: <details> opens it and each action is a POST form, so it works
 * without JavaScript (rc15).
 */
function accountHeader(v: Viewer): Html {
  const csrf = html`<input type="hidden" name="csrf" value="${v.csrfToken}" />`;
  return html`<header class="wd-top">
  <a class="wd-home" href="/">WhenDoWe</a>
  <details class="wd-who">
    <summary><span class="muted">Signed in as</span> <strong>${v.email}</strong></summary>
    <div class="wd-menu">
      <a href="${ACCOUNT_PATH}">Your name and account</a>
      ${v.others.map((o) => switchForm(v, o))}
      ${
        v.canAddAccount
          ? html`<a href="${ADD_ACCOUNT_PATH}">Add another account</a>`
          : html`<p class="muted">Four accounts are signed in here, the most one browser holds.</p>`
      }
      <form method="post" action="${SIGN_OUT_PATH}">${csrf}<button type="submit">Sign out of ${v.email}</button></form>
      ${
        v.others.length > 0
          ? html`<form method="post" action="${SIGN_OUT_ALL_PATH}">${csrf}<button type="submit">Sign out of all accounts on this browser</button></form>`
          : ""
      }
    </div>
  </details>
</header>`;
}

/**
 * A person as others see them in one group, event or thread (DESIGN §10 rc21): their
 * handle, and their address only where they chose to show it.
 */
export function who(shown: { readonly name: string; readonly email: string | null }): Html {
  return shown.email === null
    ? html`${shown.name}`
    : html`${shown.name} <span class="muted">${shown.email}</span>`;
}

/** How the viewer appears in one group, event or thread: its form (DESIGN §10 rc21). */
export interface AppearanceView {
  readonly action: string;
  readonly csrf: string;
  readonly handle: string | null;
  readonly accountHandle: string | null;
  readonly showEmail: boolean;
  readonly shownName: string;
  /** "group", "event", "plan": the word for where they are. */
  readonly here: string;
}

/** "You appear here as …": a handle for this one place, and whether these people see your address. */
export function appearanceForm(v: AppearanceView): Html {
  return html`<details class="wd-me"><summary>You appear here as <strong>${v.shownName}</strong>${
    v.showEmail ? " · your email is shown" : ""
  }</summary>
<form method="post" action="${v.action}">
  <input type="hidden" name="csrf" value="${v.csrf}" />
  <p><label>Your name in this ${v.here}<br /><input name="handle" maxlength="40" value="${v.handle ?? ""}" placeholder="${v.accountHandle ?? "Your name"}" /></label><br />
  <span class="muted">Leave it empty to use the name on <a href="${ACCOUNT_PATH}">your account</a>.</span></p>
  <p><label><input type="checkbox" name="show_email" value="1"${v.showEmail ? html` checked` : ""} /> Show my email address to the people in this ${v.here}</label></p>
  <p><button type="submit">Save</button></p>
</form></details>`;
}

/** How long something is kept, and — for whoever may change it — the form (DESIGN §10 rc23). */
export interface RetentionView {
  readonly days: number;
  /** "Events made in this group are" / "This event is". */
  readonly subject: string;
  /** "they end" / "it ends". */
  readonly ends: string;
  /** Null: this viewer may not change it. */
  readonly form: {
    readonly action: string;
    readonly csrf: string;
    readonly note: string | null;
  } | null;
}

export function retentionSection(v: RetentionView): Html {
  const kept = html`${v.subject} kept for <strong>${retainLabel(v.days)}</strong> after ${v.ends}, then deleted`;
  if (v.form === null) return html`<p class="muted wd-retention">${kept}.</p>`;
  return html`<details class="wd-retention"><summary>${kept}</summary>
<form method="post" action="${v.form.action}">
  <input type="hidden" name="csrf" value="${v.form.csrf}" />
  <p><label>Keep for
    <select name="retain_days">${RETAIN_CHOICES.map(
      (c) =>
        html`<option value="${c.days}"${c.days === v.days ? html` selected` : ""}>${c.label}</option>`,
    )}</select></label>
  <button type="submit">Save</button></p>
  ${v.form.note === null ? "" : html`<p class="muted">${v.form.note}</p>`}
</form></details>`;
}

/**
 * Something to paste into a chat (§10 rc25): its text, then Share… (the phone's share sheet)
 * and Copy, each shown only where the browser has it. Without them, or without JavaScript,
 * the text is there to select. Follow it with SHARE_BUTTONS once per page.
 */
export function shareBox(
  label: string,
  text: Html | string,
  rows = 2,
  /** False for a secret only its owner should hold, like a feed link: Copy, no Share… */
  share = true,
): Html {
  return html`<div class="share-box" data-share><textarea class="paste wide" rows="${String(rows)}" readonly aria-label="${label}">${text}</textarea>
<div class="row">${share ? html`<button type="button" data-share-sheet hidden>Share…</button>` : ""}<button type="button" data-copy hidden>Copy</button></div></div>`;
}

/**
 * A person's own answer link, copied by an organizer instead of emailed (DESIGN §10 rc36):
 * shown once, with what it is. Follow it with SHARE_BUTTONS.
 */
export function copiedLink(name: string, url: string, days: number, back: string): Html {
  return html`<h1>${name}'s link</h1>
<p><strong>This link answers as ${name}. Send it only to ${name}.</strong> Whoever opens it can answer for them, here and nowhere else. It never signs anyone in.</p>
${shareBox(`${name}'s link`, url, 2)}
<p class="muted">It works for ${String(days)} days. This is the only time it's shown: copying it again makes a new one, and this one stops working.</p>
<p><a href="${back}">Back</a></p>`;
}

/** Wires every shareBox on the page. One fixed script, so the CSP allows it by hash. */
export const SHARE_BUTTONS = html`<script>
  document.querySelectorAll("[data-share]").forEach(function (box) {
    var text = box.querySelector("textarea").value;
    var sheet = box.querySelector("[data-share-sheet]");
    var copy = box.querySelector("[data-copy]");
    if (sheet && navigator.share) {
      sheet.hidden = false;
      sheet.addEventListener("click", function () {
        navigator.share({ text: text }).catch(function () {});
      });
    }
    if (navigator.clipboard) {
      copy.hidden = false;
      copy.addEventListener("click", function () {
        navigator.clipboard.writeText(text).then(function () {
          copy.textContent = "Copied";
        });
      });
    }
  });
</script>`;

/**
 * Progressive enhancement only: suggest the browser's own zone for a new event, poll or
 * thread. One fixed script, so the CSP allows it by hash (csp.ts).
 */
export const ZONE_GUESS = html`<script>
  var tz = document.getElementById("tzid");
  if (tz && !tz.value) tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>`;

/**
 * What a chat app's card shows for a pasted link page (§10 rc25): the question's title and
 * its times, never the place, notes or people. Only link pages carry one.
 */
export interface Preview {
  readonly title: string;
  readonly description: string;
}

export function renderPage(
  title: string,
  body: Html,
  viewer: Viewer | null,
  preview: Preview | null = null,
): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${META_CONTENT_SECURITY_POLICY}" />
<title>${title} · WhenDoWe</title>
${
  preview === null
    ? ""
    : html`<meta property="og:type" content="website" />
<meta property="og:site_name" content="WhenDoWe" />
<meta property="og:title" content="${preview.title}" />
<meta property="og:description" content="${preview.description}" />
`
}<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; }
  input[type=email] { font: inherit; padding: .5rem; width: 100%; box-sizing: border-box; }
  button { font: inherit; padding: .5rem 1rem; cursor: pointer; }
  .muted { opacity: .7; }
  .error { color: #b3261e; }
  header form { margin: 0; }
  /* Whole pixels throughout: the header moves every page down by its height, and a
     fractional height redraws everything below it at a sub-pixel offset. */
  .wd-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
    margin: -24px 0 24px; padding-bottom: 11px; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  .wd-home { font-weight: 600; text-decoration: none; color: inherit; padding: 6px 0; line-height: 24px; }
  .wd-who { position: relative; min-width: 0; text-align: right; }
  .wd-who summary { cursor: pointer; padding: 6px 10px; line-height: 24px; border-radius: 8px; overflow-wrap: anywhere;
    background: color-mix(in srgb, currentColor 8%, transparent); }
  .wd-who summary strong { font-weight: 600; }
  .wd-menu { position: absolute; right: 0; z-index: 1; margin-top: 6px; padding: 8px; width: max-content;
    max-width: min(22rem, calc(100vw - 2.5rem)); display: grid; gap: .4rem; text-align: left;
    background: Canvas; color: CanvasText; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: .6rem; box-shadow: 0 .4rem 1.2rem rgb(0 0 0 / .18); }
  .wd-menu button { width: 100%; text-align: left; overflow-wrap: anywhere; }
  .wd-menu a { padding: .5rem 1rem; }
  .wd-menu p { margin: .25rem .5rem; font-size: .9rem; }
  .wd-deleting { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 0 0 24px; }
</style>
</head>
<body>
${viewer === null ? "" : accountHeader(viewer)}
${viewer === null || viewer.deletesAt === null ? "" : deletionNotice(viewer, viewer.deletesAt)}
${body}
</body>
</html>`.value;
}
