// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StoragePort } from "../db/port.js";
import type { MailMessage, MailPort } from "./port.js";

// A hard cap on outbound mail, enforced in the app (DESIGN §13 rc9). Cloudflare offers
// no provider-side spend cap for Email Sending, and "accidents happen" — a retry loop
// or a bug that invites a whole table twice must not become a bill.
//
// Every send first RESERVES a slot with one atomic statement:
//
//   INSERT ... SELECT ... WHERE today's count < daily AND this month's < monthly
//   RETURNING id
//
// and sends only if a row came back. One statement matters: a separate "count, then
// send" check races across concurrent Workers isolates, and every racer would see
// room and send, overshooting the cap by the number of racers. SQLite (and D1, which
// serialises writes per database) evaluates the subqueries and the insert as one
// atomic step.
//
// A slot counts the ATTEMPT, so a send that fails after reserving still uses one.
// That is deliberately conservative: the cap bounds spend, and a failing provider
// being retried is exactly the accident it exists for.

export interface MailCap {
  readonly daily: number;
  readonly monthly: number;
  /**
   * Of the daily cap, how many may be anonymous (sign-in links). Defaults to a
   * quarter of it: the other three quarters are always left for mail a signed-in
   * person caused (DESIGN §13 rc21).
   */
  readonly anonymousDaily?: number;
  /**
   * How much of the cap one sender's mail to other addresses may use (DESIGN §13
   * rc37): by default a quarter of a day and a fifth of a month, so no one account
   * spends everyone's mail however many groups, events and threads it makes.
   */
  readonly senderDaily?: number;
  readonly senderMonthly?: number;
  /** A new account's smaller daily share, for its first days after it first signs in (rc39). */
  readonly newSenderDaily?: number;
  readonly newSenderDays?: number;
}

export function anonymousDailyOf(cap: MailCap): number {
  return cap.anonymousDaily ?? Math.floor(cap.daily / 4);
}

/** One sender's share of the cap, defaults filled in (rc37, rc39). */
export interface SenderShare {
  readonly daily: number;
  readonly monthly: number;
  readonly newDaily: number;
  readonly newDays: number;
}

export const NEW_SENDER_DAILY = 20;
export const NEW_SENDER_DAYS = 7;

export function senderShareOf(cap: MailCap): SenderShare {
  const daily = cap.senderDaily ?? Math.floor(cap.daily / 4);
  return {
    daily,
    monthly: cap.senderMonthly ?? Math.floor(cap.monthly / 5),
    newDaily: cap.newSenderDaily ?? Math.min(NEW_SENDER_DAILY, daily),
    newDays: cap.newSenderDays ?? NEW_SENDER_DAYS,
  };
}

/** Thrown when either cap is reached; the message is refused, never queued. */
export class MailCapReachedError extends Error {
  constructor(cap: MailCap) {
    super(`outbound mail cap reached (daily ${cap.daily}, monthly ${cap.monthly}); not sent`);
    this.name = "MailCapReachedError";
  }
}

/**
 * Thrown when the instance has room but this sender's share is used up (rc37). Still a
 * reached cap, so every caller that handles one handles this; the page can say whose.
 */
export class SenderShareReachedError extends MailCapReachedError {
  constructor(
    cap: MailCap,
    /** Which share: today's or this month's. */
    readonly period: "day" | "month",
    /** For a new account stopped at its smaller daily share, when that ends (rc39). */
    readonly newUntil: string | null,
  ) {
    super(cap);
    this.message = `this sender's ${period === "day" ? "daily" : "monthly"} mail share is used; not sent`;
    this.name = "SenderShareReachedError";
  }
}

export interface CappedMailOptions {
  readonly cap: MailCap;
  /** Injected clock, ISO-8601 UTC (§9). Days and months are UTC. */
  readonly now: () => string;
}

/** What a send is, as the cap sees it. */
export interface SlotKind {
  /** A sign-in link: also counted against the anonymous share (rc21). */
  readonly anonymous?: boolean;
  /** Mail someone caused to another address: also counted against their share (rc37). */
  readonly senderId?: string;
}

