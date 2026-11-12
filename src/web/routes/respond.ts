// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { StoragePort } from "../../db/port.js";
import type { EventAccess } from "../../events/event.js";
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
  type ResolvedLink,
  resolveResponseLink,
  setAttendance,
  setOwnAnswersOnly,
} from "../../events/response.js";
import type { MailPort } from "../../mail/port.js";
import { addVoteNote, listNotes, type PlanNote } from "../../plans/note.js";
import {
  castVote,
  listPlans,
  type Plan,
  type PlanEvent,
  PlanInputError,
} from "../../plans/plan.js";
import { memberName, type ThreadAccess } from "../../plans/thread.js";
import {
  type IssuedVoteLink,
  type ResolvedVoteLink,
  resolveVoteLink,
  setThreadOwnAnswersOnly,
  VOTE_LINK_TTL_MS,
} from "../../plans/vote-link.js";
import { dayLabel, spanText, whenText } from "../../plans/weeks.js";
import { type Html, html, ownAnswersForm, type Preview, renderPage } from "../layout.js";
import { busyAssets, busyAttrs, busyClash, PLAN_STYLE } from "../plan-editor.js";
import type { AppEnv } from "../session.js";
import { BUSY_LABEL, describeRRule, formatWhen } from "./events.js";

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
  return html`<h1>${title}</h1>${when}${where}`;
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
    link.arrival?.via === "mailed"
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
  const ownSwitch = mailed
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
    html`${PLAN_STYLE}<div class="pl"${busyAttrs(own ? access.thread.tzid : null)}>${notice}<h1>${access.thread.name}</h1>
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
): Promise<{ readonly message: string; readonly status: 400 | 409 } | null> {
  let closed = false;
  let agreed = false;
  if (answers.note.trim() !== "") {
    try {
      if ((await addVoteNote(storage, access, { body: answers.note, now })).kind === "closed")
        closed = true;
    } catch (err) {
      if (err instanceof PlanInputError) return { message: err.message, status: 400 };
      throw err;
    }
  }
  for (const [planId, answer] of answers.votes) {
    const result = await castVote(storage, access, { planId, answer, now, arrival });
    if (result.kind === "accepted") agreed = true;
    if (result.kind === "closed" || result.kind === "invalid") closed = true;
  }
  // A yes here that agreed a time replaced the rest of its question: not a refusal.
  return closed && !agreed
    ? {
        message: "Something you answered was decided meanwhile. Your other answers are saved.",
        status: 409,
      }
    : null;
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
      }
      if (form.ack === "on" && needsAcknowledgment(access)) {
        answered = true;
        const result = await acknowledge(deps.storage, access, { now, arrival });
        if (result.kind !== "recorded")
          return problem("This event can't take answers any more.", 409);
      }
    }
    const note = typeof form.note === "string" ? form.note : "";
    if (!answered && note.trim() === "") return problem("Pick an answer first.", 400);
    if (note.trim() !== "") {
      const result = await addFeedback(deps.storage, access, { body: note, now, arrival });
      if (result.kind === "invalid") return problem(result.reason, 400);
      if (result.kind !== "recorded") return problem("This event can't take notes any more.", 409);
    }
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
    const refused = await applyAnswers(deps.storage, access, answers, now, link.arrival);
    if (refused !== null) return refuse(refused.message, refused.status);
    const back = new URL(VOTE_PATH, "http://placeholder");
    back.searchParams.set("t", token);
    back.searchParams.set("saved", "1");
    return c.redirect(`${back.pathname}${back.search}`, 303);
  });
}

// --- The email ---------------------------------------------------------------------------

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
