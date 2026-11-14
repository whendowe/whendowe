// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { type Visibility, visibilitySchema } from "../people/invite.js";
import { type Shown, shownAs, shownRowSchema } from "../people/person.js";
import { hashToken, issueToken } from "../people/tokens.js";
import {
  type EventAccess,
  type EventStatus,
  findEventForParticipant,
  PARTY_RULE,
  transitionStatements,
} from "./event.js";
import {
  type ResponseKind,
  type ResponseState,
  responseKindSchema,
  responseStateSchema,
  shownEmailSql,
} from "./participation.js";

// Responses (MVP-2 slice 2D): attendance and feedback from every tier, and the
// account-less links that let someone vote or say whether they're coming without
// ever signing in (WORKFLOWS §2: responding never requires an account).
//
// Responses are attributed rows of their own, not change_log rows (DESIGN §10 rc12).

export const attendanceSchema = z.enum(["going", "maybe", "not_going"]);
export type Attendance = z.infer<typeof attendanceSchema>;

export const FEEDBACK_MAX_LENGTH = 500;
/** Per person per event, ever: a ceiling against a stuck script, far above real use. */
export const FEEDBACK_PER_PERSON_PER_EVENT = 50;

/**
 * How an answer arrived (DESIGN §10 rc42): signed in, by the link we mailed to the person's
 * address, by a link an organizer copied (rc36) — and then who copied it, unless they have
 * been erased since — or, for a vote, as a guest of a thread's shared link (rc25). Stored
 * beside the answer and shown with it; it stops nothing.
 */
export const arrivalViaSchema = z.enum(["session", "mailed", "copied", "shared"]);
export interface Arrival {
  readonly via: z.infer<typeof arrivalViaSchema>;
  /** Who copied the link; null for the other ways, and once that person is gone. */
  readonly by: string | null;
}
export const SIGNED_IN: Arrival = { via: "session", by: null };

/**
 * Whether an answer that arrived this way counts here (rc42): any way, unless the event is
 * verified or the person takes answers only from their own email — then only signed in or
 * by a link mailed to them. The links are refused before this; this is the backstop.
 */
export function arrivalCounts(access: EventAccess, arrival: Arrival | null): boolean {
  if (access.event.verifiedAt === null && !access.participation.ownAnswersOnly) return true;
  return arrival?.via === "session" || arrival?.via === "mailed";
}
export const SHARED_LINK: Arrival = { via: "shared", by: null };

/** What a stored answer says about its arrival; null from before rc42, when it wasn't recorded. */
export function arrivalOf(via: string | null, by: string | null): Arrival | null {
  const parsed = arrivalViaSchema.nullable().parse(via);
  return parsed === null ? null : { via: parsed, by };
}

export type ResponseResult =
  | { readonly kind: "recorded" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "closed" }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * State whether you're coming. Only a `scheduled` event has an attendance question —
 * an open poll is answered by voting. Guarded in the statement itself, so an answer
 * racing a cancellation can't land on the cancelled event.
 */
export async function setAttendance(
  storage: StoragePort,
  access: EventAccess,
  input: {
    readonly attendance: Attendance;
    readonly now: string;
    readonly arrival: Arrival | null;
  },
): Promise<ResponseResult> {
  if (access.participation.visibility === "HIDDEN") return { kind: "forbidden" };
  if (!arrivalCounts(access, input.arrival)) return { kind: "forbidden" };
  const written = await storage.query({
    sql: `UPDATE event_participation
          SET attendance = ?, responded_at = ?, attendance_via = ?, attendance_via_by = ?
          WHERE canonical_event_id = ? AND person_id = ?
            AND EXISTS (SELECT 1 FROM canonical_event WHERE id = ? AND status = 'scheduled')
          RETURNING person_id`,
    params: [
      input.attendance,
      input.now,
      input.arrival?.via ?? null,
      input.arrival?.by ?? null,
      access.event.id,
      access.participation.personId,
      access.event.id,
    ],
  });
  return written.length === 1 ? { kind: "recorded" } : { kind: "closed" };
}

