// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { SqlStatement, StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import type { MailAbout, MailMessage, MailPort, UnsentWhat } from "../mail/port.js";
import { hashToken, issueToken } from "../people/tokens.js";
import { eraseAccount } from "./erasure.js";

// Opt-outs (DESIGN §10 *People who never signed up*, rc24). An address someone else gave us
// can stop that person's mail, a group's, or everyone's. Only a hash of the address is
// kept, so the opt-out list itself holds no addresses.
//
// One seam: every send passes `suppressingMailPort`, ahead of the cap. It drops mail an
// opt-out covers, without an error (so a dropped send costs none of the cap, and no page
// can tell an opted-out address from any other), and adds the opt-out link to the rest. A
// caller can't forget either. Mail the address asked for itself is never stopped.

export const OPT_OUT_PATH = "/opt-out";

/** How long the link in one email works. Every email has its own. */
export const OPT_OUT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type SuppressionScope =
  | { readonly kind: "all" }
  | { readonly kind: "group"; readonly id: string }
  | { readonly kind: "person"; readonly id: string };

/** The hash an opt-out is kept by: SHA-256 of the normalised address. */
export function addressHash(email: string): Promise<string> {
  return hashToken(email);
}

/** Whether an opt-out on this address covers mail from this sender, through this group. */
export async function isSuppressed(
  storage: StoragePort,
  email: string,
  from: { readonly senderId: string; readonly groupId: string | null },
): Promise<boolean> {
  const rows = await storage.query({
    sql: `SELECT 1 FROM mail_suppression
          WHERE address_hash = ?
            AND (scope = 'all'
              OR (scope = 'person' AND scope_id = ?)
              OR (scope = 'group' AND scope_id = ?))
          LIMIT 1`,
    params: [await addressHash(email), from.senderId, from.groupId ?? ""],
  });
  return rows.length > 0;
}

export interface SuppressingOptions {
  readonly publicBaseUrl: string;
  readonly now: () => string;
}

export function suppressingMailPort(
  inner: MailPort,
  storage: StoragePort,
  options: SuppressingOptions,
): MailPort {
  return {
    async send(message: MailMessage): Promise<void> {
      // Guests and former members carry `.invalid` addresses (RFC 6761): nothing goes there,
      // whoever asked (rc25, rc21). Here, so no caller can forget it.
      if (message.to.endsWith(".invalid")) return;
      const cause = message.cause;
      if (cause.kind === "self") return inner.send(message);
      if (await isSuppressed(storage, message.to, cause)) {
        // rc51: dropped, still without an error; a verified plan of two records it.
        if (cause.about !== undefined)
          await recordUnsentMail(storage, {
            to: message.to,
            senderId: cause.senderId,
            about: cause.about,
            now: options.now(),
          });
        return;
      }
      const now = options.now();
      const issued = await issueToken();
      await storage.batch([
        {
          sql: `INSERT INTO opt_out_token (token_hash, email, sender_id, group_id, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: [
            issued.hash,
            message.to,
            cause.senderId,
            cause.groupId,
            now,
            new Date(Date.parse(now) + OPT_OUT_TTL_MS).toISOString(),
          ],
        },
      ]);
      const link = new URL(OPT_OUT_PATH, options.publicBaseUrl);
      link.searchParams.set("t", issued.token);
      return inner.send({
        ...message,
        text: [
          message.text,
          "",
          "--",
          `You got this because ${cause.why}.`,
          `Don't want these? ${link.toString()}`,
        ].join("\n"),
      });
    },
  };
}

const tokenRowSchema = z.object({
  email: z.string(),
  sender_id: z.string().nullable(),
  group_id: z.string().nullable(),
  signed_in: z.number(),
});

export interface OptOutLink {
  readonly email: string;
  readonly senderId: string | null;
  readonly groupId: string | null;
  /** True if no person has this address, or theirs has never signed in. */
  readonly neverSignedIn: boolean;
}

