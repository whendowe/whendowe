// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { StoragePort } from "../../db/port.js";
import {
  answerRequest,
  type EventAccess,
  listVerifiedRequests,
  type RequestKind,
  type RequestLink,
  resolveRequestLink,
  type VerifiedRequest,
} from "../../events/event.js";
import { canSee, listParticipants } from "../../events/participation.js";
import { type Answer, answerSchema } from "../../events/poll.js";
import {
  type Arrival,
  type Attendance,
  acknowledge,
  addFeedback,
  answerProposal,
  attendanceSchema,
  type IssuedLink,
  needsAcknowledgment,
  RESPONSE_TOKEN_TTL_MS,
  type ReceiptUnsent,
  type ResolvedLink,
  recordUnsentReceipt,
  resolveResponseLink,
  setAttendance,
  setOwnAnswersOnly,
} from "../../events/response.js";
import { MailCapReachedError } from "../../mail/capped.js";
import type { MailPort } from "../../mail/port.js";
import { findPersonById } from "../../people/person.js";
import { addVoteNote, listNotes, type PlanNote } from "../../plans/note.js";
import {
  castVote,
  listPlans,
  type Plan,
  type PlanEvent,
  PlanInputError,
} from "../../plans/plan.js";
import {
  answerThreadRequest,
  listThreadRequests,
  memberName,
  recordUnsentThreadReceipt,
  resolveThreadRequestLink,
  type ThreadAccess,
  type ThreadRequestLink,
} from "../../plans/thread.js";
import {
  type IssuedVoteLink,
  type ResolvedVoteLink,
  resolveVoteLink,
  setThreadOwnAnswersOnly,
  VOTE_LINK_TTL_MS,
} from "../../plans/vote-link.js";
import { dayLabel, spanText, whenText } from "../../plans/weeks.js";
import { retainLabel } from "../../privacy/retention.js";
import { isSuppressed } from "../../privacy/suppression.js";
import {
  type Html,
  html,
  ownAnswersForm,
  PLANS_PATH,
  type Preview,
  renderPage,
} from "../layout.js";
import { busyAssets, busyAttrs, busyClash, PLAN_STYLE } from "../plan-editor.js";
import type { AppEnv } from "../session.js";
import { BUSY_LABEL, describeRRule, EVENTS_PATH, formatWhen, verifiedLine } from "./events.js";

// Account-less responses (MVP-2 slice 2D; WORKFLOWS §2: responding never requires an
// account). The emailed link IS the person, for one event and one question:
//
//   GET  /respond?t=…   the page — renders, NEVER changes anything (mail scanners
//                       open every link; DESIGN §13)
//   POST /respond       the answer: vote / attendance, plus an optional note
//
// The link never signs anyone in. Everything shown is at the person's own visibility
// tier, re-checked on every request by resolveResponseLink. Token-bearing responses
// send no-referrer and no-store, like the sign-in pages.

export const RESPOND_PATH = "/respond";
/** A thread's vote link (rc26): the same rules, for plans. */
export const VOTE_PATH = "/vote";

/** An event's answer link, as it is emailed or copied (rc36). */
/** Answering a request everyone must agree to, by the link mailed to you (rc42). */
export const AGREE_PATH = "/agree";