/** Leave a short note on the event — any tier that can see it, on a poll or a scheduled event. */
export async function addFeedback(
  storage: StoragePort,
  access: EventAccess,
  input: {
    readonly body: string;
    readonly now: string;
    readonly arrival: Arrival | null;
    readonly newId?: () => string;
  },
): Promise<ResponseResult> {
  if (access.participation.visibility === "HIDDEN") return { kind: "forbidden" };
  if (!arrivalCounts(access, input.arrival)) return { kind: "forbidden" };
  const body = input.body.trim();
  if (body === "") return { kind: "invalid", reason: "Write something first." };
  if (body.length > FEEDBACK_MAX_LENGTH) {
    return { kind: "invalid", reason: `Keep it under ${FEEDBACK_MAX_LENGTH} characters.` };
  }
  if (access.event.status !== "proposed" && access.event.status !== "scheduled")
    return { kind: "closed" };
  // Count and insert in ONE statement, so parallel requests can't overshoot the ceiling.
  const written = await storage.query({
    sql: `INSERT INTO event_feedback
            (id, canonical_event_id, person_id, body, created_at, answered_via, answered_via_by)
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT count(*) FROM event_feedback WHERE canonical_event_id = ? AND person_id = ?) < ?
          RETURNING id`,
    params: [
      (input.newId ?? (() => uuidv7()))(),
      access.event.id,
      access.participation.personId,
      body,
      input.now,
      input.arrival?.via ?? null,
      input.arrival?.by ?? null,
      access.event.id,
      access.participation.personId,
      FEEDBACK_PER_PERSON_PER_EVENT,
    ],
  });
  return written.length === 1
    ? { kind: "recorded" }
    : { kind: "invalid", reason: "That's a lot of notes on one event." };
}

export interface AttendanceEntry {
  readonly personId: string;
  readonly shown: Shown;
  readonly attendance: Attendance;
  readonly at: string | null;
  readonly arrival: Arrival | null;
}

export interface FeedbackEntry {
  readonly personId: string;
  readonly shown: Shown;
  readonly body: string;
  readonly at: string;
  readonly arrival: Arrival | null;
}

export interface Responses {
  readonly attendance: readonly AttendanceEntry[];
  readonly feedback: readonly FeedbackEntry[];
}

const attendanceRowSchema = shownRowSchema.extend({
  person_id: z.string(),
  attendance: attendanceSchema,
  responded_at: z.string().nullable(),
  attendance_via: z.string().nullable(),
  attendance_via_by: z.string().nullable(),
});

const feedbackRowSchema = shownRowSchema.extend({
  person_id: z.string(),
  body: z.string(),
  created_at: z.string(),
  answered_via: z.string().nullable(),
  answered_via_by: z.string().nullable(),
});

/**
 * Everyone's attendance and notes, attributed — for someone with proven access. The
 * page decides what a tier may see (names are participant-list information).
 */
export async function listResponses(storage: StoragePort, access: EventAccess): Promise<Responses> {
  const attendance = await storage.query({
    sql: `SELECT ep.person_id, p.email, p.display_name, ep.handle, ${shownEmailSql("ep")} AS show_email,
                 ep.attendance, ep.responded_at, ep.attendance_via, ep.attendance_via_by
          FROM event_participation ep JOIN person p ON p.id = ep.person_id
          WHERE ep.canonical_event_id = ? AND ep.attendance IS NOT NULL
          ORDER BY ep.created_at, ep.person_id`,
    params: [access.event.id],
  });
  const feedback = await storage.query({
    sql: `SELECT f.person_id, p.email, p.display_name, ep.handle, ${shownEmailSql("ep")} AS show_email, f.body,
                 f.created_at, f.answered_via, f.answered_via_by
          FROM event_feedback f JOIN person p ON p.id = f.person_id
            LEFT JOIN event_participation ep
              ON ep.canonical_event_id = f.canonical_event_id AND ep.person_id = f.person_id
          WHERE f.canonical_event_id = ?
          ORDER BY f.created_at, f.id`,
    params: [access.event.id],
  });
  return {
    attendance: attendance.map((row) => {
      const r = attendanceRowSchema.parse(row);
      return {
        personId: r.person_id,
        shown: shownAs(r.person_id, r, access.event.id),
        attendance: r.attendance,
        at: r.responded_at,
        arrival: arrivalOf(r.attendance_via, r.attendance_via_by),
      };
    }),
    feedback: feedback.map((row) => {
      const r = feedbackRowSchema.parse(row);
      return {
        personId: r.person_id,
        shown: shownAs(r.person_id, r, access.event.id),
        body: r.body,
        at: r.created_at,
        arrival: arrivalOf(r.answered_via, r.answered_via_by),
      };
    }),
  };
}

// --- Response links (DESIGN §13 token links, rc12) -------------------------------------