/** What a live opt-out link is for; null if it's unknown or expired. Reads only. */
export async function peekOptOut(
  storage: StoragePort,
  token: string,
  now: string,
): Promise<OptOutLink | null> {
  const rows = await storage.query({
    sql: `SELECT t.email, t.sender_id, t.group_id,
                 EXISTS (SELECT 1 FROM person p
                         WHERE p.email = t.email AND p.signed_in_at IS NOT NULL) AS signed_in
          FROM opt_out_token t
          WHERE t.token_hash = ? AND t.expires_at > ?`,
    params: [await hashToken(token), now],
  });
  if (rows[0] === undefined) return null;
  const r = tokenRowSchema.parse(rows[0]);
  return {
    email: r.email,
    senderId: r.sender_id,
    groupId: r.group_id,
    neverSignedIn: r.signed_in === 0,
  };
}

/**
 * Opt the address out. From everyone, its opt-out links go too: they hold the address (rc24),
 * so starting that one again is on the account page. `prefersLinks` is "{name} can send me
 * the link" (rc51); choosing again replaces it, so the latest choice stands.
 */
export async function suppress(
  storage: StoragePort,
  email: string,
  scope: SuppressionScope,
  now: string,
  options: { readonly prefersLinks?: boolean } = {},
): Promise<void> {
  const id = scope.kind === "all" ? "" : scope.id;
  const prefers = options.prefersLinks === true ? 1 : 0;
  const before = await suppressionsOn(storage, email);
  const after = [
    ...before.filter((r) => r.scope !== scope.kind || r.scope_id !== id),
    { scope: scope.kind, scope_id: id, prefers_links: prefers },
  ];
  await storage.batch([
    {
      sql: `INSERT INTO mail_suppression (address_hash, scope, scope_id, created_at, prefers_links)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (address_hash, scope, scope_id)
            DO UPDATE SET prefers_links = excluded.prefers_links`,
      params: [await addressHash(email), scope.kind, id, now, prefers],
    },
    ...(await trailStatements(storage, email, before, after, now)),
    ...(scope.kind === "all"
      ? [{ sql: "DELETE FROM opt_out_token WHERE email = ?", params: [email] }]
      : []),
  ]);
}

/**
 * Delete everything about an address that has never signed in, at once (rc24): nobody
 * signed in to be warned, so there's no 7-day wait. It opts out from everyone first, or
 * the next invite would bring the address back. The person, if there is one, is erased as
 * an account is (tombstones, the ledger), which takes its invites and sign-in links with
 * it; with no person, those are deleted here. Refused — false, nothing written — once the
 * address has signed in: an account is deleted by signing in.
 */
export async function deleteEverything(
  storage: StoragePort,
  email: string,
  now: string,
): Promise<boolean> {
  const rows = await storage.query({
    sql: "SELECT id, signed_in_at FROM person WHERE email = ?",
    params: [email],
  });
  const person =
    rows[0] === undefined
      ? null
      : z.object({ id: z.string(), signed_in_at: z.string().nullable() }).parse(rows[0]);
  if (person !== null && person.signed_in_at !== null) return false;
  await suppress(storage, email, { kind: "all" }, now);
  if (person !== null) {
    await eraseAccount(storage, person.id, { now });
    return true;
  }
  await storage.batch([
    { sql: "DELETE FROM login_token WHERE email = ?", params: [email] },
    { sql: "DELETE FROM group_invite WHERE email = ?", params: [email] },
  ]);
  return true;
}

export interface OptOutView {
  readonly scope: "all" | "group" | "person";
  readonly scopeId: string;
  readonly createdAt: string;
  /** The group's name, for a group opt-out. A person is never named (see the account page). */
  readonly groupName: string | null;
}

const optOutRowSchema = z.object({
  scope: z.enum(["all", "group", "person"]),
  scope_id: z.string(),
  created_at: z.string(),
  group_name: z.string().nullable(),
});

