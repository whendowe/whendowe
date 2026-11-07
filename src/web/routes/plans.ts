// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { Temporal } from "temporal-polyfill";
import { ZodError } from "zod";
import type { StoragePort } from "../../db/port.js";
import {
  MAX_INVITEES,
  resolveInvitees,
  UnreachableAddressError,
} from "../../events/participation.js";
import { type Answer, answerSchema } from "../../events/poll.js";
import { MailCapReachedError } from "../../mail/capped.js";
import type { MailPort } from "../../mail/port.js";
import { findGroupForMember, listGroupsFor, listMembers } from "../../people/group.js";
import { normalizeEmail } from "../../people/person.js";
import type { PlanEventLike } from "../../plans/diff.js";
import { addVoteNote, listNotes, noteTouches, type PlanNote } from "../../plans/note.js";
import {
  type AgreedEvent,
  acceptPlan,
  addDraftEvent,
  agreedEvents,
  bringBack,
  castVote,
  clipDraft,
  discardDraft,
  listPlans,
  overlaps,
  type Plan,
  type PlanEvent,
  type PlanEventInput,
  PlanInputError,
  removeDraftEvent,
  sendDraft,
  setDraftDetails,
  startDraft,
  suggestTime,
  updateDraftEvent,
  withdrawPlan,
} from "../../plans/plan.js";
import {
  issueShareLink,
  removeGuest,
  shareLinkExpiry,
  turnOffShareLink,
} from "../../plans/share.js";
import {
  createThread,
  decidesByConsensus,
  findThreadForMember,
  leaveThread,
  listThreadsFor,
  memberName,
  type ThreadAccess,
  ThreadInputError,
} from "../../plans/thread.js";
import {
  issueVoteLinks,
  revokeUndeliveredVoteLink,
  VOTE_LINK_TTL_MS,
} from "../../plans/vote-link.js";
import {
  addDays,
  type Block,
  colourKey,
  colourMap,
  compareModel,
  dayKeys,
  dayLabel,
  type Line,
  lastDay,
  type Model,
  type Part,
  type Ribbon,
  spanText,
  weekBlocks,
  whenText,
  whoText,
} from "../../plans/weeks.js";
import {
  cappedText,
  copiedLink,
  type Html,
  html,
  PLANS_PATH,
  SHARE_BUTTONS,
  shareBox,
  ZONE_GUESS,
} from "../layout.js";
import { PLAN_STYLE, planAssets } from "../plan-editor.js";
import {
  type AppEnv,
  notVisible,
  page,
  rejectedPage,
  requireSignedIn,
  type SignedIn,
  verifyFormCsrf,
} from "../session.js";
import { appearanceSection, saveAppearance } from "./account.js";
import { EVENTS_PATH } from "./events.js";
import { noteList, oneTime, sendVoteLink, sensitive, voteUrl } from "./respond.js";
import { SHARE_PATH } from "./share.js";

// Plan pages (DESIGN §10 rc19, slices P2–P3): a thread, a plan, and your draft. Every read
// goes through findThreadForMember (no IDOR) and every write takes its access. Every
// action is a POST with a CSRF token; GET never mutates — the day panel, the editor, "See
// A" and the accept confirmation are all query parameters of a plain page, so everything
// works without JavaScript (rc15), and the week-row script (P4) only adds gestures.

export { PLANS_PATH };

export interface PlanRouteDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
  /** Links in the paste-me message are built from this, never the Host header. */
  readonly publicBaseUrl: string;
  /** Vote links (rc26): sent only when the organizer asks. */
  readonly mail: MailPort;
}

const threadPath = (t: string) => `${PLANS_PATH}/${t}`;
const planPath = (t: string, p: string) => `${PLANS_PATH}/${t}/p/${p}`;
const draftPath = (t: string) => `${PLANS_PATH}/${t}/draft`;

// --- loading --------------------------------------------------------------------------

interface View {
  readonly access: ThreadAccess;
  readonly plans: readonly Plan[];
  readonly agreed: readonly AgreedEvent[];
  readonly draft: Plan | null;
  readonly colours: ReadonlyMap<string, number>;
  readonly nameOf: (id: string) => string;
  readonly today: string;
  readonly csrf: string;
  /** Notes on days (rc28): public ones, and the viewer's own. */
  readonly notes: readonly PlanNote[];
  /** The organizer's: until when the shared link works, or null with none (rc25). */
  readonly shareUntil: string | null;
  /** A link made by this very request, shown once to copy; never stored (rc25). */
  readonly sharedUrl: string | null;
}

async function load(deps: PlanRouteDeps, access: ThreadAccess, me: SignedIn): Promise<View> {
  const plans = await listPlans(deps.storage, access);
  const agreed = await agreedEvents(deps.storage, access);
  const names = new Map(access.members.map((m) => [m.personId, memberName(m)]));
  return {
    access,
    plans,
    agreed,
    draft: plans.find((p) => p.status === "draft") ?? null,
    colours: colourMap([...agreed, ...plans.flatMap((p) => p.events)]),
    nameOf: (id) => names.get(id) ?? "someone",
    today: Temporal.Instant.from(deps.now())
      .toZonedDateTimeISO(access.thread.tzid)
      .toPlainDate()
      .toString(),
    csrf: me.csrfToken,
    notes: await listNotes(deps.storage, access),
    shareUntil:
      access.thread.organizerId === access.personId
        ? await shareLinkExpiry(deps.storage, access, deps.now())
        : null,
    sharedUrl: null,
  };
}

async function gate(
  c: Context<AppEnv>,
  deps: PlanRouteDeps,
  me: SignedIn,
): Promise<ThreadAccess | Response> {
  const threadId = c.req.param("thread") ?? "";
  const access = await findThreadForMember(deps.storage, threadId, me.personId);
  if (access !== null) return access;
  return notVisible(
    c,
    async (personId) => (await findThreadForMember(deps.storage, threadId, personId)) !== null,
  );
}

function str(form: Record<string, unknown>, key: string): string {
  const v = form[key];
  return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
}