export const RESPONSE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** A person gets at most one fresh link per event and action per hour, however often an organizer clicks "send". */
export const RESPONSE_RESEND_INTERVAL_MS = 60 * 60 * 1000;

export const responseActionSchema = z.enum(["vote", "attend"]);
export type ResponseAction = z.infer<typeof responseActionSchema>;

/** The one question an event asks right now: vote while a poll is open, attend once it's scheduled. */
export function actionFor(access: EventAccess): ResponseAction | null {
  switch (access.event.status) {
    case "proposed":
      return "vote";
    case "scheduled":
      return "attend";
    default:
      return null;
  }
}

export interface IssuedLink {
  readonly eventId: string;
  readonly action: ResponseAction;
  readonly personId: string;
  /** The recipient's tier: the EMAIL must respect it too (no title in a BUSY person's inbox). */
  readonly visibility: Visibility;
  readonly email: string;
  readonly displayName: string | null;
  /** The raw token: put it in the email, never store or log it. */
  readonly token: string;
}

export type IssueLinksResult =
  | {
      readonly kind: "issued";
      readonly action: ResponseAction;
      readonly links: readonly IssuedLink[];
      readonly throttled: number;
    }
  | { readonly kind: "forbidden" }
  | { readonly kind: "closed" };

const recipientRowSchema = z.object({
  person_id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  visibility: visibilitySchema,
});

/**
 * Issue a link for the event's current question to everyone who can see it, except
 * the organizer asking. Only editors may — sending mail in someone's name is theirs.
 *
 * Per recipient, ONE upsert: a new row, or a REPLACED row (new hash, new expiry —
 * so the previous link dies: rotate on resend), but only if the existing one is older
 * than the resend interval. RETURNING says whether a fresh token was stored; only
 * then is it handed out, so a throttled recipient is never sent a link that doesn't work.
 */
export async function issueResponseLinks(
  storage: StoragePort,
  access: EventAccess,
  input: {
    readonly now: string;
    readonly newToken?: typeof issueToken;
    /** Just this person — someone an editor has added (DESIGN rc15). */
    readonly only?: string;
    /**
     * To copy, not to email (rc36): replace their link even if one went out within the
     * hour. The resend throttle limits mail; a link handed over by the organizer isn't mail.
     */
    readonly copy?: boolean;
  },
): Promise<IssueLinksResult> {
  if (access.participation.editTier !== "edit") return { kind: "forbidden" };
  const action = actionFor(access);
  if (action === null) return { kind: "closed" };

  const now = Date.parse(input.now);
  const expiresAt = new Date(now + RESPONSE_TOKEN_TTL_MS).toISOString();
  const resendCutoff =
    input.copy === true ? input.now : new Date(now - RESPONSE_RESEND_INTERVAL_MS).toISOString();
  const recipients = (
    await storage.query({
      sql: `SELECT ep.person_id, p.email, p.display_name, ep.visibility
            FROM event_participation ep JOIN person p ON p.id = ep.person_id
              JOIN canonical_event e ON e.id = ep.canonical_event_id
            WHERE ep.canonical_event_id = ? AND ep.visibility <> 'HIDDEN' AND ep.person_id <> ?
              AND ${PARTY_RULE} AND (? IS NULL OR ep.person_id = ?)
              AND (? = 0 OR (ep.own_answers_only = 0 AND e.verified_at IS NULL))
            ORDER BY p.email`,
      params: [
        access.event.id,
        access.participation.personId,
        input.only ?? null,
        input.only ?? null,
        // rc42: nobody copies a link for someone who takes answers only from their own email.
        input.copy === true ? 1 : 0,
      ],
    })
  ).map((row) => recipientRowSchema.parse(row));

  const links: IssuedLink[] = [];
  for (const r of recipients) {
    const issued = await (input.newToken ?? issueToken)();
    const stored = await storage.query({
      sql: `INSERT INTO response_token
              (token_hash, canonical_event_id, person_id, action, expires_at, created_at, origin, issued_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (canonical_event_id, person_id, action) DO UPDATE
              SET token_hash = excluded.token_hash, expires_at = excluded.expires_at,
                  created_at = excluded.created_at, origin = excluded.origin,
                  issued_by = excluded.issued_by
              WHERE response_token.created_at <= ?
            RETURNING person_id`,
      params: [
        issued.hash,
        access.event.id,
        r.person_id,
        action,
        expiresAt,
        input.now,
        // rc42: a link says whether it was mailed or copied, and a copied one by whom.
        input.copy === true ? "copied" : "mailed",
        input.copy === true ? access.participation.personId : null,
        resendCutoff,
      ],
    });
    if (stored.length === 1) {
      links.push({
        eventId: access.event.id,
        action,
        personId: r.person_id,
        visibility: r.visibility,
        email: r.email,
        displayName: r.display_name,
        token: issued.token,
      });
    }
  }
  return { kind: "issued", action, links, throttled: recipients.length - links.length };
}