/** The opt-outs on an address, for its own account page: everyone first. */
export async function optOutsOf(storage: StoragePort, email: string): Promise<OptOutView[]> {
  const rows = await storage.query({
    sql: `SELECT s.scope, s.scope_id, s.created_at, g.name AS group_name
          FROM mail_suppression s
          LEFT JOIN person_group g ON s.scope = 'group' AND g.id = s.scope_id
          WHERE s.address_hash = ?
          ORDER BY s.scope = 'all' DESC, s.created_at, s.scope_id`,
    params: [await addressHash(email)],
  });
  return rows.map((row) => {
    const r = optOutRowSchema.parse(row);
    return {
      scope: r.scope,
      scopeId: r.scope_id,
      createdAt: r.created_at,
      groupName: r.group_name,
    };
  });
}

/**
 * Undo one opt-out on this address: only ever its own, since the caller passes its email.
 * In a verified plan of two, getting the other's email again is recorded (rc51).
 */
export async function undoOptOut(
  storage: StoragePort,
  email: string,
  scope: string,
  scopeId: string,
  now: string,
): Promise<void> {
  const before = await suppressionsOn(storage, email);
  const after = before.filter((r) => r.scope !== scope || r.scope_id !== scopeId);
  await storage.batch([
    {
      sql: "DELETE FROM mail_suppression WHERE address_hash = ? AND scope = ? AND scope_id = ?",
      params: [await addressHash(email), scope, scopeId],
    },
    ...(await trailStatements(storage, email, before, after, now)),
  ]);
}

// --- Said in a verified plan of two (DESIGN §10 *Mail that stops*, rc51) -----------------
//
// Everywhere else an opt-out stays silent. In a verified event or thread with exactly two
// people, the history records when one of them stops the other's email or takes it back, and
// each email of the other's that then doesn't go out — never which opt-out it was.

const suppressionRowSchema = z.object({
  scope: z.string(),
  scope_id: z.string(),
  prefers_links: z.number(),
});
type SuppressionRow = z.infer<typeof suppressionRowSchema>;

async function suppressionsOn(storage: StoragePort, email: string): Promise<SuppressionRow[]> {
  const rows = await storage.query({
    sql: "SELECT scope, scope_id, prefers_links FROM mail_suppression WHERE address_hash = ?",
    params: [await addressHash(email)],
  });
  return rows.map((r) => suppressionRowSchema.parse(r));
}

/** The test the mail wrapper makes (`isSuppressed`), over rows already read: what covers. */
function covering(
  rows: readonly SuppressionRow[],
  from: { readonly senderId: string; readonly groupId: string | null },
): readonly SuppressionRow[] {
  return rows.filter(
    (r) =>
      r.scope === "all" ||
      (r.scope === "person" && r.scope_id === from.senderId) ||
      (r.scope === "group" && from.groupId !== null && r.scope_id === from.groupId),
  );
}

/** Where one person's mail to an address stands: it arrives, it stops, or it stops for links. */
type Reach = "again" | "stopped" | "stopped_links";

function reach(
  rows: readonly SuppressionRow[],
  from: { readonly senderId: string; readonly groupId: string | null },
): Reach {
  const by = covering(rows, from);
  if (by.length === 0) return "again";
  return by.some((r) => r.prefers_links === 1) ? "stopped_links" : "stopped";
}

/** Counted as people: neither a guest (rc25) nor erased (rc21). */
const COUNTED = "xp.guest_at IS NULL AND xp.erased_at IS NULL";

const pairRowSchema = z.object({
  kind: z.enum(["event", "thread"]),
  id: z.string(),
  group_id: z.string().nullable(),
  me_id: z.string(),
  other_id: z.string(),
});