function strs(form: Record<string, unknown>, key: string): string[] {
  const v = form[key];
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A person-facing message for what a form got wrong, or null for a real failure. */
function problem(err: unknown): string | null {
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Check the form.";
  if (err instanceof PlanInputError || err instanceof ThreadInputError) return err.message;
  if (err instanceof UnreachableAddressError) return err.message;
  return null;
}

// --- small pieces ---------------------------------------------------------------------

const STATUS_WORD: Record<Plan["status"], string> = {
  draft: "not sent",
  on_table: "on the table",
  accepted: "accepted",
  replaced: "replaced",
  withdrawn: "withdrawn",
};

const chip = (p: Plan) => html`<span class="letter">${p.letter ?? "·"}</span>`;
const statusBadge = (p: Plan) =>
  html`<span class="status ${p.status}">${STATUS_WORD[p.status]}</span>`;
const colour = (v: View, e: { title: string; who: readonly string[] }) =>
  `var(--o${v.colours.get(colourKey(e)) ?? 0})`;
const parts = (ps: readonly Part[]) =>
  ps.map((p) => (p.strong ? html`<strong>${p.text}</strong>` : p.text));

function instant(v: View, at: string | null): string {
  if (at === null) return "";
  const z = Temporal.Instant.from(at).toZonedDateTimeISO(v.access.thread.tzid);
  const k = z.toPlainDate().toString();
  return `${dayLabel(k)} ${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`;
}

const ANSWER_WORD: Record<Answer, string> = { yes: "yes", ifneedbe: "if need be", no: "no" };

function tally(v: View, p: Plan): string {
  const n = (a: Answer) => p.votes.filter((x) => x.answer === a).length;
  const missing = v.access.members.length - p.votes.length;
  return `${n("yes")} yes, ${n("ifneedbe")} if need be, ${n("no")} no${missing > 0 ? `, ${missing} not voted` : ""}`;
}

function votesLine(v: View, p: Plan): Html {
  return html`<div class="votes">${v.access.members.map((m) => {
    const vote = p.votes.find((x) => x.personId === m.personId);
    return html`<span class="vote ${vote?.answer ?? "none"}">${memberName(m)} ${vote === undefined ? "·" : ANSWER_WORD[vote.answer]}</span>`;
  })}</div>`;
}

function decideHint(v: View): string {
  if (decidesByConsensus(v.access)) return "Accepted when both say yes";
  return v.access.thread.organizerId === v.access.personId
    ? "You decide, after the votes are in"
    : `${v.nameOf(v.access.thread.organizerId)} decides`;
}

function lineList(lines: readonly Line[]): Html {
  return html`<ul class="wl">${lines.map((l) => html`<li class="${l.kind}">${parts(l.parts)}</li>`)}</ul>`;
}

// --- week rows ------------------------------------------------------------------------

interface Links {
  readonly day: (key: string) => string;
  readonly ribbon: (r: Ribbon) => string;
}

function weekHtml(
  row: Extract<Block, { kind: "week" }>["row"],
  links: Links,
  compareLetter: string | null,
  selColour: string | null,
): Html {
  const warn = row.lines.filter((l) => l.kind === "warn");
  const changes = row.lines.filter((l) => l.kind !== "warn");
  return html`<section class="week" id="w-${row.start}">
<div class="wh"><span><strong>Week ${row.number}</strong> · ${row.range}</span>${
    row.samePlan && compareLetter !== null
      ? html`<span class="st">same as ${compareLetter}</span>`
      : ""
  }</div>
<div class="wg" data-w="${row.start}">${row.days.map(
    (d, i) =>
      html`<a class="dh${d.today ? " today" : ""}${d.weekend ? " we" : ""}${d.selEnd ? " sel-end" : ""}${d.selMid ? " sel-mid" : ""}${d.picked ? " picked" : ""}" style="grid-column:${i + 1}${selColour === null ? "" : `;--ev:${selColour}`}" href="${links.day(d.key)}" data-k="${d.key}" aria-label="${dayLabel(d.key)}"><span>${d.dow}</span><b>${d.date}</b></a>`,
  )}${row.ribbons.map((r) => {
    const g = r.grips;
    const cls = `rib ${r.kind}${r.one ? ` one${r.right ? " right" : ""}` : ""}${r.selected ? ` sel${g?.start ? " gs" : ""}${g?.end ? " ge" : ""}` : ""}`;
    const style = `grid-column:${r.colStart} / ${r.colEnd};grid-row:${r.row};--x:var(--o${r.colour})${g === null ? "" : `;--n:${g.n};--a:${g.a};--b:${g.b}`}`;
    return html`<a class="${cls}" style="${style}" href="${links.ribbon(r)}" data-sid="${r.sid}" data-kind="${r.kind}" data-k="${r.day}" aria-label="${r.aria}">${
      g?.start ? html`<span class="grip s" data-grip="start" aria-hidden="true"></span>` : ""
    }${g?.end ? html`<span class="grip e" data-grip="end" aria-hidden="true"></span>` : ""}${r.head ? "" : "‹ "}${
      r.time === null ? "" : html`<small>${r.time}</small> `
    }${r.title}${r.who === null ? "" : html` <small class="who">${r.who}</small>`}${r.tail ? "" : " ›"}${
      r.badge === null ? "" : html`<span class="badge">${r.badge}</span>`
    }${r.kind === "agreed" ? html`<span class="lock" aria-hidden="true">✓</span>` : ""}</a>`;
  })}</div>
${warn.length > 0 ? lineList(warn) : ""}
${
  changes.length > 0
    ? html`<details class="wch"><summary>${changes.length} change${changes.length > 1 ? "s" : ""}</summary>${lineList(changes)}</details>`
    : ""
}
</section>`;
}

function weeksHtml(
  blocks: readonly Block[],
  links: Links,
  opts: { compareLetter: string | null; selColour: string | null; editing: boolean },
): Html {
  return html`<div class="weeks${opts.editing ? " editing" : ""}">${blocks.map((b) =>
    b.kind === "week"
      ? weekHtml(b.row, links, opts.compareLetter, opts.selColour)
      : html`<details class="fold"><summary><span><strong>${b.label}</strong></span><span class="muted">${b.summary} ▸</span></summary>${b.rows.map(
          (r) => weekHtml(r, links, opts.compareLetter, opts.selColour),
        )}</details>`,
  )}</div>`;
}

/** What is on a day, row by row: what is agreed, and what the drawn plan does there. */
function dayRows(
  v: View,
  model: Model,
  day: string,
  letters: { here: string; base: string | null },
): Html {
  const items = model.items.filter((it) => dayKeys(it.e).includes(day));
  if (items.length === 0) return html`<p class="muted small">Nothing on this day.</p>`;
  return html`<ul class="rows">${items.map((it) => {
    const label =
      it.kind === "agreed"
        ? "agreed"
        : it.kind === "ghost"
          ? `only ${letters.base ?? "before"}`
          : (it.badge ?? (model.compared ? "in both" : letters.here));
    return html`<li class="${it.kind === "ghost" ? "gone" : ""}"><span class="sw${it.kind === "ghost" ? " stripe" : it.kind === "agreed" ? " muted" : ""}" style="--x:${colour(v, it.e)}"></span><span><strong>${it.e.title}</strong> <span class="w">${whenText(it.e)} · for ${whoText(it.e.who, v.nameOf)}</span></span><span class="w">${label}</span></li>`;
  })}</ul>`;
}

/** The plan this one is compared with: what it answers. */
function baseOf(v: View, p: Plan): Plan | null {
  return v.plans.find((x) => x.id === p.answersId && x.status !== "draft") ?? null;
}

function shell(body: Html, editor = false): Html {
  return html`${editor ? "" : PLAN_STYLE}<div class="pl">${body}</div>${editor ? planAssets() : ""}`;
}

// --- the thread -----------------------------------------------------------------------

function planRow(v: View, p: Plan): Html {
  const ans = baseOf(v, p);
  return html`<div class="msg ${p.status}${p.authorId === v.access.personId ? " mine" : ""}"><a href="${planPath(v.access.thread.id, p.id)}"><span class="t1">${chip(p)}<span>${p.name}</span></span>
<span class="t2">${v.nameOf(p.authorId)} · ${instant(v, p.sentAt)}${ans === null ? "" : ` · answers ${ans.letter}`} · ${spanText(p.events)}</span>${
    p.status === "on_table" ? html`<span class="t2">${tally(v, p)}</span>` : ""
  }</a><span></span></div>`;
}

function history(v: View): Html {
  const entries: { at: string; text: string }[] = [];
  for (const p of v.plans) {
    if (p.status === "draft" || p.sentAt === null) continue;
    const ans = baseOf(v, p);
    entries.push({
      at: p.sentAt,
      text: `${v.nameOf(p.authorId)} put “${p.name}” on the table${ans === null ? "" : `, answering “${ans.name}”`}.`,
    });
    if (p.decidedAt === null) continue;
    if (p.status === "accepted")
      entries.push({
        at: p.decidedAt,
        text:
          p.decidedBy === null
            ? `Both said yes to “${p.name}”: ${p.events.length} event${p.events.length > 1 ? "s" : ""} now agreed.`
            : `${v.nameOf(p.decidedBy)} accepted “${p.name}”: ${p.events.length} event${p.events.length > 1 ? "s" : ""} now agreed.`,
      });
    if (p.status === "replaced") {
      const by = v.plans.find((x) => x.id === p.replacedBy);
      entries.push({
        at: p.decidedAt,
        text: `“${p.name}” was replaced: “${by?.name ?? "another plan"}” settled the same time.`,
      });
    }
    if (p.status === "withdrawn")
      entries.push({ at: p.decidedAt, text: `${v.nameOf(p.authorId)} withdrew “${p.name}”.` });
  }
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (entries.length === 0) return html``;
  return html`<h3 class="group-h">History</h3><ul class="list">${entries.map(
    (e) => html`<li><span class="muted small">${instant(v, e.at)}</span> ${e.text}</li>`,
  )}</ul>`;
}

function startForm(
  v: View,
  label: string,
  opts: { from?: string; rest?: boolean; primary?: boolean },
): Html {
  return html`<form method="post" action="${threadPath(v.access.thread.id)}/drafts">
<input type="hidden" name="csrf" value="${v.csrf}" />
${opts.from === undefined ? "" : html`<input type="hidden" name="from" value="${opts.from}" />`}
${opts.rest ? html`<input type="hidden" name="rest" value="1" />` : ""}
<button type="submit"${opts.primary ? html` class="primary"` : ""}>${label}</button></form>`;
}

/**
 * The message to paste with a shared link. One time is asked as one question (rc33), with
 * the time in words: not every chat draws the link's card. The link stays last.
 */
function pasteMessage(v: View, url: string): Html {
  const one = oneTime(v.plans.filter((p) => p.status === "on_table"));
  return one === null
    ? html`${v.access.thread.name}: which of these work for you? ${url}`
    : html`${v.access.thread.name}, ${whenText(one)}: does this work for you? ${url}`;
}

/**
 * The organizer's shared link (rc25, rc29): make one, see until when it works, replace it
 * or turn it off. A new link is shown once, on the page that made it; only its hash is kept.
 */
function shareSection(v: View): Html {
  const here = `${threadPath(v.access.thread.id)}/share`;
  const csrf = html`<input type="hidden" name="csrf" value="${v.csrf}" />`;
  const fresh =
    v.sharedUrl === null
      ? ""
      : html`<p>Paste this into your group chat:</p>
${shareBox("Message to paste", pasteMessage(v, v.sharedUrl))}${SHARE_BUTTONS}
<p class="muted small">It's shown only now. Lost it? Make a new one — the old one then stops working.</p>`;
  const live =
    v.shareUntil === null
      ? html`<p class="muted small">One link for the whole chat: anyone with it can vote, signed in or not. Once you share it, you decide which time it is.</p>
<form method="post" action="${here}">${csrf}<button type="submit">Share a link</button></form>`
      : html`<p class="muted small">Anyone with the link can vote until ${dayLabel(v.shareUntil.slice(0, 10))}, or until you decide.</p>
<div class="row"><form method="post" action="${here}">${csrf}<button type="submit">New link</button></form><form method="post" action="${here}/off">${csrf}<button class="link" type="submit">Turn the link off</button></form></div>`;
  const alone =
    v.access.members.length === 1
      ? html`<p><strong>Nobody's in this yet.</strong> Share a link in your group chat: whoever opens it can vote.</p>`
      : "";
  return html`<section class="share" id="share"><h3 class="group-h">Share in a group chat</h3>${alone}${fresh}${live}</section>`;
}

/**
 * Who answered from the shared link and hasn't confirmed (rc30), for the organizer: each
 * can be removed, and the name is then free again.
 */
function guestsSection(v: View): Html | string {
  const guests = v.access.members.filter((m) => m.guest);
  if (guests.length === 0 || v.access.thread.organizerId !== v.access.personId) return "";
  const here = `${threadPath(v.access.thread.id)}/guests/remove`;
  return html`<section class="guests" id="guests"><h3 class="group-h">Not confirmed</h3>
<p class="muted small">They answered from the shared link without an account. Removing one takes their answers with them and frees the name.</p>
${guests.map(
  (m) =>
    html`<div class="row"><span><strong>${memberName(m)}</strong> · not confirmed</span><form method="post" action="${here}"><input type="hidden" name="csrf" value="${v.csrf}" /><input type="hidden" name="guest" value="${m.personId}" /><button class="link" type="submit">Remove ${memberName(m)}</button></form></div>`,
)}</section>`;
}

/**
 * Each member's own vote link, for the organizer to send in a chat instead of by email
 * (rc36). Members with an address only: a guest has the shared link and their claim link.
 */
function ownLinksSection(v: View): Html | string {
  const t = v.access.thread;
  const others = v.access.members.filter((m) => !m.guest && m.personId !== v.access.personId);
  const open = v.plans.some((p) => p.status === "on_table");
  if (!open || others.length === 0 || t.organizerId !== v.access.personId) return "";
  return html`<section class="links" id="links"><h3 class="group-h">Their own links</h3>
<p class="muted small">Each answers as that person. Copy one to send in a chat instead of by email.</p>
${others.map(
  (m) =>
    html`<div class="row"><span><strong>${memberName(m)}</strong></span><form method="post" action="${threadPath(t.id)}/links/copy"><input type="hidden" name="csrf" value="${v.csrf}" /><input type="hidden" name="person" value="${m.personId}" /><button class="link" type="submit">Copy ${memberName(m)}'s link</button></form></div>`,
)}</section>`;
}

function threadPage(v: View, day: string | null, notice: string | null = null): Html {
  const t = v.access.thread;
  const waiting = v.plans.filter(
    (p) => p.status === "on_table" && !p.votes.some((x) => x.personId === v.access.personId),
  );
  const mineReplaced = v.plans.filter(
    (p) =>
      p.status === "replaced" &&
      p.authorId === v.access.personId &&
      p.events.some((e) => !v.agreed.some((a) => overlaps(a, e))),
  );
  const model = compareModel({ agreed: v.agreed, events: [], base: null, nameOf: v.nameOf });
  const blocks = weekBlocks(model, {
    today: v.today,
    colours: v.colours,
    nameOf: v.nameOf,
    selected: null,
    picked: day,
    agreedOnly: true,
    more: 0,
  });
  const eventOf = (sid: string) => v.agreed.find((a) => a.sid === sid)?.eventId ?? "";
  const onDay = day === null ? [] : v.agreed.filter((a) => dayKeys(a).includes(day));
  const onTable = v.plans.filter((p) => p.status === "on_table");
  const groups: [string, Plan[]][] = [
    ["On the table", onTable.slice().reverse()],
    ["Accepted", v.plans.filter((p) => p.status === "accepted").reverse()],
    [
      "Replaced or withdrawn",
      v.plans.filter((p) => p.status === "replaced" || p.status === "withdrawn").reverse(),
    ],
  ];
  return shell(
    html`<div class="head"><div><div class="l1">${t.name}</div><div class="l2">${v.access.members.map(memberName).join(", ")} · ${decideHint(v)}</div></div><span></span></div>