/** What a request asks, as a phrase: "stop verifying answers here". */
export function requestWhat(kind: RequestKind, retainDays: number | null): string {
  switch (kind) {
    case "unverify":
      return "stop verifying answers here";
    case "remove":
      return "remove it for good";
    case "shorten":
      return `keep it for ${retainLabel(retainDays ?? 0)} instead`;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

export function respondUrl(publicBaseUrl: string, token: string): URL {
  const url = new URL(RESPOND_PATH, publicBaseUrl);
  url.searchParams.set("t", token);
  return url;
}

/** A thread's vote link, as it is emailed or copied (rc36). */
export function voteUrl(publicBaseUrl: string, token: string): URL {
  const url = new URL(VOTE_PATH, publicBaseUrl);
  url.searchParams.set("t", token);
  return url;
}

export interface RespondRouteDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
  /** Receipts on verified events and threads (rc42) go out through it. */
  readonly mail: MailPort;
  /** Links are built from this, never the Host header. */
  readonly publicBaseUrl: string;
}

const tokenSchema = z.string().min(1).max(256);
const ATTENDANCE_LABEL: Record<Attendance, string> = {
  going: "I'm going",
  maybe: "Maybe",
  not_going: "Can't make it",
};
const ANSWER_LABEL: Record<Answer, string> = { yes: "Yes", ifneedbe: "If need be", no: "No" };

export function sensitive(c: Context<AppEnv>): void {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
}

/**
 * These pages act as the link's person, not as any account signed in on this browser
 * (§13: the link is the identity, and never touches a session). A "Signed in as"
 * header here would suggest the answer goes out as that account, so they have none.
 */
export function linkPage(title: string, body: Html, preview: Preview | null = null): string {
  return renderPage(title, body, null, preview);
}

/** At most this many times in a card; the rest are counted. */
const PREVIEW_TIMES = 3;

/**
 * A question's card in a chat (§10 rc25): its name and the times on the table. A plan of
 * several events is its count and span, not its name, which may name a person.
 */
/**
 * The one time on the table, when that is all there is: one plan of one event (rc33).
 * The vote form, the chat's card and the email all ask about it as one question.
 */
export function oneTime(onTable: readonly Plan[]): PlanEvent | null {
  const [only, ...others] = onTable;
  const [e, ...more] = only?.events ?? [];
  return others.length === 0 && more.length === 0 ? (e ?? null) : null;
}

export function questionPreview(name: string, onTable: readonly Plan[]): Preview {
  if (onTable.length === 0) return { title: name, description: "Nothing to vote on any more." };
  const one = oneTime(onTable);
  if (one !== null) return { title: name, description: `Does this work for you? ${whenText(one)}` };
  const times = onTable.map((p) => {
    const [e, ...more] = p.events;
    return e !== undefined && more.length === 0
      ? whenText(e)
      : `${p.events.length} events, ${spanText(p.events)}`;
  });
  const rest = times.length - PREVIEW_TIMES;
  return {
    title: name,
    description: `Which of these work for you? ${times.slice(0, PREVIEW_TIMES).join(" · ")}${
      rest > 0 ? ` · and ${rest} more` : ""
    }`,
  };
}

export function deadLink(): string {
  return linkPage(
    "Link no longer works",
    html`<h1>This link no longer works</h1>
<p>It may have expired, or a newer one was sent to you. Ask the organizer to send it again.</p>`,
  );
}

function header(access: EventAccess): Html {
  const { event, participation } = access;
  const title = canSee(participation.visibility, "title") ? event.title : BUSY_LABEL;
  const when = html`<p>${formatWhen(event)}${event.status === "cancelled" ? " — cancelled" : ""}</p>${
    event.rrule === null ? "" : html`<p>↻ ${describeRRule(event.rrule)}</p>`
  }`;
  const where =
    canSee(participation.visibility, "location") && event.location !== null
      ? html`<p>📍 ${event.location}</p>`
      : "";
  return html`<h1>${title}</h1>${verifiedLine(event)}${when}${where}`;
}

function respondPage(
  link: ResolvedLink,
  token: string,
  notice: Html | string,
  /** For a copied link (rc42): the name of whoever copied it, "someone" once they're gone. */
  givenBy: string | null,
): string {
  const { access, action } = link;
  const { event, participation } = access;
  // A vote link is a consent proposal's (rc13); an event-poll's links closed with it (rc35).
  const open =
    (action === "vote" && event.status === "proposed" && participation.responseKind === "accept") ||
    (action === "attend" && event.status === "scheduled");

  let question: Html | string = "";
  if (action === "vote" && open) {
    // A consent proposal (DESIGN §10 rc13): one time, agree or decline.
    const current = participation.responseState;
    question = html`<h2>Do you agree?</h2>
<p>${[
      ["accept", "I agree", current === "accepted"],
      ["decline", "I don't agree", current === "declined"],
    ].map(
      ([value, label, checked]) =>
        html`<label style="margin-right:.8em"><input type="radio" name="decision" value="${String(value)}" ${checked === true ? html`checked` : ""} /> ${String(label)}</label>`,
    )}</p>
<p class="muted">It goes ahead only when everyone asked agrees; one "no" turns it down.</p>`;
  } else if (action === "attend" && open) {
    question = html`<h2>Are you coming?</h2>
<p>${attendanceSchema.options.map(
      (a) =>
        html`<label style="margin-right:.8em"><input type="radio" name="attendance" value="${a}" ${participation.attendance === a ? html`checked` : ""} /> ${ATTENDANCE_LABEL[a]}</label>`,
    )}</p>${
      needsAcknowledgment(access)
        ? html`<p><label><input type="checkbox" name="ack" value="on" /> ${
            participation.responseState === "reack"
              ? "I've seen what changed"
              : "I've seen this (the organizer asked you to confirm)"
          }</label></p>`
        : ""
    }`;
  } else if (action === "vote" && event.status === "scheduled") {
    question =
      participation.responseKind === "accept"
        ? html`<p><strong>It's settled.</strong> The time is ${formatWhen(event)}.</p>`
        : html`<p><strong>Voting has closed.</strong> The time is ${formatWhen(event)}.</p>`;
  } else {
    question = html`<p><strong>There's nothing to answer here any more.</strong></p>`;
  }

  const form = open
    ? html`<form method="post" action="${RESPOND_PATH}">
  <input type="hidden" name="t" value="${token}" />
  ${question}
  <p><label>Anything to add? <span class="muted">(optional — e.g. "might be late")</span><br />
  <textarea name="note" rows="2" maxlength="500" style="width:100%"></textarea></label></p>
  <p><button type="submit">Send my answer</button></p>
</form>`
    : question;

  // rc42: only from a link mailed to them can a person change this here.
  const own =
    link.arrival?.via === "mailed" && access.event.verifiedAt === null
      ? ownAnswersForm({
          action: `${RESPOND_PATH}/own-answers`,
          hidden: { t: token },
          on: participation.ownAnswersOnly,
          where: "here",
        })
      : "";
  return linkPage(
    "Your answer",
    html`${notice}${header(access)}
${form}
${own}
<p class="muted">${
      givenBy === null ? "" : html`${givenBy} gave you this link, and your answer will say so. `
    }This link is just for you — please don't forward it. No account needed.</p>`,
  );
}

/** Who copied this link, for the page to say (rc42); null for a mailed or an older link. */
async function givenBy(storage: StoragePort, link: ResolvedLink): Promise<string | null> {
  if (link.arrival?.via !== "copied") return null;
  const people = await listParticipants(storage, link.access.event.id);
  const names = new Map(people.map((p) => [p.personId, p.shown.name]));
  return names.get(link.arrival.by ?? "") ?? "Someone";
}

/** rc42: the line a verified thread's pages carry. */
export function threadVerifiedLine(t: Pick<ThreadAccess["thread"], "verifiedAt">): Html | string {
  return t.verifiedAt === null
    ? ""
    : html`<p class="wd-verified"><strong>Answers here are verified:</strong> each person's own email, or signed in.</p>`;
}

// --- A thread's vote link (DESIGN §10 rc26) ---------------------------------------------

/** Notes on days (rc28), attributed by the author's name in the thread; bodies escaped. */
export function noteList(
  notes: readonly PlanNote[],
  nameOf: (id: string) => string,
): Html | string {
  if (notes.length === 0) return "";
  const days = (n: PlanNote) =>
    n.firstDay === n.lastDay
      ? dayLabel(n.firstDay)
      : `${dayLabel(n.firstDay)} – ${dayLabel(n.lastDay)}`;
  return html`<ul class="notes">${notes.map(
    (n) =>
      html`<li><strong>${nameOf(n.authorId)}</strong> <span class="muted">on ${days(n)}:</span> <span style="white-space:pre-line">${n.body}</span></li>`,
  )}</ul>`;
}

/**
 * One plan on the table, as the link's person votes on it: a card, then the choices.
 * `personId` is "" for someone not in the thread yet (a shared link, rc25).
 */
type Voter = Pick<ThreadAccess, "members" | "personId">;

function mineOf(voter: Voter, p: Plan, chosen: ReadonlyMap<string, Answer>): Answer | null {
  return chosen.get(p.id) ?? p.votes.find((v) => v.personId === voter.personId)?.answer ?? null;
}

/** A plan on the table: when, or its name and span, then who suggested it and the counts. */
function planSummary(access: Voter, p: Plan): Html {
  const [e, ...more] = p.events;
  const author = access.members.find((m) => m.personId === p.authorId);
  const n = (a: Answer) => p.votes.filter((v) => v.answer === a).length;
  const what =
    e !== undefined && more.length === 0
      ? html`<strong>${whenText(e)}</strong>${busyClash(p.events)}${e.location === null ? "" : html`<br />📍 ${e.location}`}${
          e.description === null ? "" : html`<br /><span class="muted">${e.description}</span>`
        }`
      : html`<strong>${p.name}</strong> · ${p.events.length} events, ${spanText(p.events)}${busyClash(p.events)}`;
  return html`${what}<br /><span class="muted">${author === undefined ? "" : `from ${memberName(author)} · `}${n("yes")} yes · ${n("ifneedbe")} if need be · ${n("no")} no</span>`;
}

function votePlan(
  access: Voter,
  p: Plan,
  /** What the form had chosen, when it comes back with a problem. */
  chosen: ReadonlyMap<string, Answer> = new Map(),
): Html {
  const mine = mineOf(access, p, chosen);
  return html`<li>${planSummary(access, p)}<br />
${answerSchema.options.map(
  (a) =>
    html`<label style="margin-right:.8em"><input type="radio" name="plan_${p.id}" value="${a}" ${mine === a ? html`checked` : ""} /> ${ANSWER_LABEL[a]}</label>`,
)}</li>`;
}

/**
 * The answer part of a vote form, after any name. One time on the table (one plan of one
 * event) is an easy decision, so it is one tap (rc31): each answer is its own submit button, sending the
 * note with it. More than one is a mark each and a send. The first submit button is a
 * disabled, hidden one, so Enter in a field submits nothing rather than picking "Yes".
 */
export function answerPart(
  voter: Voter,
  onTable: readonly Plan[],
  note: Html,
  send: Html,
  chosen: ReadonlyMap<string, Answer> = new Map(),
): Html {
  const [only] = onTable;
  if (only === undefined || oneTime(onTable) === null)
    return html`<h2>Which of these work for you?</h2>
  <ul class="stack" style="list-style:none;padding:0;margin:0">${onTable.map((p) => votePlan(voter, p, chosen))}</ul>
  ${note}
  <p>${send}</p>`;
  const mine = mineOf(voter, only, chosen);
  return html`<h2>Does this work for you?</h2>
  <p>${planSummary(voter, only)}</p>
  ${note}
  <div class="seg" role="group" aria-label="Your answer"><button type="submit" disabled hidden></button>${answerSchema.options.map(
    (a) =>
      html`<button type="submit" name="plan_${only.id}" value="${a}" aria-pressed="${String(mine === a)}">${ANSWER_LABEL[a]}</button>`,
  )}</div>
  ${mine === null ? "" : html`<p class="muted">You said ${ANSWER_LABEL[mine]}. Tap another to change it.</p>`}`;
}

/**
 * A vote link works without a session, and may be opened where someone else is signed in:
 * busy times are the signed-in person's, so they show only when that is who it is for.
 */
function ownLink(c: Context<AppEnv>, access: ThreadAccess): boolean {
  return c.get("signedIn")?.personId === access.personId;
}

async function votePage(
  storage: StoragePort,
  access: ThreadAccess,
  token: string,
  notice: Html | string,
  /** Whether the signed-in person is the one this link is for: then busy times show (rc41). */
  own: boolean,
  /** Who copied this link, for the page to say (rc42); null for a mailed or an older link. */
  givenBy: string | null,
  /** Whether this link was mailed to them: only then may it change their own switch (rc42). */
  mailed: boolean,
): Promise<string> {
  const plans = await listPlans(storage, access);
  const ownSwitch =
    mailed && access.thread.verifiedAt === null
      ? ownAnswersForm({
          action: `${VOTE_PATH}/own-answers`,
          hidden: { t: token },
          on: access.members.find((m) => m.personId === access.personId)?.ownAnswersOnly === true,
          where: "here",
        })
      : "";
  const onTable = plans.filter((p) => p.status === "on_table");
  const names = new Map(access.members.map((m) => [m.personId, memberName(m)]));
  const notes = noteList(await listNotes(storage, access), (id) => names.get(id) ?? "someone");
  const body =
    onTable.length === 0
      ? html`<p><strong>There's nothing to vote on any more.</strong> Whatever was agreed is in the calendars of everyone in it.</p>`
      : html`<form class="stack" method="post" action="${VOTE_PATH}">
  <input type="hidden" name="t" value="${token}" />
  ${answerPart(
    access,
    onTable,
    html`<p><label>Anything to add? <span class="muted">(optional — everyone in it sees it, e.g. "Thursday's bad next week")</span><br />
  <textarea name="note" rows="2" maxlength="500" class="wide"></textarea></label></p>`,
    html`<button type="submit">Send my answer</button>`,
  )}
</form>`;
  return linkPage(
    "Your vote",
    // The plan pages' look (rc19), so a link page and a plan page answer alike.
    html`${PLAN_STYLE}<div class="pl"${busyAttrs(own ? access.thread.tzid : null)}>${notice}<h1>${access.thread.name}</h1>${threadVerifiedLine(access.thread)}
${body}
${notes === "" ? "" : html`<h2>Notes</h2>${notes}`}
${ownSwitch}
<p class="muted">${
      givenBy === null ? "" : html`${givenBy} gave you this link, and your answer will say so. `
    }This link is just for you — please don't forward it. No account needed.</p></div>${own ? busyAssets() : ""}`,
    questionPreview(access.thread.name, onTable),
  );
}

/** Who copied this vote link, by their name in the thread (rc42); null for a mailed or older link. */
function voteGivenBy(link: ResolvedVoteLink): string | null {
  if (link.arrival?.via !== "copied") return null;
  const by = link.access.members.find((m) => m.personId === link.arrival?.by);
  return by === undefined ? "Someone" : memberName(by);
}

/** plan_<id> fields → answers; anything else is ignored. */
export function readVotes(form: Record<string, unknown>): Map<string, Answer> {
  const votes = new Map<string, Answer>();
  for (const [key, value] of Object.entries(form)) {
    const id = /^plan_([0-9a-f-]{1,64})$/.exec(key)?.[1];
    const answer = answerSchema.safeParse(value);
    if (id !== undefined && answer.success) votes.set(id, answer.data);
  }
  return votes;
}

export function readToken(value: unknown): string | null {
  const parsed = tokenSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface Answers {
  readonly votes: ReadonlyMap<string, Answer>;
  readonly note: string;
}

/** The votes and note a vote form sent, or null when it sent neither. */
export function readAnswers(form: Record<string, unknown>): Answers | null {
  const votes = readVotes(form);
  const note = typeof form.note === "string" ? form.note : "";
  return votes.size === 0 && note.trim() === "" ? null : { votes, note };
}

/**
 * Record a vote form's note and votes as this member: null when all went in, else why
 * not, for the page to say. The note first: a yes below may agree a time and leave
 * nothing on the table to note against.
 */
export async function applyAnswers(
  storage: StoragePort,
  access: ThreadAccess,
  answers: Answers,
  now: string,
  /** How these votes arrive (rc42). */
  arrival: Arrival | null,
): Promise<{
  readonly refused: { readonly message: string; readonly status: 400 | 409 } | null;
  /** What went in, for a receipt (rc42). */
  readonly recorded: readonly VoteReceiptLine[];
}> {
  let closed = false;
  let agreed = false;
  const recorded: VoteReceiptLine[] = [];
  if (answers.note.trim() !== "") {
    try {
      if ((await addVoteNote(storage, access, { body: answers.note, now })).kind === "closed")
        closed = true;
      else recorded.push({ kind: "note" });
    } catch (err) {
      if (err instanceof PlanInputError)
        return { refused: { message: err.message, status: 400 }, recorded };
      throw err;
    }
  }
  for (const [planId, answer] of answers.votes) {
    const result = await castVote(storage, access, { planId, answer, now, arrival });
    if (result.kind === "accepted" || result.kind === "recorded")
      recorded.push({ kind: "vote", planId, answer });
    if (result.kind === "accepted") agreed = true;
    if (result.kind === "closed" || result.kind === "invalid" || result.kind === "forbidden")
      closed = true;
  }
  // A yes here that agreed a time replaced the rest of its question: not a refusal.
  return {
    refused:
      closed && !agreed
        ? {
            message: "Something you answered was decided meanwhile. Your other answers are saved.",
            status: 409,
          }
        : null,
    recorded,
  };
}

/** One line of a vote receipt: a vote on a plan, or a note (rc42). */
export type VoteReceiptLine =
  | { readonly kind: "vote"; readonly planId: string; readonly answer: Answer }
  | { readonly kind: "note" };

const VOTE_WORD: Record<Answer, string> = { yes: "yes", ifneedbe: "if need be", no: "no" };

/**
 * A receipt for votes in a verified thread (rc42), as sendEventReceipt is for an event:
 * one per answering POST, to the member they belong to, however they arrived. Plan names
 * and the thread's name, which everyone in it sees; a note is said to have been added,
 * never what it says. Opt-outs and the answerer's mail share apply; one that didn't go out
 * is recorded for the thread's history. Never throws.
 */
export async function sendThreadReceipt(
  deps: Pick<RespondRouteDeps, "storage" | "mail" | "publicBaseUrl">,
  access: ThreadAccess,
  input: {
    readonly recorded: readonly VoteReceiptLine[];
    readonly arrival: Arrival | null;
    readonly now: string;
  },
): Promise<void> {
  const { thread } = access;
  if (thread.verifiedAt === null || input.recorded.length === 0) return;
  const person = await findPersonById(deps.storage, access.personId);
  if (person === null) return;
  const unsent = (reason: ReceiptUnsent) =>
    recordUnsentThreadReceipt(deps.storage, {
      threadId: thread.id,
      personId: person.id,
      reason,
      now: input.now,
    });
  if (
    await isSuppressed(deps.storage, person.email, { senderId: person.id, groupId: thread.groupId })
  )
    return unsent("suppressed");
  const plans = await listPlans(deps.storage, access);
  const nameOf = (id: string) => plans.find((p) => p.id === id)?.name ?? "a plan";
  const how =
    input.arrival?.via === "session" ? "signed in as you" : "with the link emailed to you";
  try {
    await deps.mail.send({
      to: person.email,
      subject: `Your answer in "${thread.name}"`,
      cause: {
        kind: "from",
        senderId: person.id,
        groupId: thread.groupId,
        why: "an answer was given for you in a plan whose answers are verified",
      },
      text: [
        `An answer was given for you in "${thread.name}":`,
        "",
        ...input.recorded.map((line) =>
          line.kind === "note"
            ? "- You added a note"
            : `- "${nameOf(line.planId)}": ${VOTE_WORD[line.answer]}`,
        ),
        "",
        `When: ${input.now.slice(0, 16).replace("T", " ")} UTC`,
        `How: ${how}`,
        "",
        `See it: ${new URL(`${PLANS_PATH}/${thread.id}`, deps.publicBaseUrl).toString()}`,
        "",
        "If this wasn't you, someone who can read your email, or a device still signed in as you, answered for you. Sign in, change the answer, and sign out everywhere from your account page.",
        "",
        "Answers in this plan are verified, so every answer sends a receipt like this one.",
      ].join("\n"),
    });
  } catch (error) {
    await unsent(error instanceof MailCapReachedError ? "capped" : "failed");
  }
}

export function registerRespondRoutes(app: Hono<AppEnv>, deps: RespondRouteDeps): void {
  app.get(RESPOND_PATH, async (c) => {
    sensitive(c);
    const token = readToken(c.req.query("t"));
    const link = token === null ? null : await resolveResponseLink(deps.storage, token, deps.now());
    if (token === null || link === null) return c.html(deadLink(), 404);
    const notice =
      c.req.query("saved") === "1"
        ? html`<p><strong>Thanks — your answer is saved.</strong> You can change it any time with this link.</p>`
        : "";
    return c.html(respondPage(link, token, notice, await givenBy(deps.storage, link)));
  });

  app.post(RESPOND_PATH, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = readToken(form.t);
    const now = deps.now();
    // Resolved again on the POST: the tier, the participation and the link itself are
    // re-checked at the moment of acting, not trusted from when the page was rendered.
    const link = token === null ? null : await resolveResponseLink(deps.storage, token, now);
    if (token === null || link === null) return c.html(deadLink(), 404);
    const { access, action, arrival } = link;
    const copier = await givenBy(deps.storage, link);
    const problem = (message: string, status: 400 | 409) =>
      c.html(respondPage(link, token, html`<p class="error">${message}</p>`, copier), status);

    let answered = false;
    // What this POST recorded, for its receipt (rc42): one receipt per answering POST.
    const lines: ReceiptLine[] = [];
    if (action === "vote" && access.participation.responseKind === "accept") {
      const decision =
        form.decision === "accept" || form.decision === "decline" ? form.decision : null;
      if (decision !== null) {
        answered = true;
        const result = await answerProposal(deps.storage, access, {
          answer: decision,
          now,
          arrival,
        });
        if (result.kind !== "recorded") return problem("This has already been settled.", 409);
        lines.push(decision);
      }
    } else {
      const attendance = attendanceSchema.safeParse(form.attendance);
      if (attendance.success) {
        answered = true;
        const result = await setAttendance(deps.storage, access, {
          attendance: attendance.data,
          now,
          arrival,
        });
        if (result.kind !== "recorded")
          return problem("This event can't take answers any more.", 409);
        lines.push(attendance.data);
      }
      if (form.ack === "on" && needsAcknowledgment(access)) {
        answered = true;
        const result = await acknowledge(deps.storage, access, { now, arrival });
        if (result.kind !== "recorded")
          return problem("This event can't take answers any more.", 409);
        lines.push("acknowledge");
      }
    }
    const note = typeof form.note === "string" ? form.note : "";
    if (!answered && note.trim() === "") return problem("Pick an answer first.", 400);
    if (note.trim() !== "") {
      const result = await addFeedback(deps.storage, access, { body: note, now, arrival });
      if (result.kind === "invalid") return problem(result.reason, 400);
      if (result.kind !== "recorded") return problem("This event can't take notes any more.", 409);
      lines.push("note");
    }
    await sendEventReceipt(deps, access, { answered: lines, arrival, now });
    // Post/redirect/get, so a refresh can't re-send a note. The Location carries the
    // same link the person was emailed; it is never logged (§13).
    const back = new URL(RESPOND_PATH, "http://placeholder");
    back.searchParams.set("t", token);
    back.searchParams.set("saved", "1");
    return c.redirect(`${back.pathname}${back.search}`, 303);
  });

  // rc42: "only my own email answers for me", from the person's own mailed link. The
  // domain refuses a copied link, whatever this page showed.
  app.post(`${RESPOND_PATH}/own-answers`, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = readToken(form.t);
    const link = token === null ? null : await resolveResponseLink(deps.storage, token, deps.now());
    if (token === null || link === null) return c.html(deadLink(), 404);
    const saved = await setOwnAnswersOnly(deps.storage, link.access, {
      on: form.on === "1",
      arrival: link.arrival,
    });
    if (saved === "forbidden")
      return c.html(
        respondPage(
          link,
          token,
          html`<p class="error">Only a link sent to your own address can change that.</p>`,
          await givenBy(deps.storage, link),
        ),
        403,
      );
    const back = new URL(RESPOND_PATH, "http://placeholder");
    back.searchParams.set("t", token);
    return c.redirect(`${back.pathname}${back.search}`, 303);
  });

  // rc42: "only my own email answers for me" in a thread, from the person's own mailed vote
  // link. The domain refuses a copied link, whatever this page showed.
  app.post(`${VOTE_PATH}/own-answers`, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = readToken(form.t);
    const link = token === null ? null : await resolveVoteLink(deps.storage, token, deps.now());
    if (token === null || link === null) return c.html(deadLink(), 404);
    const saved = await setThreadOwnAnswersOnly(deps.storage, link.access, {
      on: form.on === "1",
      arrival: link.arrival,
    });
    if (saved === "forbidden")
      return c.html(
        await votePage(
          deps.storage,
          link.access,
          token,
          html`<p class="error">Only a link sent to your own address can change that.</p>`,
          ownLink(c, link.access),
          voteGivenBy(link),
          false,
        ),
        403,
      );
    const back = new URL(VOTE_PATH, "http://placeholder");
    back.searchParams.set("t", token);
    return c.redirect(`${back.pathname}${back.search}`, 303);
  });

  app.get(AGREE_PATH, async (c) => {
    sensitive(c);
    const token = readToken(c.req.query("t"));
    const now = deps.now();
    const link = token === null ? null : await resolveRequestLink(deps.storage, token, now);
    if (token !== null && link === null) {
      const thread = await resolveThreadRequestLink(deps.storage, token, now);
      if (thread !== null)
        return c.html(await threadAgreePage(deps.storage, thread, token, "", now));
    }
    if (token === null || link === null) return c.html(deadLink(), 404);
    const requests = await listVerifiedRequests(deps.storage, link.access, now);
    return c.html(
      agreePage(
        link.access,
        requests.find((r) => r.id === link.requestId),
        token,
        "",
      ),
    );
  });

  app.post(AGREE_PATH, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = readToken(form.t);
    const now = deps.now();
    const link = token === null ? null : await resolveRequestLink(deps.storage, token, now);
    const answer = form.answer === "yes" || form.answer === "no" ? form.answer : null;
    if (token !== null && link === null) {
      const thread = await resolveThreadRequestLink(deps.storage, token, now);
      if (thread !== null) {
        const page = async (message: string, status: 400 | 409) =>
          c.html(
            await threadAgreePage(
              deps.storage,
              thread,
              token,
              html`<p class="error">${message}</p>`,
              now,
            ),
            status,
          );
        if (answer === null) return page("Pick yes or no.", 400);
        const result = await answerThreadRequest(deps.storage, thread.access, {
          requestId: thread.requestId,
          answer,
          via: "mailed",
          now,
        });
        if (result.kind !== "recorded") return page("This was decided meanwhile.", 409);
        const back = new URL(AGREE_PATH, "http://placeholder");
        back.searchParams.set("t", token);
        return c.redirect(`${back.pathname}${back.search}`, 303);
      }
    }
    if (token === null || link === null) return c.html(deadLink(), 404);
    const again = async (message: string, status: 400 | 409) => {
      const requests = await listVerifiedRequests(deps.storage, link.access, now);
      return c.html(
        agreePage(
          link.access,
          requests.find((r) => r.id === link.requestId),
          token,
          html`<p class="error">${message}</p>`,
        ),
        status,
      );
    };
    if (answer === null) return again("Pick yes or no.", 400);
    const result = await answerRequest(deps.storage, link.access, {
      requestId: link.requestId,
      answer,
      via: "mailed",
      now,
    });
    if (result.kind !== "recorded") return again("This was decided meanwhile.", 409);
    if (
      result.outcome === "agreed" &&
      (await resolveRequestLink(deps.storage, token, now)) === null
    )
      return c.html(
        linkPage("Removed", html`<h1>Everyone agreed</h1><p>The event is removed for good.</p>`),
      );
    const back = new URL(AGREE_PATH, "http://placeholder");
    back.searchParams.set("t", token);
    return c.redirect(`${back.pathname}${back.search}`, 303);
  });

  app.get(VOTE_PATH, async (c) => {
    sensitive(c);
    const token = readToken(c.req.query("t"));
    const link = token === null ? null : await resolveVoteLink(deps.storage, token, deps.now());
    if (token === null || link === null) return c.html(deadLink(), 404);
    const { access } = link;
    const notice =
      c.req.query("saved") === "1"
        ? html`<p><strong>Thanks — your vote is saved.</strong> You can change it any time with this link.</p>`
        : "";
    return c.html(
      await votePage(
        deps.storage,
        access,
        token,
        notice,
        ownLink(c, access),
        voteGivenBy(link),
        link.arrival?.via === "mailed",
      ),
    );
  });

  app.post(VOTE_PATH, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = readToken(form.t);
    const now = deps.now();
    // Resolved again on the POST: membership is re-checked at the moment of acting.
    const link = token === null ? null : await resolveVoteLink(deps.storage, token, now);
    if (token === null || link === null) return c.html(deadLink(), 404);
    const { access } = link;
    const answers = readAnswers(form);
    const refuse = async (message: string, status: 400 | 409) =>
      c.html(
        await votePage(
          deps.storage,
          access,
          token,
          html`<p class="error">${message}</p>`,
          ownLink(c, access),
          voteGivenBy(link),
          link.arrival?.via === "mailed",
        ),
        status,
      );
    if (answers === null) return refuse("Pick an answer first.", 400);
    const { refused, recorded } = await applyAnswers(
      deps.storage,
      access,
      answers,
      now,
      link.arrival,
    );
    await sendThreadReceipt(deps, access, { recorded, arrival: link.arrival, now });
    if (refused !== null) return refuse(refused.message, refused.status);
    const back = new URL(VOTE_PATH, "http://placeholder");
    back.searchParams.set("t", token);
    back.searchParams.set("saved", "1");
    return c.redirect(`${back.pathname}${back.search}`, 303);
  });
}