/** The verified events and threads of exactly two this address is one of, with the other. */
async function pairsOf(storage: StoragePort, email: string) {
  const rows = await storage.query({
    sql: `SELECT 'event' AS kind, e.id, e.group_id, me.person_id AS me_id, o.person_id AS other_id
          FROM person mp
            JOIN event_participation me ON me.person_id = mp.id
            JOIN canonical_event e ON e.id = me.canonical_event_id AND e.verified_at IS NOT NULL
            JOIN event_participation o
              ON o.canonical_event_id = e.id AND o.person_id <> me.person_id
            JOIN person xp ON xp.id = o.person_id AND ${COUNTED}
          WHERE mp.email = ?
            AND (SELECT COUNT(*) FROM event_participation x JOIN person xp ON xp.id = x.person_id
                 WHERE x.canonical_event_id = e.id AND ${COUNTED}) = 2
          UNION ALL
          SELECT 'thread', t.id, t.group_id, me.person_id, o.person_id
          FROM person mp
            JOIN plan_thread_member me ON me.person_id = mp.id
            JOIN plan_thread t ON t.id = me.thread_id AND t.verified_at IS NOT NULL
            JOIN plan_thread_member o ON o.thread_id = t.id AND o.person_id <> me.person_id
            JOIN person xp ON xp.id = o.person_id AND ${COUNTED}
          WHERE mp.email = ?
            AND (SELECT COUNT(*) FROM plan_thread_member x JOIN person xp ON xp.id = x.person_id
                 WHERE x.thread_id = t.id AND ${COUNTED}) = 2`,
    params: [email, email],
  });
  return rows.map((r) => pairRowSchema.parse(r));
}

/**
 * What changing this address's opt-outs from `before` to `after` records: in each verified
 * plan of two it is on, whether the other's email now stops, stops with "send me the link",
 * or starts again. Only changes — a second opt-out covering the same mail adds nothing.
 */
async function trailStatements(
  storage: StoragePort,
  email: string,
  before: readonly SuppressionRow[],
  after: readonly SuppressionRow[],
  now: string,
): Promise<SqlStatement[]> {
  const statements: SqlStatement[] = [];
  for (const pair of await pairsOf(storage, email)) {
    const from = { senderId: pair.other_id, groupId: pair.group_id };
    const was = reach(before, from);
    const is = reach(after, from);
    if (was === is) continue;
    statements.push({
      sql:
        pair.kind === "event"
          ? `INSERT INTO mail_trail (id, canonical_event_id, person_id, kind, created_at)
             VALUES (?, ?, ?, ?, ?)`
          : `INSERT INTO mail_trail (id, thread_id, person_id, kind, created_at)
             VALUES (?, ?, ?, ?, ?)`,
      params: [uuidv7(), pair.id, pair.me_id, is, now],
    });
  }
  return statements;
}

/**
 * What the opt-out page warns before its buttons (rc51): whether this address is in a
 * verified plan of two whose other person's email still reaches it, and whether `senderId`
 * — the email's own sender — is the other person in one of them, stopped or not.
 */
export async function pairWarning(
  storage: StoragePort,
  email: string,
  senderId: string | null,
): Promise<{ readonly warn: boolean; readonly sender: boolean }> {
  const rows = await suppressionsOn(storage, email);
  const pairs = await pairsOf(storage, email);
  const open = pairs.filter(
    (p) => reach(rows, { senderId: p.other_id, groupId: p.group_id }) === "again",
  );
  return {
    warn: open.length > 0,
    sender: senderId !== null && pairs.some((p) => p.other_id === senderId),
  };
}

/**
 * Record an email an opt-out dropped, if what it is about is a verified plan of exactly two
 * people, the address and its sender. Anywhere else it writes nothing, so the opt-out stays
 * silent. Mail to oneself (a receipt) is `receipt_unsent`'s, never this.
 */