function newSenderCutoff(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Reserve one send slot; true when reserved, false when a cap or share is reached. An
 * anonymous send must also fit the day's anonymous share, and a sender's must fit theirs,
 * in the same statement. A sender who signed in within the last `newDays` (or never: the
 * conservative reading) gets the smaller daily share.
 */
export async function reserveMailSlot(
  storage: StoragePort,
  cap: MailCap,
  nowIso: string,
  kind: SlotKind = {},
): Promise<boolean> {
  const day = nowIso.slice(0, 10);
  const month = nowIso.slice(0, 7);
  const flag = kind.anonymous === true ? 1 : 0;
  const sender = kind.senderId ?? null;
  const share = senderShareOf(cap);
  const rows = await storage.query({
    sql: `INSERT INTO mail_send (day, month, created_at, anonymous, sender_id)
          SELECT ?, ?, ?, ?, ?
          WHERE (SELECT count(*) FROM mail_send WHERE day = ?) < ?
            AND (SELECT count(*) FROM mail_send WHERE month = ?) < ?
            AND (? = 0 OR (SELECT count(*) FROM mail_send WHERE day = ? AND anonymous = 1) < ?)
            AND (? IS NULL OR (
              (SELECT count(*) FROM mail_send WHERE sender_id = ? AND day = ?)
                < CASE WHEN (SELECT coalesce(signed_in_at, ?) FROM person WHERE id = ?) > ?
                       THEN ? ELSE ? END
              AND (SELECT count(*) FROM mail_send WHERE sender_id = ? AND month = ?) < ?))
          RETURNING id`,
    params: [
      day,
      month,
      nowIso,
      flag,
      sender,
      day,
      cap.daily,
      month,
      cap.monthly,
      flag,
      day,
      anonymousDailyOf(cap),
      sender,
      sender,
      day,
      nowIso,
      sender,
      newSenderCutoff(nowIso, share.newDays),
      share.newDaily,
      share.daily,
      sender,
      month,
      share.monthly,
    ],
  });
  return rows.length > 0;
}

/**
 * Why a reservation was refused, read after the fact for the message (a read, so the
 * reservation itself stays one statement): the instance's cap, or the sender's share.
 */
export async function refusal(
  storage: StoragePort,
  cap: MailCap,
  nowIso: string,
  kind: SlotKind = {},
): Promise<MailCapReachedError> {
  const instance = new MailCapReachedError(cap);
  if (kind.senderId === undefined) return instance;
  const share = senderShareOf(cap);
  const day = nowIso.slice(0, 10);
  const month = nowIso.slice(0, 7);
  const rows = await storage.query({
    sql: `SELECT (SELECT count(*) FROM mail_send WHERE day = ?) AS today,
                 (SELECT count(*) FROM mail_send WHERE month = ?) AS this_month,
                 (SELECT count(*) FROM mail_send WHERE sender_id = ? AND month = ?) AS theirs,
                 (SELECT signed_in_at FROM person WHERE id = ?) AS signed_in_at`,
    params: [day, month, kind.senderId, month, kind.senderId],
  });
  const r = rows[0];
  if (Number(r?.today ?? 0) >= cap.daily || Number(r?.this_month ?? 0) >= cap.monthly)
    return instance;
  if (Number(r?.theirs ?? 0) >= share.monthly)
    return new SenderShareReachedError(cap, "month", null);
  const signedIn = r?.signed_in_at;
  const until =
    typeof signedIn === "string"
      ? new Date(Date.parse(signedIn) + share.newDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
  const isNew = until !== null && until > nowIso && share.newDaily < share.daily;
  return new SenderShareReachedError(cap, "day", isNew ? until : null);
}

/** How many sends a person caused this month (rc37): for their export. */
export async function sentThisMonth(
  storage: StoragePort,
  personId: string,
  nowIso: string,
): Promise<number> {
  const rows = await storage.query({
    sql: "SELECT count(*) AS n FROM mail_send WHERE sender_id = ? AND month = ?",
    params: [personId, nowIso.slice(0, 7)],
  });
  return Number(rows[0]?.n ?? 0);
}

export function cappedMailPort(
  inner: MailPort,
  storage: StoragePort,
  options: CappedMailOptions,
): MailPort {
  const { cap } = options;
  if (!Number.isInteger(cap.daily) || !Number.isInteger(cap.monthly) || cap.daily < 0) {
    throw new Error("mail cap must be non-negative integers");
  }
  if (cap.daily > cap.monthly) {
    throw new Error(`daily mail cap (${cap.daily}) exceeds monthly cap (${cap.monthly})`);
  }
  const share = senderShareOf(cap);
  const counts = [share.daily, share.monthly, share.newDaily, share.newDays];
  if (counts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error("sender mail shares must be non-negative integers");
  }
  if (share.daily > cap.daily || share.monthly > cap.monthly) {
    throw new Error("a sender's mail share exceeds the cap it is a share of");
  }
  if (share.newDaily > share.daily) {
    throw new Error("a new sender's daily mail share exceeds the ordinary one");
  }
  return {
    async send(message: MailMessage): Promise<void> {
      const now = options.now();
      const kind: SlotKind = {
        anonymous: message.anonymous === true,
        ...(message.cause.kind === "from" ? { senderId: message.cause.senderId } : {}),
      };
      if (!(await reserveMailSlot(storage, cap, now, kind))) {
        throw await refusal(storage, cap, now, kind);
      }
      await inner.send(message);
    },
  };
}