// --- Everyone agrees, by the link mailed to you (rc42) ------------------------------------

function agreePage(
  access: EventAccess,
  request: VerifiedRequest | undefined,
  token: string,
  notice: Html | string,
): string {
  const { participation } = access;
  const mine = request?.answers.find((a) => a.personId === participation.personId);
  const body =
    request === undefined || request.outcome !== null
      ? html`<p><strong>This has been decided, or it lapsed.</strong> ${
          request?.outcome === "agreed"
            ? "Everyone agreed."
            : request?.outcome === "refused"
              ? "Someone said no, so it stays as it is."
              : "Not everyone answered in time, so it stays as it is."
        }</p>`
      : html`<p><strong>${request.askedBy?.name ?? "Someone"}</strong> asks everyone on it to agree to <strong>${requestWhat(request.kind, request.retainDays)}</strong>. It happens only if everyone says yes; one "no" keeps it as it is.</p>
${mine === undefined ? "" : html`<p class="muted">You said ${mine.answer}. You can change it until it's decided.</p>`}
<form method="post" action="${AGREE_PATH}">
  <input type="hidden" name="t" value="${token}" />
  <p><button type="submit" name="answer" value="yes">Yes, I agree</button> <button type="submit" name="answer" value="no">No</button></p>
</form>
<p class="muted">Until ${request.expiresAt.slice(0, 10)}. Still waiting for: ${request.waitingFor.map((w) => w.shown.name).join(", ") || "nobody"}.</p>`;
  return linkPage(
    "Everyone agrees",
    html`${notice}${header(access)}
${body}
<p class="muted">This link is just for you — please don't forward it. No account needed.</p>`,
  );
}