/**
 * Withdraw a link that was issued but could not be delivered. Issuing already replaced
 * any older link, so without this a failed send would leave the person with NO working
 * link and the resend throttle would refuse a retry for an hour. Matches on the hash,
 * so it can only ever remove the undelivered link itself.
 */
export async function revokeUndeliveredLink(storage: StoragePort, link: IssuedLink): Promise<void> {
  await storage.batch([
    {
      sql: `DELETE FROM response_token
            WHERE canonical_event_id = ? AND person_id = ? AND action = ? AND token_hash = ?`,
      params: [link.eventId, link.personId, link.action, await hashToken(link.token)],
    },
  ]);
}

export interface ResolvedLink {
  readonly access: EventAccess;
  readonly action: ResponseAction;
  /** How an answer given with this link arrives (rc42); null for a link from before rc42. */
  readonly arrival: Arrival | null;
}

const tokenRowSchema = z.object({
  canonical_event_id: z.string(),
  person_id: z.string(),
  action: responseActionSchema,
  origin: z.enum(["mailed", "copied"]).nullable(),
  issued_by: z.string().nullable(),
});

/**
 * What a presented link may do, or null — for unknown, replaced and expired links
 * alike, and for a person no longer taking part or now HIDDEN: their access is
 * re-checked through findEventForParticipant on every use, never cached in the link.
 * Read-only: rendering the page (GET) and acting on it (POST) both call this.
 */
export async function resolveResponseLink(
  storage: StoragePort,
  token: string,
  now: string,
): Promise<ResolvedLink | null> {
  if (token === "") return null;
  const rows = await storage.query({
    sql: `SELECT canonical_event_id, person_id, action, origin, issued_by FROM response_token
          WHERE token_hash = ? AND expires_at > ?`,
    params: [await hashToken(token), now],
  });
  if (rows[0] === undefined) return null;
  const row = tokenRowSchema.parse(rows[0]);
  const access = await findEventForParticipant(storage, row.canonical_event_id, row.person_id);
  if (access === null || access.participation.visibility === "HIDDEN") return null;
  // rc42: with "only my own email" on, or on a verified event, only a link we mailed them
  // answers as them — not a copied one, nor one from before links said how they were made.
  const guarded = access.participation.ownAnswersOnly || access.event.verifiedAt !== null;
  if (guarded && row.origin !== "mailed") return null;
  return { access, action: row.action, arrival: arrivalOf(row.origin, row.issued_by) };
}

/**
 * "Only my own email answers for me" on this event (DESIGN §10 rc42), set by the person
 * themselves: signed in, or by a link mailed to them — never by a copied link, which is
 * what it guards against. Turning it on also withdraws any copied link of theirs.
 */
export async function setOwnAnswersOnly(
  storage: StoragePort,
  access: EventAccess,
  input: { readonly on: boolean; readonly arrival: Arrival | null },
): Promise<"saved" | "forbidden"> {
  const via = input.arrival?.via;
  if (via !== "session" && via !== "mailed") return "forbidden";
  const { event, participation } = access;
  await storage.batch([
    {
      sql: "UPDATE event_participation SET own_answers_only = ? WHERE canonical_event_id = ? AND person_id = ?",
      params: [input.on ? 1 : 0, event.id, participation.personId],
    },
    ...(input.on
      ? [
          {
            sql: `DELETE FROM response_token
                  WHERE canonical_event_id = ? AND person_id = ? AND (origin IS NULL OR origin <> 'mailed')`,
            params: [event.id, participation.personId],
          },
        ]
      : []),
  ]);
  return "saved";
}

// --- Agreement & acknowledgment (slice 2E-1, DESIGN §10 rc13) -----------------------------

export type AnswerResult =
  | { readonly kind: "recorded"; readonly status: EventStatus }
  | { readonly kind: "forbidden" }
  | { readonly kind: "closed" };