${
  waiting.length > 0
    ? html`<h3>Waiting for your vote</h3><div class="choose">${waiting.map(
        (p) =>
          html`<a class="btn" href="${planPath(t.id, p.id)}">${chip(p)}<span><strong>${p.name}</strong> <span class="muted small">${v.nameOf(p.authorId)}, ${spanText(p.events)}</span></span></a>`,
      )}</div>`
    : ""
}
${
  mineReplaced.length > 0
    ? html`<h3>Yours, replaced</h3><div class="choose">${mineReplaced.map((p) =>
        startForm(v, `Plan the rest of “${p.name}”`, { from: p.id, rest: true }),
      )}</div>`
    : ""
}
<div class="row">${
      v.draft === null
        ? startForm(v, "Propose a plan", { primary: true })
        : html`<a class="btn primary" href="${draftPath(t.id)}">Back to your draft</a>`
    }${
      onTable.length > 0 && t.organizerId === v.access.personId && v.access.members.length > 1
        ? html`<form method="post" action="${threadPath(t.id)}/links"><input type="hidden" name="csrf" value="${v.csrf}" /><button type="submit">Email vote links</button></form>`
        : ""
    }</div>
${notice === null ? "" : html`<p class="notice">${notice}</p>`}
${onTable.length > 0 && t.organizerId === v.access.personId ? shareSection(v) : ""}
${guestsSection(v)}
${ownLinksSection(v)}
${groups.map(([title, ps]) =>
  ps.length === 0 ? "" : html`<h3 class="group-h">${title}</h3>${ps.map((p) => planRow(v, p))}`,
)}
<h3 class="group-h">What is agreed</h3>
${v.agreed.length === 0 ? html`<p class="muted small">Nothing yet. A plan's events land here once it is accepted, and in everyone's events.</p>` : ""}
${
  v.agreed.length === 0
    ? ""
    : weeksHtml(
        blocks,
        {
          day: (k) => `${threadPath(t.id)}?day=${k}#w-${k}`,
          ribbon: (r) => `${EVENTS_PATH}/${eventOf(r.sid)}`,
        },
        { compareLetter: null, selColour: null, editing: false },
      )
}
${
  day === null
    ? ""
    : html`<section class="sheet"><div class="spread"><h3>${dayLabel(day)}</h3><a class="x" href="${threadPath(t.id)}" aria-label="Close">×</a></div>${
        onDay.length === 0
          ? html`<p class="muted small">Nothing agreed on this day.</p>`
          : html`<ul class="rows">${onDay.map(
              (a) =>
                html`<li><span class="sw muted" style="--x:${colour(v, a)}"></span><span><a href="${EVENTS_PATH}/${a.eventId}"><strong>${a.title}</strong></a> <span class="w">${whenText(a)} · for ${whoText(a.who, v.nameOf)}</span></span><span class="w">agreed</span></li>`,
            )}</ul>`
      }</section>`
}
${v.notes.length === 0 ? "" : html`<h3 class="group-h">Notes</h3>${noteList(v.notes, v.nameOf)}`}
${history(v)}`,
  );
}

// --- a plan ---------------------------------------------------------------------------

interface PlanQuery {
  readonly day: string | null;
  readonly see: boolean;
  readonly confirm: boolean;
  readonly sent: boolean;
  readonly more: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function planQuery(c: Context<AppEnv>): PlanQuery {
  const day = c.req.query("day") ?? "";
  const more = Number.parseInt(c.req.query("more") ?? "0", 10);
  return {
    day: DAY.test(day) ? day : null,
    see: c.req.query("see") === "base",
    confirm: c.req.query("confirm") === "1",
    sent: c.req.query("sent") === "1",
    more: Number.isFinite(more) && more > 0 && more < 52 ? more : 0,
  };
}

function header(
  v: View,
  focus: Plan,
  base: Plan | null,
  model: Model,
  opts: { seeing: boolean; here: string },
): Html {
  const t = v.access.thread;
  const onTable = v.plans.filter((p) => p.status === "on_table").length;
  const isDraft = focus.status === "draft";
  const l1 = opts.seeing
    ? html`${base === null ? "" : chip(base)}<span>${base === null ? "" : `${v.nameOf(base.authorId)}: ${base.name}`}</span>`
    : isDraft
      ? html`<span>Your draft${focus.name === "" ? "" : `: ${focus.name}`}</span>`
      : html`${chip(focus)}<span>${v.nameOf(focus.authorId)}: ${focus.name}</span>`;
  const word = isDraft ? (focus.restOf ? "the rest of" : "changes to") : "answers";
  const l2 = opts.seeing
    ? html`<span>Showing the plan this answers.</span> <a href="${opts.here}">Back to ${isDraft ? "your draft" : focus.letter}</a>`
    : html`<span>${base === null ? "compared with what is agreed" : `${word} ${base.letter} · ${v.nameOf(base.authorId)}: ${base.name}`}</span>${statusBadge(focus)}`;
  const all = model.lines.filter((l) => l.kind !== "warn" && l.primary);
  const settled = model.settled > 0 ? ", apart from what is agreed since" : "";
  const l3 =
    base === null || opts.seeing
      ? ""
      : html`<div class="l3">${
          all.length > 0
            ? html`<details><summary>${model.changes} change${model.changes > 1 ? "s" : ""} from ${base.letter}${settled}</summary>${lineList(all)}</details>`
            : html`<span>Same as ${base.letter}${settled}</span>`
        }<a class="btn small" href="${opts.here}${opts.here.includes("?") ? "&" : "?"}see=base">See ${base.letter}</a></div>`;
  return html`<div class="head"><div><div class="l1">${l1}</div><div class="l2">${l2}</div></div>