export async function recordUnsentMail(
  storage: StoragePort,
  input: {
    readonly to: string;
    readonly senderId: string;
    readonly about: MailAbout;
    readonly now: string;
  },
): Promise<void> {
  const { to, senderId, about, now } = input;
  // In the order the placeholders appear: the row, then what it is about, then who.
  const params = [uuidv7(), about.what, senderId, now, about.id, to, senderId, senderId];
  await storage.batch([
    about.kind === "event"
      ? {
          sql: `INSERT INTO mail_trail
                  (id, canonical_event_id, person_id, kind, what, caused_by, created_at)
                SELECT ?, e.id, p.id, 'unsent', ?, ?, ?
                FROM person p JOIN canonical_event e ON e.id = ? AND e.verified_at IS NOT NULL
                WHERE p.email = ? AND p.id <> ?
                  AND EXISTS (SELECT 1 FROM event_participation a
                              WHERE a.canonical_event_id = e.id AND a.person_id = p.id)
                  AND EXISTS (SELECT 1 FROM event_participation b
                              WHERE b.canonical_event_id = e.id AND b.person_id = ?)
                  AND (SELECT COUNT(*) FROM event_participation x
                         JOIN person xp ON xp.id = x.person_id
                       WHERE x.canonical_event_id = e.id AND ${COUNTED}) = 2`,
          params,
        }
      : {
          sql: `INSERT INTO mail_trail
                  (id, thread_id, person_id, kind, what, caused_by, created_at)
                SELECT ?, t.id, p.id, 'unsent', ?, ?, ?
                FROM person p JOIN plan_thread t ON t.id = ? AND t.verified_at IS NOT NULL
                WHERE p.email = ? AND p.id <> ?
                  AND EXISTS (SELECT 1 FROM plan_thread_member a
                              WHERE a.thread_id = t.id AND a.person_id = p.id)
                  AND EXISTS (SELECT 1 FROM plan_thread_member b
                              WHERE b.thread_id = t.id AND b.person_id = ?)
                  AND (SELECT COUNT(*) FROM plan_thread_member x
                         JOIN person xp ON xp.id = x.person_id
                       WHERE x.thread_id = t.id AND ${COUNTED}) = 2`,
          params,
        },
  ]);
}

const unsentWhatSchema = z.enum(["answer_link", "vote_link", "request", "result"]);

/** One entry of the trail, for a history page. */
export type MailTrailEntry = {
  readonly personId: string;
  readonly at: string;
} & (
  | { readonly kind: "stopped" | "stopped_links" | "again" }
  | { readonly kind: "unsent"; readonly what: UnsentWhat }
);

// The table's CHECK keeps `what` exactly on the unsent rows.
const trailRowSchema = z.discriminatedUnion("kind", [
  z.object({
    person_id: z.string(),
    kind: z.enum(["stopped", "stopped_links", "again"]),
    created_at: z.string(),
  }),
  z.object({
    person_id: z.string(),
    kind: z.literal("unsent"),
    what: unsentWhatSchema,
    created_at: z.string(),
  }),
]);

/** The trail of one event or thread, oldest first. The caller has checked who may see it. */
export async function mailTrailOf(
  storage: StoragePort,
  of: { readonly kind: "event" | "thread"; readonly id: string },
): Promise<MailTrailEntry[]> {
  const rows = await storage.query({
    sql:
      of.kind === "event"
        ? `SELECT person_id, kind, what, created_at FROM mail_trail
           WHERE canonical_event_id = ? ORDER BY created_at, id`
        : `SELECT person_id, kind, what, created_at FROM mail_trail
           WHERE thread_id = ? ORDER BY created_at, id`,
    params: [of.id],
  });
  return rows.map((row) => {
    const r = trailRowSchema.parse(row);
    return r.kind === "unsent"
      ? { personId: r.person_id, at: r.created_at, kind: r.kind, what: r.what }
      : { personId: r.person_id, at: r.created_at, kind: r.kind };
  });
}

const UNSENT_WHAT: Record<UnsentWhat, string> = {
  answer_link: "An answer link",
  vote_link: "A vote link",
  request: "A request to agree",
  result: "The email saying what was agreed",
};

/** How the history says it, with the person named as the page names them. Never the scope. */
export function mailTrailText(entry: MailTrailEntry, name: string): string {
  switch (entry.kind) {
    case "stopped":
      return `${name} stopped emails about this.`;
    case "stopped_links":
      return `${name} stopped emails about this, and asked for the link instead.`;
    case "again":
      return `${name} gets emails about this again.`;
    case "unsent":
      return `${UNSENT_WHAT[entry.what]} to ${name} didn't go out: ${name} isn't receiving email about this.`;
    default: {
      const never: never = entry;
      return never;
    }
  }
}