/** A thread's request, answered by the link mailed to you (rc42). */
async function threadAgreePage(
  storage: StoragePort,
  link: { readonly access: ThreadAccess; readonly requestId: string },
  token: string,
  notice: Html | string,
  now: string,
): Promise<string> {
  const { access } = link;
  const request = (await listThreadRequests(storage, access, now)).find(
    (r) => r.id === link.requestId,
  );
  const name = (id: string | null) => {
    const m = access.members.find((x) => x.personId === id);
    return m === undefined ? "Someone" : memberName(m);
  };
  const mine = request?.answers.find((a) => a.personId === access.personId);
  const body =
    request === undefined || request.outcome !== null
      ? html`<p><strong>This has been decided, or it lapsed.</strong> ${
          request?.outcome === "agreed"
            ? "Everyone agreed: answers here are no longer verified."
            : request?.outcome === "refused"
              ? "Someone said no, so it stays as it is."
              : "Not everyone answered in time, so it stays as it is."
        }</p>`
      : html`<p><strong>${name(request.askedById)}</strong> asks everyone in it to agree to <strong>stop verifying answers here</strong>. It happens only if everyone says yes; one "no" keeps it as it is.</p>
${mine === undefined ? "" : html`<p class="muted">You said ${mine.answer}. You can change it until it's decided.</p>`}
<form method="post" action="${AGREE_PATH}">
  <input type="hidden" name="t" value="${token}" />
  <p><button type="submit" name="answer" value="yes">Yes, I agree</button> <button type="submit" name="answer" value="no">No</button></p>
</form>
<p class="muted">Until ${request.expiresAt.slice(0, 10)}. Still waiting for: ${request.waitingFor.map(name).join(", ") || "nobody"}.</p>`;
  return linkPage(
    "Everyone agrees",
    html`${notice}<h1>${access.thread.name}</h1>${threadVerifiedLine(access.thread)}
${body}
<p class="muted">This link is just for you — please don't forward it. No account needed.</p>`,
  );
}

