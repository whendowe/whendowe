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

/** Reserve one send slot; true when reserved, false when a cap is reached. */
export async function reserveMailSlot(
  storage: StoragePort,
  cap: MailCap,
  nowIso: string,
): Promise<boolean> {
  const day = nowIso.slice(0, 10);
  const month = nowIso.slice(0, 7);
  const rows = await storage.query({
    sql: `INSERT INTO mail_send (day, month, created_at)
          SELECT ?, ?, ?
          WHERE (SELECT count(*) FROM mail_send WHERE day = ?) < ?
            AND (SELECT count(*) FROM mail_send WHERE month = ?) < ?
          RETURNING id`,
    params: [day, month, nowIso, day, cap.daily, month, cap.monthly],
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
      if (!(await reserveMailSlot(storage, cap, options.now()))) {
        throw new MailCapReachedError(cap);
      }
      await inner.send(message);
    },
  };
}
