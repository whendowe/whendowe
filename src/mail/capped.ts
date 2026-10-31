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
}

export function anonymousDailyOf(cap: MailCap): number {
  return cap.anonymousDaily ?? Math.floor(cap.daily / 4);
}

/** Thrown when either cap is reached; the message is refused, never queued. */
export class MailCapReachedError extends Error {
  constructor(cap: MailCap) {
    super(`outbound mail cap reached (daily ${cap.daily}, monthly ${cap.monthly}); not sent`);
    this.name = "MailCapReachedError";
  }
}

export interface CappedMailOptions {
  readonly cap: MailCap;
  /** Injected clock, ISO-8601 UTC (§9). Days and months are UTC. */
  readonly now: () => string;
}

/**
 * Reserve one send slot; true when reserved, false when a cap is reached. An
 * anonymous send must also fit the day's anonymous share, in the same statement.
 */
export async function reserveMailSlot(
  storage: StoragePort,
  cap: MailCap,
  nowIso: string,
  anonymous = false,
): Promise<boolean> {
  const day = nowIso.slice(0, 10);
  const month = nowIso.slice(0, 7);
  const flag = anonymous ? 1 : 0;
  const rows = await storage.query({
    sql: `INSERT INTO mail_send (day, month, created_at, anonymous)
          SELECT ?, ?, ?, ?
          WHERE (SELECT count(*) FROM mail_send WHERE day = ?) < ?
            AND (SELECT count(*) FROM mail_send WHERE month = ?) < ?
            AND (? = 0 OR (SELECT count(*) FROM mail_send WHERE day = ? AND anonymous = 1) < ?)
          RETURNING id`,
    params: [
      day,
      month,
      nowIso,
      flag,
      day,
      cap.daily,
      month,
      cap.monthly,
      flag,
      day,
      anonymousDailyOf(cap),
    ],
  });
  return rows.length > 0;
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
  return {
    async send(message: MailMessage): Promise<void> {
      if (!(await reserveMailSlot(storage, cap, options.now(), message.anonymous === true))) {
        throw new MailCapReachedError(cap);
      }
      await inner.send(message);
    },
  };
}