<a class="btn" href="${threadPath(t.id)}">${t.name}${onTable > 0 ? ` (${onTable})` : ""}</a>${l3}</div>`;
}

/** A plan with one event, against at most one: a card, not week rows (§10 rc19). */
function oneEventCard(v: View, plan: Plan, base: Plan | null): Html | null {
  const [e, ...more] = plan.events;
  if (e === undefined || more.length > 0 || (base !== null && base.events.length > 1)) return null;
  const was = base?.events[0];
  return html`<div class="card"><span class="sw" style="--x:${colour(v, e)}"></span><span class="when">${whenText(e)}</span><span><strong>${e.title}</strong> · for ${whoText(e.who, v.nameOf)}</span>${
    e.location === null ? "" : html`<span class="small">at ${e.location}</span>`
  }${
    was !== undefined && was.sid === e.sid && whenText(was) !== whenText(e)
      ? html`<span class="muted small">was ${whenText(was)}</span>`
      : ""
  }${e.description === null ? "" : html`<p class="small notes">${e.description}</p>`}</div>`;
}

/** Another time for a one-event plan on the table (rc26): its own times, prefilled. */
function suggestForm(v: View, p: Plan): Html | string {
  const [e, ...more] = p.events;
  if (e === undefined || more.length > 0) return "";
  const kind = e.allDay ? "date" : "datetime-local";
  const end = e.allDay ? addDays(e.endLocal, -1) : e.endLocal;
  return html`<details class="suggest"><summary>Suggest another time</summary>
<form method="post" action="${planPath(v.access.thread.id, p.id)}/suggest"><input type="hidden" name="csrf" value="${v.csrf}" />
<p><label>${e.allDay ? "From" : "Starts"} <input type="${kind}" name="start" required value="${e.startLocal}" /></label>
<label>${e.allDay ? "To (the last day)" : "Ends"} <input type="${kind}" name="end" required value="${end}" /></label></p>
<p><button type="submit">Suggest it</button> <span class="small muted">It goes on the table next to this one, with your yes.</span></p></form></details>`;
}

function planSheet(
  v: View,
  p: Plan,
  base: Plan | null,
  q: PlanQuery,
  model: Model,
  link: string,
): Html {
  const t = v.access.thread;
  const here = planPath(t.id, p.id);
  const csrf = html`<input type="hidden" name="csrf" value="${v.csrf}" />`;
  if (q.day !== null)
    return html`<div class="spread"><h3>${dayLabel(q.day)}</h3><a class="x" href="${here}" aria-label="Close">×</a></div>${dayRows(v, model, q.day, { here: p.letter ?? "", base: base?.letter ?? null })}`;
  const mine = p.votes.find((x) => x.personId === v.access.personId)?.answer ?? null;
  const yes = p.votes.filter((x) => x.answer === "yes").length;
  const about = html`<details class="about"><summary><strong>${v.nameOf(p.authorId)}</strong>${p.message === null ? ` · ${instant(v, p.sentAt)}` : html`: “${p.message}”`} <span class="small muted">${yes}/${v.access.members.length} yes</span></summary>
<p class="small muted">${instant(v, p.sentAt)} · ${p.events.length} event${p.events.length > 1 ? "s" : ""}, ${spanText(p.events)}</p>${votesLine(v, p)}</details>`;
  const sent = q.sent
    ? html`<div class="notice"><p>Sent, with your yes. ${
        decidesByConsensus(v.access)
          ? "It is accepted once both say yes."
          : t.organizerId === v.access.personId
            ? "You decide once everyone has voted."
            : `${v.nameOf(t.organizerId)} decides once everyone has voted.`
      }</p><p class="small">To let them know, paste this where you usually talk:</p>
${shareBox("Message to paste", html`${t.name}: I've proposed “${p.name}” (${spanText(p.events)}). Have a look: ${link}`, 3)}${SHARE_BUTTONS}</div>`
    : "";
  if (p.status === "accepted")
    return html`${about}<p class="small muted">${p.decidedBy === null ? "Both said yes to it" : `${v.nameOf(p.decidedBy)} accepted it`}, ${instant(v, p.decidedAt)}. Its events are in everyone's events.</p>`;
  if (p.status === "replaced" || p.status === "withdrawn") {
    const by = v.plans.find((x) => x.id === p.replacedBy);
    return html`${about}<p class="small muted">${
      p.status === "withdrawn"
        ? `Withdrawn by ${v.nameOf(p.authorId)}.`
        : `Replaced by “${by?.name ?? "another plan"}”, which settled the same time.`
    }</p>${p.status === "replaced" ? html`<div class="row">${startForm(v, "Plan the rest…", { from: p.id, rest: true, primary: true })}</div>` : ""}`;
  }
  const organizer = !decidesByConsensus(v.access) && t.organizerId === v.access.personId;
  if (q.confirm && organizer) {
    const notVoted = v.access.members.filter(
      (m) => !p.votes.some((x) => x.personId === m.personId),
    );
    return html`${about}<div class="confirm"><p><strong>Accept “${p.name}” as a whole?</strong> ${tally(v, p)}${
      notVoted.length > 0 ? ` (not yet: ${notVoted.map(memberName).join(", ")})` : ""
    }. Other plans for the same time are replaced by it.</p>
<div class="row"><form method="post" action="${here}/accept">${csrf}<button class="primary" type="submit">Yes, accept</button></form><a class="btn" href="${here}">Cancel</a></div></div>`;
  }
  const voteButton = (a: Answer, label: string) =>
    html`<button type="submit" name="answer" value="${a}" aria-pressed="${mine === a ? "true" : "false"}">${label}</button>`;
  return html`${sent}${about}
<form method="post" action="${here}/vote" class="seg" role="group" aria-label="Your vote">${csrf}${voteButton("yes", "Yes")}${voteButton("ifneedbe", "If need be")}${voteButton("no", "No")}</form>
<details class="suggest"><summary>Add a note</summary><form method="post" action="${threadPath(t.id)}/notes">${csrf}<input type="hidden" name="back" value="${p.id}" />
<p><textarea name="note" rows="2" maxlength="500" class="wide" aria-label="Note" placeholder="Thursday's bad next week"></textarea></p>
<p><button type="submit">Add it</button> <span class="small muted">Everyone in it sees it, on the days on the table.</span></p></form></details>
${suggestForm(v, p)}
<div class="spread"><div class="row">${organizer ? html`<a class="btn primary" href="${here}?confirm=1">Accept…</a>` : ""}${startForm(
    v,
    p.authorId === v.access.personId ? "Change it…" : "Suggest changes…",
    { from: p.id },
  )}${
    p.authorId === v.access.personId
      ? html`<form method="post" action="${here}/withdraw">${csrf}<button class="link" type="submit">Withdraw</button></form>`
      : ""
  }</div><span class="small muted">${decideHint(v)}</span></div>`;
}

/** The notes on any of a plan's days (rc28). */
function planNotes(v: View, p: Plan): Html | string {
  const first = p.events.map((e) => e.startLocal.slice(0, 10)).sort()[0];
  const last = p.events.map(lastDay).sort().at(-1);
  if (first === undefined || last === undefined) return "";
  const on = v.notes.filter((n) => noteTouches(n, first, last));
  return on.length === 0
    ? ""
    : html`<h3 class="group-h">Notes on these days</h3>${noteList(on, v.nameOf)}`;
}

function planPage(
  v: View,
  p: Plan,
  q: PlanQuery,
  deps: PlanRouteDeps,
  notice: string | null,
): Html {
  const t = v.access.thread;
  const here = planPath(t.id, p.id);
  const base = baseOf(v, p);
  const seeing = q.see && base !== null;
  const model = compareModel({
    agreed: v.agreed,
    events: seeing && base !== null ? base.events : p.events,
    base: seeing ? null : (base?.events ?? null),
    nameOf: v.nameOf,
  });
  const card = seeing ? null : oneEventCard(v, p, base);
  const blocks = weekBlocks(model, {
    today: v.today,
    colours: v.colours,
    nameOf: v.nameOf,
    selected: null,
    picked: q.day,
    agreedOnly: false,
    more: q.more,
  });
  const link = `${deps.publicBaseUrl}${here}`;
  return shell(
    html`${header(v, p, base, model, { seeing, here })}
${notice === null ? "" : html`<p class="notice error">${notice}</p>`}
${
  card ??
  html`${weeksHtml(
    blocks,
    {
      day: (k) => `${here}?day=${k}${seeing ? "&see=base" : ""}#w-${k}`,
      ribbon: (r) => `${here}?day=${r.day}${seeing ? "&see=base" : ""}`,
    },
    { compareLetter: base?.letter ?? null, selColour: null, editing: false },
  )}<a class="btn small" href="${here}?more=${q.more + 1}">Show another week</a>`
}
<section class="sheet">${planSheet(v, p, base, q, model, link)}</section>
${planNotes(v, p)}`,
  );
}

// --- your draft -----------------------------------------------------------------------

interface DraftQuery extends PlanQuery {
  readonly e: string | null;
  readonly add: string | null;
  readonly kind: "days" | "time";
  readonly range: boolean;
  /** "end" for a stretch just drawn: it starts with its end picked up (P4). */
  readonly grab: "start" | "end" | null;
}

function draftQuery(c: Context<AppEnv>): DraftQuery {
  const add = c.req.query("add") ?? "";
  return {
    ...planQuery(c),
    e: c.req.query("e") ?? null,
    add: DAY.test(add) ? add : null,
    kind: c.req.query("kind") === "days" ? "days" : "time",
    range: c.req.query("range") === "1",
    grab: c.req.query("grab") === "end" ? "end" : c.req.query("grab") === "start" ? "start" : null,
  };
}