/** The email asking a thread's members to agree (rc42). Everyone in it sees its name. */
export async function sendThreadRequestLink(
  mail: MailPort,
  input: {
    readonly link: ThreadRequestLink;
    readonly access: ThreadAccess;
    readonly from: string;
    readonly publicBaseUrl: string;
  },
): Promise<void> {
  const url = new URL(AGREE_PATH, input.publicBaseUrl);
  url.searchParams.set("t", input.link.token);
  const name = input.access.thread.name;
  await mail.send({
    to: input.link.email,
    subject: `Do you agree? "${name}"`,
    cause: {
      kind: "from",
      senderId: input.access.personId,
      groupId: input.access.thread.groupId,
      why: `${input.from} asked everyone in a plan you're in to agree`,
    },
    text: [
      `${input.from} asks everyone in "${name}" to agree to stop verifying answers there.`,
      "",
      'This happens only if everyone says yes. One "no" keeps it as it is, and so does not answering within 14 days.',
      "",
      "Answer here — no account needed:",
      url.toString(),
    ].join("\n"),
  });
}

/**
 * The email asking someone to agree (rc42): written for their tier, as answer links are —
 * a BUSY inbox gets no title. Its link is theirs alone and is never copied.
 */
export async function sendRequestLink(
  mail: MailPort,
  input: {
    readonly link: RequestLink;
    readonly access: EventAccess;
    readonly kind: RequestKind;
    readonly retainDays: number | null;
    readonly from: string;
    readonly publicBaseUrl: string;
  },
): Promise<void> {
  const { link, access, from } = input;
  const url = new URL(AGREE_PATH, input.publicBaseUrl);
  url.searchParams.set("t", link.token);
  const titled = canSee(link.visibility, "title");
  const when = formatWhen(access.event);
  const on = titled ? `"${access.event.title}" (${when})` : `an event on ${when}`;
  await mail.send({
    to: link.email,
    subject: titled ? `Do you agree? "${access.event.title}"` : `Do you agree? (${when})`,
    cause: {
      kind: "from",
      senderId: access.participation.personId,
      groupId: access.event.groupId,
      why: `${from} asked everyone on an event you're on to agree`,
    },
    text: [
      `${from} asks everyone on ${on} to agree to ${requestWhat(input.kind, input.retainDays)}.`,
      "",
      'Answers there are verified, so this happens only if everyone says yes. One "no" keeps it as it is, and so does not answering within 14 days.',
      "",
      "Answer here — no account needed:",
      url.toString(),
    ].join("\n"),
  });
}