/**
 * Agree to, or turn down, a proposal you were asked to decide on. One batch:
 *   1. record the answer — only while the event is still `proposed`;
 *   2. accept: schedule it if (and only if) that was the LAST agreement missing;
 *      decline: one "no" declines it;
 *   3. log the transition, attributed to the person whose answer caused it.
 * Each step is gated on the one before having changed a row, so concurrent answers
 * can't both "be last", and nothing transitions on an answer that didn't land.
 */
export async function answerProposal(
  storage: StoragePort,
  access: EventAccess,
  input: {
    readonly answer: "accept" | "decline";
    readonly now: string;
    readonly arrival: Arrival | null;
  },
): Promise<AnswerResult> {
  const { event, participation } = access;
  if (participation.visibility === "HIDDEN" || participation.responseKind !== "accept")
    return { kind: "forbidden" };
  if (!arrivalCounts(access, input.arrival)) return { kind: "forbidden" };
  if (event.status !== "proposed") return { kind: "closed" };
  const state: ResponseState = input.answer === "accept" ? "accepted" : "declined";
  const actor = {
    eventId: event.id,
    actorId: participation.personId,
    now: input.now,
    from: "proposed" as const,
  };
  await storage.batch([
    {
      sql: `UPDATE event_participation
            SET response_state = ?, response_state_at = ?,
                response_state_via = ?, response_state_via_by = ?
            WHERE canonical_event_id = ? AND person_id = ? AND response_kind = 'accept'
              AND response_state IN ('pending', 'accepted')
              AND EXISTS (SELECT 1 FROM canonical_event WHERE id = ? AND status = 'proposed')`,
      params: [
        state,
        input.now,
        input.arrival?.via ?? null,
        input.arrival?.by ?? null,
        event.id,
        participation.personId,
        event.id,
      ],
    },
    ...(input.answer === "accept"
      ? transitionStatements({
          ...actor,
          to: "scheduled",
          afterPrevious: true,
          gate: {
            sql: `NOT EXISTS (SELECT 1 FROM event_participation WHERE canonical_event_id = ?
                    AND response_kind = 'accept' AND response_state IS NOT 'accepted')`,
            params: [event.id],
          },
        })
      : transitionStatements({ ...actor, to: "declined", afterPrevious: true })),
  ]);
  const rows = await storage.query({
    sql: `SELECT ep.response_state, e.status FROM event_participation ep
            JOIN canonical_event e ON e.id = ep.canonical_event_id
          WHERE ep.canonical_event_id = ? AND ep.person_id = ?`,
    params: [event.id, participation.personId],
  });
  const row = z
    .object({ response_state: responseStateSchema.nullable(), status: z.string() })
    .parse(rows[0]);
  if (row.response_state !== state) return { kind: "closed" };
  const status = z
    .enum(["draft", "proposed", "scheduled", "declined", "withdrawn", "cancelled"])
    .parse(row.status);
  return { kind: "recorded", status };
}

/** Whether this person has something to acknowledge on a scheduled event right now. */
export function needsAcknowledgment(access: EventAccess): boolean {
  const { responseKind, responseState } = access.participation;
  if (access.event.status !== "scheduled") return false;
  return (
    (responseKind === "ack" && (responseState === "pending" || responseState === "reack")) ||
    (responseKind === "accept" && responseState === "reack")
  );
}

/**
 * "Seen ✓" — for an acknowledgment request, or to re-confirm after a material change
 * (an `accept` participant returns to `accepted`). Never gates the event.
 */
export async function acknowledge(
  storage: StoragePort,
  access: EventAccess,
  input: { readonly now: string; readonly arrival: Arrival | null },
): Promise<ResponseResult> {
  if (access.participation.visibility === "HIDDEN") return { kind: "forbidden" };
  if (!arrivalCounts(access, input.arrival)) return { kind: "forbidden" };
  if (!needsAcknowledgment(access))
    return { kind: "invalid", reason: "There's nothing to acknowledge." };
  const written = await storage.query({
    sql: `UPDATE event_participation
          SET response_state = CASE response_kind WHEN 'ack' THEN 'acknowledged' ELSE 'accepted' END,
              response_state_at = ?, response_state_via = ?, response_state_via_by = ?
          WHERE canonical_event_id = ? AND person_id = ?
            AND ((response_kind = 'ack' AND response_state IN ('pending', 'reack'))
              OR (response_kind = 'accept' AND response_state = 'reack'))
            AND EXISTS (SELECT 1 FROM canonical_event WHERE id = ? AND status = 'scheduled')
          RETURNING person_id`,
    params: [
      input.now,
      input.arrival?.via ?? null,
      input.arrival?.by ?? null,
      access.event.id,
      access.participation.personId,
      access.event.id,
    ],
  });
  return written.length === 1 ? { kind: "recorded" } : { kind: "closed" };
}