const LENGTHS = [30, 60, 90, 120, 180, 240, 300, 360, 480];

function lengthLabel(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  if (r === 0) return `${h} h`;
  return r === 30 ? `${h}½ h` : `${h} h ${r} min`;
}

function minutesOf(e: Pick<PlanEvent, "startLocal" | "endLocal">): number {
  return Temporal.PlainDateTime.from(e.startLocal)
    .until(Temporal.PlainDateTime.from(e.endLocal))
    .total({ unit: "minutes" });
}

/**
 * One event's form: what it is, a time on a day or whole days, who it is for. Plain
 * fields only — the week-row script writes these same fields when an end is picked up
 * and put down, or dragged.
 */
function editor(
  v: View,
  e: PlanEvent | null,
  defaults: { day: string; kind: "days" | "time" },
): Html {
  const t = v.access.thread;
  const csrf = html`<input type="hidden" name="csrf" value="${v.csrf}" />`;
  const allDay = e === null ? defaults.kind === "days" : e.allDay;
  const from = e === null ? defaults.day : e.startLocal.slice(0, 10);
  const to = e === null ? defaults.day : addDays(e.endLocal, -1);
  const day = e === null ? defaults.day : e.startLocal.slice(0, 10);
  const start = e === null || e.allDay ? "19:00" : e.startLocal.slice(11, 16);
  const len = e === null || e.allDay ? 120 : minutesOf(e);
  const lengths = LENGTHS.includes(len) ? LENGTHS : [...LENGTHS, len].sort((a, b) => a - b);
  const action = e === null ? `${draftPath(t.id)}/events` : `${draftPath(t.id)}/events/${e.sid}`;
  const clash = e !== null && v.agreed.some((a) => overlaps(a, e));
  const ev = e === null ? "var(--o0)" : colour(v, e);
  return html`<form method="post" action="${action}" class="ed" id="editor" style="--ev:${ev}" data-sid="${e?.sid ?? ""}">${csrf}
<div class="spread"><h3>${e === null ? "A new event" : "Change this event"}</h3><a class="x" href="${draftPath(t.id)}" aria-label="Close">×</a></div>
<div class="eh"><span class="dot"></span><input name="title" value="${e?.title ?? ""}" placeholder="What is it? e.g. Session 15" aria-label="What is it" maxlength="200" required /></div>
<div class="kind" role="radiogroup" aria-label="Kind"><label><input type="radio" name="kind" value="time"${allDay ? "" : html` checked`} /> A time on a day</label><label><input type="radio" name="kind" value="days"${allDay ? html` checked` : ""} /> Whole days</label></div>
<div class="stretch row"><label class="f">From<input type="date" name="from" value="${from}" /></label><label class="f">To<input type="date" name="to" value="${to}" /></label></div>
<div class="timed row"><label class="f">Day<input type="date" name="day" value="${day}" /></label><label class="f">Starts<input type="time" name="start" value="${start}" /></label><label class="f">Length<select name="length">${lengths.map(
    (m) => html`<option value="${m}"${m === len ? html` selected` : ""}>${lengthLabel(m)}</option>`,
  )}</select></label></div>
${
  e === null
    ? ""
    : html`<div class="mv"><span class="lbl">Move</span>${[
        [-7, "‹ week", "a week earlier"],
        [-1, "‹ day", "a day earlier"],
        [1, "day ›", "a day later"],
        [7, "week ›", "a week later"],
      ].map(
        ([n, label, aria]) =>
          html`<button type="submit" name="shift" value="${n}" aria-label="Move it ${aria}">${label}</button>`,
      )}</div>`
}
<div class="whorow" role="group" aria-label="Who it is for"><span class="lbl">Who</span>${v.access.members.map(
    (m) =>
      html`<label><input type="checkbox" name="who" value="${m.personId}"${e?.who.includes(m.personId) ? html` checked` : ""} /> ${memberName(m)}</label>`,
  )}<span class="small muted">none ticked: everyone</span></div>
${clash ? html`<p class="small error">Overlaps something already agreed.</p>` : ""}
${
  e === null
    ? ""
    : html`<p class="small muted" data-hint>${
        e.allDay
          ? "Tap its first or last day to pick it up, then tap where it goes. Or drag an end."
          : "Change the day, the start or the length."
      }</p>`
}
<div class="row"><button class="primary" type="submit">${e === null ? "Add it" : "Save"}</button>${
    e === null
      ? html`<a class="btn" href="${draftPath(t.id)}">Cancel</a>`
      : html`<a class="btn" href="${draftPath(t.id)}">Done</a>`
  }</div>
</form>${
    e === null
      ? ""
      : html`<div class="row"><form method="post" action="${draftPath(t.id)}/events/${e.sid}/again">${csrf}<button type="submit">Copy it a week later</button></form>
<form method="post" action="${draftPath(t.id)}/events/${e.sid}/remove">${csrf}<button type="submit" class="link">Remove</button></form></div>`
  }`;
}

function draftSheet(
  v: View,
  d: Plan,
  base: Plan | null,
  q: DraftQuery,
  error: string | null,
): Html {
  const t = v.access.thread;
  const here = draftPath(t.id);
  const csrf = html`<input type="hidden" name="csrf" value="${v.csrf}" />`;
  const err = error === null ? "" : html`<p class="error">${error}</p>`;
  if (q.see && base !== null)
    return html`<p class="small muted">Showing ${base.letter}, which your draft ${d.restOf ? "plans the rest of" : "changes"}. <a href="${here}">Back to your draft</a></p>`;
  const sel = d.events.find((e) => e.sid === q.e) ?? null;
  if (sel !== null) return html`${err}${editor(v, sel, { day: v.today, kind: "time" })}`;
  if (q.add !== null) return html`${err}${editor(v, null, { day: q.add, kind: q.kind })}`;
  if (q.range)
    return html`<div class="spread"><h3>Select days</h3><a class="x" href="${here}" aria-label="Cancel">×</a></div>${err}
<form method="post" action="${here}/clip" class="ed">${csrf}
<div class="row"><label class="f">First day<input type="date" name="first" value="${q.day ?? v.today}" required /></label><label class="f">Last day<input type="date" name="last" value="${q.day ?? v.today}" required /></label></div>
<div class="row"><button class="primary" type="submit" name="keep" value="1">Keep only these days</button><button type="submit" name="keep" value="0">Drop these days</button></div></form>`;
  if (q.day !== null) {
    const day = q.day;
    const on = <E extends PlanEventLike>(es: readonly E[]): E[] =>
      es.filter((e) => dayKeys(e).includes(day));
    const back =
      base === null ? [] : on(base.events).filter((e) => !d.events.some((x) => x.sid === e.sid));
    return html`<div class="spread"><h3>${dayLabel(day)}</h3><a class="x" href="${here}" aria-label="Close">×</a></div>${err}
${on(v.agreed).map(
  (e) =>
    html`<p class="small muted"><span class="sw muted" style="--x:${colour(v, e)}"></span> Agreed already: ${e.title}. Settled, so not part of a plan.</p>`,
)}
<div class="choose">${on(d.events).map(
      (e) =>
        html`<a class="btn" href="${here}?e=${e.sid}#w-${e.startLocal.slice(0, 10)}"><span class="sw" style="--x:${colour(v, e)}"></span><span><strong>${e.title}</strong> <span class="muted small">${whenText(e)}</span></span></a>`,
    )}${back.map(
      (e) =>
        html`<form method="post" action="${here}/bring/${e.sid}">${csrf}<button type="submit"><span class="sw stripe" style="--x:${colour(v, e)}"></span><span>Bring back <strong>${e.title}</strong> <span class="muted small">${whenText(e)}</span></span></button></form>`,
    )}
<a class="btn" href="${here}?add=${day}&kind=time"><span>+</span><span>A time on this day</span></a>
<a class="btn" href="${here}?add=${day}&kind=days"><span>+</span><span>Whole days from here</span></a></div>`;
  }
  return html`${err}<p class="small muted">Tap a day to add an event there; tap an event to change it.${
    base === null ? "" : ` “See ${base.letter}” shows the plan you are answering.`
  }</p>
<form method="post" action="${here}/details" class="ed">${csrf}
<input class="wide" name="name" value="${d.name}" placeholder="Name it (optional), e.g. First week only" aria-label="Name of the plan" maxlength="120" />
<textarea name="message" rows="2" placeholder="A message (optional)" aria-label="Message" maxlength="1000">${d.message ?? ""}</textarea>
<div class="spread"><div class="row"><button class="primary" type="submit" name="after" value="send"${d.events.length === 0 ? html` disabled` : ""}>Send</button><button type="submit" name="after" value="save">Save</button><a class="btn" href="${here}?range=1">Select days…</a></div></div>
</form>
<form method="post" action="${here}/discard">${csrf}<button class="link small" type="submit">Discard this draft</button></form>`;
}

