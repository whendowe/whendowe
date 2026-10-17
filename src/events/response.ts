// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import { type Visibility, visibilitySchema } from "../people/invite.js";
import { hashToken, issueToken } from "../people/tokens.js";
import { type EventAccess, findEventForParticipant } from "./event.js";

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
  input: { readonly attendance: Attendance; readonly now: string },
): Promise<ResponseResult> {
  if (access.participation.visibility === "HIDDEN") return { kind: "forbidden" };
  const written = await storage.query({
    sql: `UPDATE event_participation SET attendance = ?, responded_at = ?
          WHERE canonical_event_id = ? AND person_id = ?
            AND EXISTS (SELECT 1 FROM canonical_event WHERE id = ? AND status = 'scheduled')
          RETURNING person_id`,
    params: [
      input.attendance,
      input.now,
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
  input: { readonly body: string; readonly now: string; readonly newId?: () => string },
): Promise<ResponseResult> {
  if (access.participation.visibility === "HIDDEN") return { kind: "forbidden" };
  const body = input.body.trim();
  if (body === "") return { kind: "invalid", reason: "Write something first." };
  if (body.length > FEEDBACK_MAX_LENGTH) {
    return { kind: "invalid", reason: `Keep it under ${FEEDBACK_MAX_LENGTH} characters.` };
  }
  if (access.event.status !== "proposed" && access.event.status !== "scheduled")
    return { kind: "closed" };
  // Count and insert in ONE statement, so parallel requests can't overshoot the ceiling.
  const written = await storage.query({
    sql: `INSERT INTO event_feedback (id, canonical_event_id, person_id, body, created_at)
          SELECT ?, ?, ?, ?, ?
          WHERE (SELECT count(*) FROM event_feedback WHERE canonical_event_id = ? AND person_id = ?) < ?
          RETURNING id`,
    params: [
      (input.newId ?? (() => uuidv7()))(),
      access.event.id,
      access.participation.personId,
      body,
      input.now,
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
  readonly email: string;
  readonly displayName: string | null;
  readonly attendance: Attendance;
  readonly at: string | null;
}

export interface FeedbackEntry {
  readonly personId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly body: string;
  readonly at: string;
}

export interface Responses {
  readonly attendance: readonly AttendanceEntry[];
  readonly feedback: readonly FeedbackEntry[];
}

const attendanceRowSchema = z.object({
  person_id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  attendance: attendanceSchema,
  responded_at: z.string().nullable(),
});

const feedbackRowSchema = z.object({
  person_id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  body: z.string(),
  created_at: z.string(),
});

/**
 * Everyone's attendance and notes, attributed — for someone with proven access. The
 * page decides what a tier may see (names are participant-list information).
 */
export async function listResponses(storage: StoragePort, access: EventAccess): Promise<Responses> {
  const attendance = await storage.query({
    sql: `SELECT ep.person_id, p.email, p.display_name, ep.attendance, ep.responded_at
          FROM event_participation ep JOIN person p ON p.id = ep.person_id
          WHERE ep.canonical_event_id = ? AND ep.attendance IS NOT NULL
          ORDER BY p.email`,
    params: [access.event.id],
  });
  const feedback = await storage.query({
    sql: `SELECT f.person_id, p.email, p.display_name, f.body, f.created_at
          FROM event_feedback f JOIN person p ON p.id = f.person_id
          WHERE f.canonical_event_id = ?
          ORDER BY f.created_at, f.id`,
    params: [access.event.id],
  });
  return {
    attendance: attendance.map((row) => {
      const r = attendanceRowSchema.parse(row);
      return {
        personId: r.person_id,
        email: r.email,
        displayName: r.display_name,
        attendance: r.attendance,
        at: r.responded_at,
      };
    }),
    feedback: feedback.map((row) => {
      const r = feedbackRowSchema.parse(row);
      return {
        personId: r.person_id,
        email: r.email,
        displayName: r.display_name,
        body: r.body,
        at: r.created_at,
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
  input: { readonly now: string; readonly newToken?: typeof issueToken },
): Promise<IssueLinksResult> {
  if (access.participation.editTier !== "edit") return { kind: "forbidden" };
  const action = actionFor(access);
  if (action === null) return { kind: "closed" };

  const now = Date.parse(input.now);
  const expiresAt = new Date(now + RESPONSE_TOKEN_TTL_MS).toISOString();
  const resendCutoff = new Date(now - RESPONSE_RESEND_INTERVAL_MS).toISOString();
  const recipients = (
    await storage.query({
      sql: `SELECT ep.person_id, p.email, p.display_name, ep.visibility
            FROM event_participation ep JOIN person p ON p.id = ep.person_id
            WHERE ep.canonical_event_id = ? AND ep.visibility <> 'HIDDEN' AND ep.person_id <> ?
            ORDER BY p.email`,
      params: [access.event.id, access.participation.personId],
    })
  ).map((row) => recipientRowSchema.parse(row));

  const links: IssuedLink[] = [];
  for (const r of recipients) {
    const issued = await (input.newToken ?? issueToken)();
    const stored = await storage.query({
      sql: `INSERT INTO response_token (token_hash, canonical_event_id, person_id, action, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (canonical_event_id, person_id, action) DO UPDATE
              SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, created_at = excluded.created_at
              WHERE response_token.created_at <= ?
            RETURNING person_id`,
      params: [
        issued.hash,
        access.event.id,
        r.person_id,
        action,
        expiresAt,
        input.now,
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
}

const tokenRowSchema = z.object({
  canonical_event_id: z.string(),
  person_id: z.string(),
  action: responseActionSchema,
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
    sql: `SELECT canonical_event_id, person_id, action FROM response_token
          WHERE token_hash = ? AND expires_at > ?`,
    params: [await hashToken(token), now],
  });
  if (rows[0] === undefined) return null;
  const row = tokenRowSchema.parse(rows[0]);
  const access = await findEventForParticipant(storage, row.canonical_event_id, row.person_id);
  if (access === null || access.participation.visibility === "HIDDEN") return null;
  return { access, action: row.action };
}