export interface RequestEntry {
  readonly personId: string;
  readonly shown: Shown;
  readonly kind: Extract<ResponseKind, "accept" | "ack">;
  readonly state: ResponseState;
  readonly at: string | null;
  readonly arrival: Arrival | null;
}

const requestRowSchema = shownRowSchema.extend({
  person_id: z.string(),
  response_kind: responseKindSchema.extract(["accept", "ack"]),
  response_state: responseStateSchema,
  response_state_at: z.string().nullable(),
  response_state_via: z.string().nullable(),
  response_state_via_by: z.string().nullable(),
});

/** Who was asked to agree or acknowledge, and where each stands — for proven access. */
export async function listRequests(
  storage: StoragePort,
  access: EventAccess,
): Promise<RequestEntry[]> {
  const rows = await storage.query({
    sql: `SELECT ep.person_id, p.email, p.display_name, ep.handle, ${shownEmailSql("ep")} AS show_email,
                 ep.response_kind, ep.response_state, ep.response_state_at,
                 ep.response_state_via, ep.response_state_via_by
          FROM event_participation ep JOIN person p ON p.id = ep.person_id
          WHERE ep.canonical_event_id = ? AND ep.response_kind IN ('accept', 'ack')
          ORDER BY ep.created_at, ep.person_id`,
    params: [access.event.id],
  });
  return rows.map((row) => {
    const r = requestRowSchema.parse(row);
    return {
      personId: r.person_id,
      shown: shownAs(r.person_id, r, access.event.id),
      kind: r.response_kind,
      state: r.response_state,
      at: r.response_state_at,
      arrival: arrivalOf(r.response_state_via, r.response_state_via_by),
    };
  });
}

// --- Receipts (DESIGN §10 rc42 *Who really answered*) ----------------------------------

/** Why a receipt didn't go out: an opt-out, the mail cap, or the provider. */
export const receiptUnsentSchema = z.enum(["suppressed", "capped", "failed"]);
export type ReceiptUnsent = z.infer<typeof receiptUnsentSchema>;

/** Remember that a receipt for this person's answer here didn't go out, for the history. */
export async function recordUnsentReceipt(
  storage: StoragePort,
  input: {
    readonly eventId: string;
    readonly personId: string;
    readonly reason: ReceiptUnsent;
    readonly now: string;
    readonly newId?: () => string;
  },
): Promise<void> {
  await storage.batch([
    {
      sql: `INSERT INTO receipt_unsent (id, canonical_event_id, person_id, reason, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [
        (input.newId ?? (() => uuidv7()))(),
        input.eventId,
        input.personId,
        input.reason,
        input.now,
      ],
    },
  ]);
}

export interface UnsentReceiptEntry {
  readonly personId: string;
  /** As the event's people see them (rc21; rc42: with the address, since it is verified). */
  readonly shown: Shown;
  readonly reason: ReceiptUnsent;
  readonly at: string;
}

const unsentRowSchema = shownRowSchema.extend({
  person_id: z.string(),
  reason: receiptUnsentSchema,
  created_at: z.string(),
});

/** The receipts that didn't go out on this event, for its history. */
export async function listUnsentReceipts(
  storage: StoragePort,
  access: EventAccess,
): Promise<UnsentReceiptEntry[]> {
  if (access.participation.visibility === "HIDDEN") return [];
  const rows = await storage.query({
    sql: `SELECT r.person_id, r.reason, r.created_at, p.email, p.display_name, ep.handle,
            ${shownEmailSql("ep")} AS show_email
          FROM receipt_unsent r JOIN person p ON p.id = r.person_id
            LEFT JOIN event_participation ep
              ON ep.canonical_event_id = r.canonical_event_id AND ep.person_id = r.person_id
          WHERE r.canonical_event_id = ? ORDER BY r.created_at`,
    params: [access.event.id],
  });
  return rows.map((row) => {
    const r = unsentRowSchema.parse(row);
    return {
      personId: r.person_id,
      shown: shownAs(r.person_id, r, access.event.id),
      reason: r.reason,
      at: r.created_at,
    };
  });
}