// --- The email ---------------------------------------------------------------------------

/** What an answering POST did, in the receipt's words (rc42). */
export const RECEIPT_LINE = {
  going: "You're going",
  maybe: "Maybe",
  not_going: "You can't make it",
  accept: "You agree",
  decline: "You don't agree",
  acknowledge: "You've seen it",
  note: "You added a note",
} as const;
export type ReceiptLine = keyof typeof RECEIPT_LINE;

/**
 * A receipt for an answer on a verified event (DESIGN §10 rc42): mailed to the person the
 * answer belongs to, however it arrived — signed in included — so someone who didn't give
 * it finds out. Titles and names only, as all mail (§16): a note says it was added, not
 * what it says; a BUSY inbox gets no title. It honours their opt-outs and their share of
 * the mail cap; the answer stands either way, and a receipt that didn't go out is recorded
 * for the event's history. Never throws: an answer must not fail for its receipt.
 */
export async function sendEventReceipt(
  deps: Pick<RespondRouteDeps, "storage" | "mail" | "publicBaseUrl">,
  access: EventAccess,
  input: {
    readonly answered: readonly ReceiptLine[];
    readonly arrival: Arrival | null;
    readonly now: string;
  },
): Promise<void> {
  const { event, participation } = access;
  if (event.verifiedAt === null || input.answered.length === 0) return;
  const person = await findPersonById(deps.storage, participation.personId);
  if (person === null) return;
  const from = { senderId: person.id, groupId: event.groupId };
  const unsent = (reason: ReceiptUnsent) =>
    recordUnsentReceipt(deps.storage, {
      eventId: event.id,
      personId: person.id,
      reason,
      now: input.now,
    });
  if (await isSuppressed(deps.storage, person.email, from)) return unsent("suppressed");
  const titled = canSee(participation.visibility, "title");
  const when = formatWhen(event);
  const what = titled ? `"${event.title}" (${when})` : `an event on ${when}`;
  const how =
    input.arrival?.via === "session" ? "signed in as you" : "with the link emailed to you";
  try {
    await deps.mail.send({
      to: person.email,
      subject: titled ? `Your answer to "${event.title}"` : `Your answer (${when})`,
      cause: {
        kind: "from",
        senderId: person.id,
        groupId: event.groupId,
        why: "an answer was given for you on an event whose answers are verified",
      },
      text: [
        `An answer was given for you to ${what}:`,
        "",
        ...input.answered.map((line) => `- ${RECEIPT_LINE[line]}`),
        "",
        `When: ${input.now.slice(0, 16).replace("T", " ")} UTC`,
        `How: ${how}`,
        "",
        `See it: ${new URL(`${EVENTS_PATH}/${event.id}`, deps.publicBaseUrl).toString()}`,
        "",
        "If this wasn't you, someone who can read your email, or a device still signed in as you, answered for you. Sign in, change the answer, and sign out everywhere from your account page.",
        "",
        "Answers on this event are verified, so every answer sends a receipt like this one.",
      ].join("\n"),
    });
  } catch (error) {
    await unsent(error instanceof MailCapReachedError ? "capped" : "failed");
  }
}