function draftPage(v: View, d: Plan, q: DraftQuery, error: string | null): Html {
  const t = v.access.thread;
  const here = draftPath(t.id);
  const base = v.plans.find((x) => x.id === d.answersId && x.status !== "draft") ?? null;
  const seeing = q.see && base !== null;
  const model = compareModel({
    agreed: v.agreed,
    events: seeing && base !== null ? base.events : d.events,
    base: seeing ? null : (base?.events ?? null),
    nameOf: v.nameOf,
  });
  const sel = seeing ? null : (d.events.find((e) => e.sid === q.e) ?? null);
  const blocks = weekBlocks(model, {
    today: v.today,
    colours: v.colours,
    nameOf: v.nameOf,
    selected: sel?.sid ?? null,
    picked: q.day ?? q.add,
    agreedOnly: false,
    more: q.more,
  });
  const dayLink = (k: string) =>
    seeing
      ? `${here}?see=base`
      : sel !== null
        ? `${here}?e=${sel.sid}&day=${k}#w-${k}`
        : `${here}?day=${k}#w-${k}`;
  return shell(
    html`${header(v, d, base, model, { seeing, here })}
<div data-plan-editor data-sel="${sel?.sid ?? ""}" data-grab="${q.grab ?? ""}">
${weeksHtml(
  blocks,
  {
    day: dayLink,
    ribbon: (r) =>
      r.kind === "plan" && !seeing
        ? `${here}?e=${r.sid}#w-${r.day}`
        : `${here}?day=${r.day}#w-${r.day}`,
  },
  {
    compareLetter: base?.letter ?? null,
    selColour: sel === null ? null : colour(v, sel),
    editing: sel !== null,
  },
)}</div>
<a class="btn small" href="${here}?more=${q.more + 1}">Show another week</a>
<section class="sheet">${draftSheet(v, d, base, q, error)}</section>`,
    true,
  );
}

// --- starting a thread ----------------------------------------------------------------

const EMAIL_ROWS = 8;

async function newThreadForm(
  deps: PlanRouteDeps,
  me: SignedIn,
  values: { name: string; tzid: string; emails: readonly string[] },
  error: string | null,
): Promise<Html> {
  const groups = await listGroupsFor(deps.storage, me.personId);
  return html`${PLAN_STYLE}<div class="pl"><h1>Start planning</h1>
