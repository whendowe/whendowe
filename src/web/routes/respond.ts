// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { StoragePort } from "../../db/port.js";
import type { EventAccess } from "../../events/event.js";
import { canSee } from "../../events/participation.js";
import { type Answer, answerSchema, pollResults, vote } from "../../events/poll.js";
import {
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
} from "../../events/response.js";
import type { MailPort } from "../../mail/port.js";
import { type Html, html, renderPage } from "../layout.js";
import type { AppEnv } from "../session.js";
import { BUSY_LABEL, formatWhen } from "./events.js";

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

function sensitive(c: Context<AppEnv>): void {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
}

function deadLink(): string {
  return renderPage(
    "Link no longer works",
    html`<h1>This link no longer works</h1>
<p>It may have expired, or a newer one was sent to you. Ask the organizer to send it again.</p>`,
  );
}

function header(access: EventAccess): Html {
  const { event, participation } = access;
  const title = canSee(participation.visibility, "title") ? event.title : BUSY_LABEL;
  const when =
    event.status === "proposed" && participation.responseKind === "slot_vote"
      ? html`<p>Voting on a time.</p>`
      : html`<p>${formatWhen(event)}${event.status === "cancelled" ? " — cancelled" : ""}</p>`;
  const where =
    canSee(participation.visibility, "location") && event.location !== null
      ? html`<p>📍 ${event.location}</p>`
      : "";
  return html`<h1>${title}</h1>${when}${where}`;
}

async function respondPage(
  storage: StoragePort,
  link: ResolvedLink,
  token: string,
  notice: Html | string,
): Promise<string> {
  const { access, action } = link;
  const { event, participation } = access;
  const open =
    (action === "vote" && event.status === "proposed") ||
    (action === "attend" && event.status === "scheduled");

  let question: Html | string = "";
  if (action === "vote" && open && participation.responseKind === "accept") {
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
  } else if (action === "vote" && open) {
    const poll = await pollResults(storage, access);
    question = html`<h2>Which times work for you?</h2>
<ul style="list-style:none;padding-left:0">${poll.candidates.map(
      (c) => html`<li style="margin-bottom:.8em"><strong>${formatWhen(c)}</strong><br />
${answerSchema.options.map(
  (a) =>
    html`<label style="margin-right:.8em"><input type="radio" name="slot_${c.slotIndex}" value="${a}" ${c.mine === a ? html`checked` : ""} /> ${ANSWER_LABEL[a]}</label>`,
)}<br /><span class="muted">${c.yes} yes · ${c.ifNeedBe} if need be · ${c.no} no</span></li>`,
    )}</ul>`;
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

  return renderPage(
    "Your answer",
    html`${notice}${header(access)}
${form}
<p class="muted">This link is just for you — please don't forward it. No account needed.</p>`,
  );
}

function readToken(value: unknown): string | null {
  const parsed = tokenSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
    return c.html(await respondPage(deps.storage, link, token, notice));
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
    const { access, action } = link;
    const problem = (message: string, status: 400 | 409) =>
      c.html(respondPage(deps.storage, link, token, html`<p class="error">${message}</p>`), status);

    let answered = false;
    if (action === "vote" && access.participation.responseKind === "accept") {
      const decision =
        form.decision === "accept" || form.decision === "decline" ? form.decision : null;
      if (decision !== null) {
        answered = true;
        const result = await answerProposal(deps.storage, access, { answer: decision, now });
        if (result.kind !== "recorded") return problem("This has already been settled.", 409);
      }
    } else if (action === "vote") {
      const answers = new Map<number, Answer>();
      for (const [key, value] of Object.entries(form)) {
        const slot = /^slot_(\d{1,2})$/.exec(key)?.[1];
        const answer = answerSchema.safeParse(value);
        if (slot !== undefined && answer.success)
          answers.set(Number.parseInt(slot, 10), answer.data);
      }
      if (answers.size > 0) {
        answered = true;
        const result = await vote(deps.storage, access, { answers, now });
        if (result.kind === "closed")
          return problem("Voting has closed — a time was already picked.", 409);
        if (result.kind !== "recorded")
          return problem("Please pick an answer for the times shown.", 400);
      }
    } else {
      const attendance = attendanceSchema.safeParse(form.attendance);
      if (attendance.success) {
        answered = true;
        const result = await setAttendance(deps.storage, access, {
          attendance: attendance.data,
          now,
        });
        if (result.kind !== "recorded")
          return problem("This event can't take answers any more.", 409);
      }
      if (form.ack === "on" && needsAcknowledgment(access)) {
        answered = true;
        const result = await acknowledge(deps.storage, access, { now });
        if (result.kind !== "recorded")
          return problem("This event can't take answers any more.", 409);
      }
    }
    const note = typeof form.note === "string" ? form.note : "";
    if (!answered && note.trim() === "") return problem("Pick an answer first.", 400);
    if (note.trim() !== "") {
      const result = await addFeedback(deps.storage, access, { body: note, now });
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
  const url = new URL(RESPOND_PATH, input.publicBaseUrl);
  url.searchParams.set("t", link.token);
  const titled = canSee(link.visibility, "title");
  const title = access.event.title;
  const days = RESPONSE_TOKEN_TTL_MS / (24 * 60 * 60 * 1000);
  const consent = link.action === "vote" && access.participation.responseKind !== "slot_vote";
  const when = formatWhen(access.event);
  const [subject, ask] = consent
    ? titled
      ? [
          `${from} asks you to agree: "${title}"`,
          `${from} proposes "${title}" (${when}) and asks whether you agree.`,
        ]
      : [
          `${from} asks you to agree (${when})`,
          `${from} proposes something for ${when} and asks whether you agree.`,
        ]
    : link.action === "vote"
      ? titled
        ? [
            `When can you make "${title}"?`,
            `${from} is finding a time for "${title}" and would like to know which times work for you.`,
          ]
        : [
            `${from} is finding a time`,
            `${from} is finding a time for something you're part of and would like to know which times work for you.`,
          ]
      : titled
        ? [
            `Are you coming to "${title}"?`,
            `${from} would like to know whether you're coming to "${title}" (${formatWhen(access.event)}).`,
          ]
        : [
            `Are you coming? (${formatWhen(access.event)})`,
            `${from} would like to know whether you're coming (${formatWhen(access.event)}).`,
          ];
  await mail.send({
    to: link.email,
    subject,
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