/**
 * One response-link email, written for the RECIPIENT's tier: a BUSY member's inbox gets
 * no title, exactly as their calendar wouldn't. Plain text; the title is user-written,
 * the same accepted phishing surface as group names in invites (groups.ts).
 */
export async function sendResponseLink(
  mail: MailPort,
  input: {
    readonly link: IssuedLink;
    readonly access: EventAccess;
    readonly from: string;
    readonly publicBaseUrl: string;
  },
): Promise<void> {
  const { link, access, from } = input;
  const url = respondUrl(input.publicBaseUrl, link.token);
  const titled = canSee(link.visibility, "title");
  const title = access.event.title;
  const days = RESPONSE_TOKEN_TTL_MS / (24 * 60 * 60 * 1000);
  const when = formatWhen(access.event);
  // A vote link asks to agree (rc13): an event-poll's vote links went with them (rc35).
  const [subject, ask] =
    link.action === "vote"
      ? titled
        ? [
            `${from} asks you to agree: "${title}"`,
            `${from} proposes "${title}" (${when}) and asks whether you agree.`,
          ]
        : [
            `${from} asks you to agree (${when})`,
            `${from} proposes something for ${when} and asks whether you agree.`,
          ]
      : titled
        ? [
            `Are you coming to "${title}"?`,
            `${from} would like to know whether you're coming to "${title}" (${when}).`,
          ]
        : [
            `Are you coming? (${when})`,
            `${from} would like to know whether you're coming (${when}).`,
          ];
  await mail.send({
    to: link.email,
    subject,
    // The sender is whoever asked; never the title here, which a BUSY inbox mustn't see.
    cause: {
      kind: "from",
      senderId: access.participation.personId,
      groupId: access.event.groupId,
      why: `${from} added this address to an event on WhenDoWe`,
    },
    text: [
      ask,
      "",
      "Answer here — no account, nothing to install:",
      url.toString(),
      "",
      `This link is just for you and works for ${days} days; you can change your answer with it any time.`,
      // rc42: the stated exception to rc21, said in the mail that adds someone.
      ...(access.event.verifiedAt === null
        ? []
        : [
            "",
            "Answers here are verified: they count only from your own email or signed in, and your address is shown to the others on it.",
          ]),
    ].join("\n"),
  });
}