<p class="muted">Name what you are planning, and who plans it with you. With two of you, a plan is accepted when you both say yes; with more, you decide after everyone has voted.</p>
${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${PLANS_PATH}" class="ed">
<input type="hidden" name="csrf" value="${me.csrfToken}" />
<label class="f">What are you planning?<input class="wide" name="name" value="${values.name}" placeholder="Kiddo's weeks, Christmas 2026, Thursday Table" maxlength="80" required /></label>
<label class="f">Time zone<input id="tzid" name="tzid" value="${values.tzid}" placeholder="Europe/Prague" /></label>
<fieldset><legend>Who plans with you</legend>
${Array.from(
  { length: EMAIL_ROWS },
  (_, i) =>
    html`<p><input class="wide" type="email" name="email" value="${values.emails[i] ?? ""}" placeholder="their email" aria-label="Email ${i + 1}" /></p>`,
)}
${
  groups.length === 0
    ? ""
    : html`<label class="f">Or everyone from a group<select name="group"><option value="">—</option>${groups.map(
        (g) => html`<option value="${g.id}">${g.name} (${g.memberCount})</option>`,
      )}</select></label>`
}
</fieldset>
<div class="row"><button class="primary" type="submit">Start</button><a class="btn" href="${PLANS_PATH}">Cancel</a></div>
</form>
${ZONE_GUESS}</div>`;
}

/** Home's plans section: the threads you plan in, the ones waiting for you first. */
export async function yourPlans(storage: StoragePort, personId: string): Promise<Html> {
  const threads = await listThreadsFor(storage, personId);
  return html`<h2>Plans</h2>${
    threads.length === 0
      ? html`<p class="muted">Agree several events at once — the next weeks with the kids, a season of game nights.</p>`
      : html`<ul>${threads.map(
          (t) =>
            html`<li><a href="${threadPath(t.id)}">${t.name}</a>${
              t.waiting > 0
                ? html` · <strong>${t.waiting} waiting for your vote</strong>`
                : t.onTable > 0
                  ? html` <span class="muted">· ${t.onTable} on the table</span>`
                  : ""
            }</li>`,
        )}</ul>`
  }
<p><a href="${PLANS_PATH}/new">+ Start planning</a></p>`;
}

// --- reading an event off a form ------------------------------------------------------

function shiftDate(k: string, n: number): string {
  return DAY.test(k) && n !== 0 ? addDays(k, n) : k;
}

/** The editor's plain fields as a plan event: whole days are inclusive on the form. */
function readEvent(form: Record<string, unknown>): PlanEventInput {
  const shiftRaw = Number.parseInt(str(form, "shift"), 10);
  const shift = [-7, -1, 1, 7].includes(shiftRaw) ? shiftRaw : 0;
  const who = strs(form, "who");
  const title = str(form, "title");
  if (str(form, "kind") === "days") {
    let from = str(form, "from");
    let to = str(form, "to") || from;
    if (DAY.test(from) && DAY.test(to) && to < from) [from, to] = [to, from];
    return {
      title,
      allDay: true,
      startLocal: shiftDate(from, shift),
      endLocal: DAY.test(to) ? addDays(to, 1 + shift) : to,
      who,
    };
  }
  const day = shiftDate(str(form, "day"), shift);
  const start = str(form, "start");
  const minutes = Number.parseInt(str(form, "length"), 10);
  let endLocal = "";
  try {
    endLocal = Temporal.PlainDateTime.from(`${day}T${start}`)
      .add({ minutes: Number.isFinite(minutes) && minutes > 0 && minutes <= 10080 ? minutes : 120 })
      .toString({ smallestUnit: "minute" });
  } catch {
    // An invalid day or time: the event schema below says so, with its own message.
  }
  return { title, allDay: false, startLocal: `${day}T${start}`, endLocal, who };
}

// --- routes ---------------------------------------------------------------------------

export function registerPlanRoutes(app: Hono<AppEnv>, deps: PlanRouteDeps): void {
  const notFound = (c: Context<AppEnv>) =>
    c.html(
      page(c, "Not found", html`<h1>Not found</h1><p><a href="${PLANS_PATH}">Your plans</a></p>`),
      404,
    );

  /** Signed in, a valid CSRF token, and a member of the thread — or the response saying why not. */
  async function posting(
    c: Context<AppEnv>,
  ): Promise<{ me: SignedIn; access: ThreadAccess; form: Record<string, unknown> } | Response> {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody({ all: true });
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await gate(c, deps, me);
    if (access instanceof Response) return access;
    return { me, access, form };
  }

  async function renderDraft(
    c: Context<AppEnv>,
    access: ThreadAccess,
    me: SignedIn,
    q: DraftQuery,
    error: string | null,
    status: 200 | 400 | 409,
  ) {
    const v = await load(deps, access, me);
    if (v.draft === null) return c.redirect(threadPath(access.thread.id), 303);
    return c.html(page(c, "Your draft", draftPage(v, v.draft, q, error)), status);
  }

  app.get(PLANS_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    return c.html(page(c, "Plans", await yourPlans(deps.storage, me.personId)));
  });

  app.get(`${PLANS_PATH}/new`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    return c.html(
      page(
        c,
        "Start planning",
        await newThreadForm(deps, me, { name: "", tzid: "", emails: [] }, null),
      ),
    );
  });

  app.post(PLANS_PATH, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody({ all: true });
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const values = {
      name: str(form, "name"),
      tzid: str(form, "tzid").trim(),
      emails: strs(form, "email")
        .map((e) => e.trim())
        .filter((e) => e !== ""),
    };
    const again = async (error: string) =>
      c.html(page(c, "Start planning", await newThreadForm(deps, me, values, error)), 400);
    const bad = values.emails.filter((e) => {
      try {
        normalizeEmail(e);
        return false;
      } catch {
        return true;
      }
    });
    if (bad.length > 0) return again(`Not an email address: ${bad.join(", ")}`);
    // No limit on members (rc38); addresses typed at once are bounded as for an event.
    if (values.emails.length > MAX_INVITEES)
      return again(`At most ${MAX_INVITEES} addresses at once.`);
    const memberIds: string[] = [];
    const groupId = str(form, "group");
    if (groupId !== "") {
      const membership = await findGroupForMember(deps.storage, groupId, me.personId);
      if (membership === null) return again("Choose one of your groups.");
      for (const m of await listMembers(deps.storage, membership)) memberIds.push(m.personId);
    }
    try {
      const people = await resolveInvitees(
        deps.storage,
        values.emails.map((email) => ({ email, editTier: "view", visibility: "FULL" })),
        {
          now: deps.now(),
          from: { senderId: me.personId, groupId: groupId === "" ? null : groupId },
        },
      );
      memberIds.push(...people.map((p) => p.personId));
      const thread = await createThread(deps.storage, {
        groupId: groupId === "" ? null : groupId,
        name: values.name,
        tzid: values.tzid === "" ? "UTC" : values.tzid,
        creatorId: me.personId,
        memberIds,
        now: deps.now(),
      });
      return c.redirect(threadPath(thread.id), 303);
    } catch (err) {
      const message = problem(err);
      if (message === null) throw err;
      return again(message);
    }
  });

  const renderThread = async (
    c: Context<AppEnv>,
    access: ThreadAccess,
    me: SignedIn,
    notice: string | null = null,
    status: 200 | 400 | 403 | 409 | 503 = 200,
    sharedUrl: string | null = null,
  ) => {
    const v = { ...(await load(deps, access, me)), sharedUrl };
    const day = c.req.query("day") ?? "";
    const id = access.thread.id;
    const appearance = await appearanceSection(
      deps.storage,
      { kind: "thread", id },
      me,
      `${threadPath(id)}/me`,
      "plan",
    );
    return c.html(
      page(
        c,
        access.thread.name,
        html`${threadPage(v, DAY.test(day) ? day : null, notice)}${appearance}
<p class="muted"><a href="${threadPath(id)}/leave">Leave this plan</a></p>`,
      ),
      status,
    );
  };

  app.get(`${PLANS_PATH}/:thread`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await gate(c, deps, me);
    if (access instanceof Response) return access;
    return renderThread(c, access, me);
  });

  // A note with a vote (rc28): from the plan page, back to it.
  app.post(`${PLANS_PATH}/:thread/notes`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const back = str(r.form, "back");
    const v = await load(deps, r.access, r.me);
    const p = v.plans.find((x) => x.id === back);
    const here =
      p === undefined ? threadPath(r.access.thread.id) : planPath(r.access.thread.id, p.id);
    const again = (why: string, status: 400 | 409) =>
      p === undefined
        ? renderThread(c, r.access, r.me, why, status)
        : c.html(page(c, p.name, planPage(v, p, planQuery(c), deps, why)), status);
    try {
      const added = await addVoteNote(deps.storage, r.access, {
        body: str(r.form, "note"),
        now: deps.now(),
      });
      if (added.kind === "closed") return again("Nothing is on the table to note against.", 409);
    } catch (err) {
      const message = problem(err);
      if (message === null) throw err;
      return again(message, 400);
    }
    return c.redirect(here, 303);
  });

  // Vote links by email (rc26): the organizer asks; each member gets their own.
  app.post(`${PLANS_PATH}/:thread/links`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const issued = await issueVoteLinks(deps.storage, r.access, { now: deps.now() });
    if (issued.kind === "forbidden")
      return renderThread(c, r.access, r.me, "Only the organizer sends vote links.", 403);
    if (issued.kind === "closed")
      return renderThread(c, r.access, r.me, "Nothing is on the table to vote on.", 409);
    const me = r.access.members.find((m) => m.personId === r.access.personId);
    const from = me === undefined ? "Someone" : memberName(me);
    const onTable = (await listPlans(deps.storage, r.access)).filter(
      (p) => p.status === "on_table",
    );
    let sent = 0;
    let failed = 0;
    let capped: MailCapReachedError | null = null;
    for (const link of issued.links) {
      if (capped === null) {
        try {
          await sendVoteLink(deps.mail, {
            link,
            access: r.access,
            from,
            publicBaseUrl: deps.publicBaseUrl,
            onTable,
          });
          sent += 1;
          continue;
        } catch (error) {
          if (error instanceof MailCapReachedError) capped = error;
        }
      }
      // Not delivered: withdraw it, so a retry isn't throttled for someone who never got it.
      await revokeUndeliveredVoteLink(deps.storage, link);
      failed += 1;
    }
    const parts = [
      `Sent to ${sent} ${sent === 1 ? "person" : "people"}.`,
      issued.throttled > 0 ? `${issued.throttled} already got a link in the last hour.` : "",
      failed === 0
        ? ""
        : capped === null
          ? `Couldn't send to ${failed} — please try again later.`
          : `Couldn't send to ${failed}. ${cappedText(capped, deps.now(), true)}`,
    ].filter((p) => p !== "");
    return renderThread(c, r.access, r.me, parts.join(" "), failed > 0 ? 503 : 200);
  });

  // The shared link (rc25): the organizer makes it, replaces it, or turns it off.
  app.post(`${PLANS_PATH}/:thread/share`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const issued = await issueShareLink(deps.storage, r.access, { now: deps.now() });
    if (issued.kind === "forbidden")
      return renderThread(c, r.access, r.me, "Only the organizer shares a link.", 403);
    if (issued.kind === "closed")
      return renderThread(c, r.access, r.me, "Nothing is on the table to vote on.", 409);
    // The page carries the link: never cached, never sent on as a referrer (§13).
    sensitive(c);
    const url = new URL(SHARE_PATH, deps.publicBaseUrl);
    url.searchParams.set("t", issued.token);
    const fresh = await findThreadForMember(deps.storage, r.access.thread.id, r.me.personId);
    return renderThread(c, fresh ?? r.access, r.me, null, 200, url.toString());
  });

  app.post(`${PLANS_PATH}/:thread/share/off`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const off = await turnOffShareLink(deps.storage, r.access);
    if (off.kind === "forbidden")
      return renderThread(c, r.access, r.me, "Only the organizer turns the link off.", 403);
    return renderThread(c, r.access, r.me, "The link is off. Anyone who already joined stays in.");
  });

  // Removing a guest (rc30): the organizer's, a POST; the name is then free again.
  // Copy one member's vote link instead of emailing it (rc36): fresh, shown once.
  app.post(`${PLANS_PATH}/:thread/links/copy`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const personId = typeof r.form.person === "string" ? r.form.person : "";
    const issued = await issueVoteLinks(deps.storage, r.access, {
      now: deps.now(),
      only: personId,
      copy: true,
    });
    if (issued.kind === "forbidden")
      return renderThread(c, r.access, r.me, "Only the organizer copies vote links.", 403);
    if (issued.kind === "closed")
      return renderThread(c, r.access, r.me, "Nothing is on the table to vote on.", 409);
    const link = issued.links.find((l) => l.personId === personId);
    const member = r.access.members.find((m) => m.personId === personId);
    if (link === undefined || member === undefined)
      return renderThread(c, r.access, r.me, "They have no link of their own here.", 409);
    sensitive(c);
    return c.html(
      page(
        c,
        "Their link",
        html`${copiedLink(
          memberName(member),
          voteUrl(deps.publicBaseUrl, link.token).toString(),
          VOTE_LINK_TTL_MS / (24 * 60 * 60 * 1000),
          threadPath(r.access.thread.id),
        )}${SHARE_BUTTONS}`,
      ),
    );
  });

  app.post(`${PLANS_PATH}/:thread/guests/remove`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const guest = typeof r.form.guest === "string" ? r.form.guest : "";
    const removed = await removeGuest(deps.storage, r.access, guest);
    if (removed.kind === "forbidden")
      return renderThread(c, r.access, r.me, "Only the organizer removes someone.", 403);
    if (removed.kind === "gone")
      return renderThread(c, r.access, r.me, "They aren't a guest here any more.", 409);
    const fresh = await findThreadForMember(deps.storage, r.access.thread.id, r.me.personId);
    return renderThread(
      c,
      fresh ?? r.access,
      r.me,
      `${removed.name} is removed, with their answers. The name is free again.`,
    );
  });

  // Leaving (DESIGN §10 rc21). GET says what will happen; POST does it.
  app.get(`${PLANS_PATH}/:thread/leave`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await gate(c, deps, me);
    if (access instanceof Response) return access;
    const others = access.members.length - 1;
    const id = access.thread.id;
    return c.html(
      page(
        c,
        "Leave",
        html`<h1>Leave “${access.thread.name}”?</h1>
<p>Your drafts, votes and notes here go, and plans of yours still on the table are withdrawn. What was agreed stays: those are ordinary events now.</p>
${
  others === 0
    ? html`<p class="error">You're the last one planning here, so leaving deletes it.</p>`
    : access.thread.organizerId === me.personId
      ? html`<p>Someone else will organize it: whoever has been in it longest.</p>`
      : ""
}
<form method="post" action="${threadPath(id)}/leave">
  <input type="hidden" name="csrf" value="${me.csrfToken}" />
  <p><button type="submit">${others === 0 ? "Leave and delete it" : "Leave"}</button> <a href="${threadPath(id)}">Stay</a></p>
</form>`,
      ),
    );
  });

  app.post(`${PLANS_PATH}/:thread/leave`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const access = await gate(c, deps, me);
    if (access instanceof Response) return access;
    await leaveThread(deps.storage, access, deps.now());
    return c.redirect(PLANS_PATH, 303);
  });

  // "You appear here as…" (§10 rc21): membership (gate) is the access check.
  app.post(`${PLANS_PATH}/:thread/me`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await gate(c, deps, me);
    if (access instanceof Response) return access;
    const id = access.thread.id;
    return saveAppearance(c, deps.storage, { kind: "thread", id }, threadPath(id));
  });

  app.get(`${PLANS_PATH}/:thread/p/:plan`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await gate(c, deps, me);
    if (access instanceof Response) return access;
    const v = await load(deps, access, me);
    const p = v.plans.find((x) => x.id === c.req.param("plan"));
    if (p === undefined) return notFound(c);
    if (p.status === "draft") return c.redirect(draftPath(access.thread.id), 303);
    return c.html(page(c, p.name, planPage(v, p, planQuery(c), deps, null)));
  });

  app.get(`${PLANS_PATH}/:thread/draft`, async (c) => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    const access = await gate(c, deps, me);
    if (access instanceof Response) return access;
    return renderDraft(c, access, me, draftQuery(c), null, 200);
  });

  // Start a draft: blank, "Suggest changes…" (from), or "Plan the rest…" (from + rest).
  app.post(`${PLANS_PATH}/:thread/drafts`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const from = str(r.form, "from");
    const rest = str(r.form, "rest") === "1";
    const replace = str(r.form, "replace") === "1";
    const result = await startDraft(deps.storage, r.access, {
      fromId: from === "" ? null : from,
      rest,
      replace,
      now: deps.now(),
    });
    const t = r.access.thread.id;
    switch (result.kind) {
      case "started":
        return c.redirect(draftPath(t), 303);
      case "invalid":
        return notFound(c);
      case "has_draft":
        return c.html(
          page(
            c,
            "You have a draft",
            html`${PLAN_STYLE}<div class="pl"><div class="confirm"><p><strong>You have an unsent draft.</strong> Start over ${from === "" ? "with a blank plan" : "from this plan"} instead?</p>
<div class="row"><form method="post" action="${threadPath(t)}/drafts"><input type="hidden" name="csrf" value="${r.me.csrfToken}" />${
              from === "" ? "" : html`<input type="hidden" name="from" value="${from}" />`
            }${rest ? html`<input type="hidden" name="rest" value="1" />` : ""}<input type="hidden" name="replace" value="1" /><button class="primary" type="submit">Start over</button></form>
<a class="btn" href="${draftPath(t)}">Keep my draft</a></div></div></div>`,
          ),
          409,
        );
    }
  });

  app.post(`${PLANS_PATH}/:thread/p/:plan/vote`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const answer = answerSchema.safeParse(str(r.form, "answer"));
    const planId = c.req.param("plan");
    if (!answer.success) return c.redirect(planPath(r.access.thread.id, planId), 303);
    const result = await castVote(deps.storage, r.access, {
      planId,
      answer: answer.data,
      now: deps.now(),
    });
    if (result.kind === "closed" || result.kind === "invalid") {
      const v = await load(deps, r.access, r.me);
      const p = v.plans.find((x) => x.id === planId);
      if (p === undefined) return notFound(c);
      return c.html(
        page(c, p.name, planPage(v, p, planQuery(c), deps, "This plan is no longer on the table.")),
        409,
      );
    }
    return c.redirect(planPath(r.access.thread.id, planId), 303);
  });

  app.post(`${PLANS_PATH}/:thread/p/:plan/suggest`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const planId = c.req.param("plan");
    const again = async (why: string, status: 400 | 409) => {
      const v = await load(deps, r.access, r.me);
      const p = v.plans.find((x) => x.id === planId);
      if (p === undefined) return notFound(c);
      return c.html(page(c, p.name, planPage(v, p, planQuery(c), deps, why)), status);
    };
    const start = str(r.form, "start");
    const end = str(r.form, "end");
    // Whole days are inclusive on the form, exclusive when stored.
    const endLocal = DAY.test(start) && DAY.test(end) ? addDays(end, 1) : end;
    try {
      const result = await suggestTime(deps.storage, r.access, {
        planId,
        startLocal: start,
        endLocal,
        now: deps.now(),
      });
      if (result.kind === "suggested")
        return c.redirect(`${planPath(r.access.thread.id, result.planId)}?sent=1`, 303);
      return again(
        result.kind === "same"
          ? "That time is already on the table."
          : "This plan is no longer on the table.",
        409,
      );
    } catch (err) {
      const message = problem(err);
      if (message === null) throw err;
      return again(message, 400);
    }
  });

  app.post(`${PLANS_PATH}/:thread/p/:plan/accept`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const planId = c.req.param("plan");
    const result = await acceptPlan(deps.storage, r.access, { planId, now: deps.now() });
    if (result.kind === "accepted") return c.redirect(planPath(r.access.thread.id, planId), 303);
    if (result.kind === "invalid") return notFound(c);
    const v = await load(deps, r.access, r.me);
    const p = v.plans.find((x) => x.id === planId);
    if (p === undefined) return notFound(c);
    const why =
      result.kind === "forbidden"
        ? "Only the organizer accepts a plan here."
        : "This plan is no longer on the table.";
    return c.html(
      page(c, p.name, planPage(v, p, planQuery(c), deps, why)),
      result.kind === "forbidden" ? 403 : 409,
    );
  });

  app.post(`${PLANS_PATH}/:thread/p/:plan/withdraw`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    const planId = c.req.param("plan");
    await withdrawPlan(deps.storage, r.access, { planId, now: deps.now() });
    return c.redirect(planPath(r.access.thread.id, planId), 303);
  });

  // The draft's own forms. Each answers by redirecting back to the draft (GET renders).
  const draftEdit = async (
    c: Context<AppEnv>,
    act: (r: {
      me: SignedIn;
      access: ThreadAccess;
      form: Record<string, unknown>;
    }) => Promise<string>,
    onError: (form: Record<string, unknown>) => Partial<DraftQuery> = () => ({}),
  ) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    try {
      return c.redirect(await act(r), 303);
    } catch (err) {
      const message = problem(err);
      if (message === null) throw err;
      return renderDraft(c, r.access, r.me, { ...draftQuery(c), ...onError(r.form) }, message, 400);
    }
  };

  app.post(`${PLANS_PATH}/:thread/draft/events`, (c) =>
    draftEdit(
      c,
      async ({ access, form }) => {
        const result = await addDraftEvent(deps.storage, access, {
          ...readEvent(form),
          now: deps.now(),
        });
        const here = draftPath(access.thread.id);
        if (result.kind === "full") throw new PlanInputError("A plan holds at most 60 events.");
        if (result.kind !== "saved") return threadPath(access.thread.id);
        // A stretch just drawn starts with its end picked up: the next tap says where it ends.
        return `${here}?e=${result.sid}${str(form, "kind") === "days" ? "&grab=end" : ""}`;
      },
      (form) => {
        const day = str(form, "kind") === "days" ? str(form, "from") : str(form, "day");
        return {
          add: DAY.test(day) ? day : null,
          kind: str(form, "kind") === "days" ? "days" : "time",
        };
      },
    ),
  );

  app.post(`${PLANS_PATH}/:thread/draft/events/:sid`, (c) =>
    draftEdit(
      c,
      async ({ access, form }) => {
        const sid = c.req.param("sid");
        const result = await updateDraftEvent(deps.storage, access, {
          ...readEvent(form),
          sid,
          now: deps.now(),
        });
        const here = draftPath(access.thread.id);
        return result.kind === "saved" ? `${here}?e=${sid}` : here;
      },
      () => ({ e: c.req.param("sid") }),
    ),
  );

  app.post(`${PLANS_PATH}/:thread/draft/events/:sid/remove`, (c) =>
    draftEdit(c, async ({ access }) => {
      await removeDraftEvent(deps.storage, access, { sid: c.req.param("sid"), now: deps.now() });
      return draftPath(access.thread.id);
    }),
  );

  app.post(`${PLANS_PATH}/:thread/draft/events/:sid/again`, (c) =>
    draftEdit(c, async ({ access }) => {
      const here = draftPath(access.thread.id);
      const d = (await listPlans(deps.storage, access)).find((p) => p.status === "draft");
      const e = d?.events.find((x) => x.sid === c.req.param("sid"));
      if (e === undefined) return here;
      const later = (k: string) =>
        e.allDay ? addDays(k, 7) : `${addDays(k.slice(0, 10), 7)}${k.slice(10)}`;
      const result = await addDraftEvent(deps.storage, access, {
        title: e.title,
        allDay: e.allDay,
        startLocal: later(e.startLocal),
        endLocal: later(e.endLocal),
        who: e.who,
        now: deps.now(),
      });
      if (result.kind === "full") throw new PlanInputError("A plan holds at most 60 events.");
      return result.kind === "saved" ? `${here}?e=${result.sid}` : here;
    }),
  );

  app.post(`${PLANS_PATH}/:thread/draft/bring/:sid`, (c) =>
    draftEdit(c, async ({ access }) => {
      const result = await bringBack(deps.storage, access, {
        sid: c.req.param("sid"),
        now: deps.now(),
      });
      const here = draftPath(access.thread.id);
      if (result.kind === "full") throw new PlanInputError("A plan holds at most 60 events.");
      return result.kind === "saved" ? `${here}?e=${result.sid}` : here;
    }),
  );

  app.post(`${PLANS_PATH}/:thread/draft/clip`, (c) =>
    draftEdit(
      c,
      async ({ access, form }) => {
        await clipDraft(deps.storage, access, {
          first: str(form, "first"),
          last: str(form, "last"),
          keep: str(form, "keep") !== "0",
          now: deps.now(),
        });
        return draftPath(access.thread.id);
      },
      () => ({ range: true }),
    ),
  );

  app.post(`${PLANS_PATH}/:thread/draft/details`, (c) =>
    draftEdit(c, async ({ access, form }) => {
      const here = draftPath(access.thread.id);
      const saved = await setDraftDetails(deps.storage, access, {
        name: str(form, "name"),
        message: str(form, "message"),
        now: deps.now(),
      });
      if (saved.kind === "no_draft") return threadPath(access.thread.id);
      if (str(form, "after") !== "send") return here;
      const sent = await sendDraft(deps.storage, access, { now: deps.now() });
      if (sent.kind === "empty") throw new PlanInputError("Add an event before sending.");
      return sent.kind === "sent" ? `${planPath(access.thread.id, sent.planId)}?sent=1` : here;
    }),
  );

  app.post(`${PLANS_PATH}/:thread/draft/discard`, async (c) => {
    const r = await posting(c);
    if (r instanceof Response) return r;
    await discardDraft(deps.storage, r.access);
    return c.redirect(threadPath(r.access.thread.id), 303);
  });
}