/**
 * One vote-link email (rc26). The thread's name is user-written: the same accepted
 * phishing surface as an event title. Everyone in a thread sees its name, so it goes
 * in. `from` is the organizer as the thread shows them — never their account name.
 */
export async function sendVoteLink(
  mail: MailPort,
  input: {
    readonly link: IssuedVoteLink;
    readonly access: ThreadAccess;
    readonly from: string;
    readonly publicBaseUrl: string;
    /** What the link asks about: one time is asked as one question (rc33). */
    readonly onTable: readonly Plan[];
  },
): Promise<void> {
  const { link, access, from } = input;
  const one = oneTime(input.onTable);
  const url = voteUrl(input.publicBaseUrl, link.token);
  const name = access.thread.name;
  const days = VOTE_LINK_TTL_MS / (24 * 60 * 60 * 1000);
  await mail.send({
    to: link.email,
    subject: one === null ? `When can you make "${name}"?` : `Can you make "${name}"?`,
    cause: {
      kind: "from",
      senderId: access.personId,
      groupId: access.thread.groupId,
      why: `${from} added this address to a plan on WhenDoWe`,
    },
    text: [
      one === null
        ? `${from} is finding a time for "${name}" and would like to know which times work for you.`
        : `${from} would like to know whether you can make "${name}" on ${whenText(one)}.`,
      "",
      "Vote here — no account, nothing to install:",
      url.toString(),
      "",
      `This link is just for you and works for ${days} days; you can change your vote with it any time.`,
    ].join("\n"),
  });
}
