// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { type Diff, diff } from "../changelog.js";
import type { StoragePort } from "../db/port.js";
import { uuidv7 } from "../ids.js";
import {
  type EventAccess,
  type EventFields,
  type EventFieldsInput,
  eventFieldsSchema,
  fieldEditStatements,
  flatten,
} from "./event.js";

// Change proposals — the `propose` tier (DESIGN §10 rc13, MVP-2 slice 2E-2; WORKFLOWS §3).
// A `propose` participant's edit doesn't apply: it waits, attributed, for an `edit`
// participant to accept or reject it. Accepting applies the proposed fields through the
// same optimistic edit as editEvent, at the revision the proposer SAW. If the event moved
// on since, the proposal is `superseded` and the proposer is told — never merged.
//
// "Superseded" is also how a pending proposal READS as soon as the event's revision
// passes its base: nothing has to sweep the table when someone edits the event. The row
// says so too once anyone tries to accept it.

const proposalStatusSchema = z.enum(["pending", "accepted", "rejected", "withdrawn", "superseded"]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

/** Proposals one person may make on one event, ever — keeps a table a stranger can't fill. */
export const PROPOSAL_CEILING = 50;

export interface ChangeProposal {
  readonly id: string;
  readonly proposedBy: string;
  readonly proposerEmail: string;
  readonly proposerName: string | null;
  /** As it stands NOW: a pending proposal on a revision that has moved reads `superseded`. */
  readonly status: ProposalStatus;
  readonly fields: EventFields;
  /** What accepting would change; only while it can still be accepted. */
  readonly change: Diff | null;
  readonly decidedByEmail: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
}

const proposalRowSchema = z.object({
  id: z.string(),
  proposed_by: z.string(),
  proposer_email: z.string(),
  proposer_name: z.string().nullable(),
  base_revision: z.number(),
  fields: z.string(),
  status: proposalStatusSchema,
  decided_by_email: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
});

function toProposal(row: unknown, access: EventAccess): ChangeProposal {
  const r = proposalRowSchema.parse(row);
  const fields = eventFieldsSchema.parse(JSON.parse(r.fields));
  const live = r.status === "pending" && r.base_revision === access.event.revision;
  return {
    id: r.id,
    proposedBy: r.proposed_by,
    proposerEmail: r.proposer_email,
    proposerName: r.proposer_name,
    status: r.status === "pending" && !live ? "superseded" : r.status,
    fields,
    change: live ? diff(flatten(access.event), flatten(fields)) : null,
    decidedByEmail: r.decided_by_email,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

const PROPOSAL_COLUMNS = `ecp.id, ecp.proposed_by, pp.email AS proposer_email,
  pp.display_name AS proposer_name, ecp.base_revision, ecp.fields, ecp.status,
  dp.email AS decided_by_email, ecp.decided_at, ecp.created_at`;
const PROPOSAL_FROM = `event_change_proposal ecp
  JOIN person pp ON pp.id = ecp.proposed_by
  LEFT JOIN person dp ON dp.id = ecp.decided_by`;

export type ProposeResult =
  | { readonly kind: "proposed"; readonly id: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "closed" }
  | { readonly kind: "conflict" }
  | { readonly kind: "limit" };

/**
 * Propose a change to a scheduled event. A person has at most one pending proposal per
 * event: proposing again replaces (withdraws) their earlier one, in the same batch and
 * only if the new one was written.
 *
 * The insert re-checks everything at the moment of writing — the event is still
 * `scheduled` and still at the revision the person saw, they are still `propose` tier,
 * and under the ceiling — so the checks above it are for the answer, not the safety.
 */
export async function proposeChange(
  storage: StoragePort,
  access: EventAccess,
  input: {
    readonly fields: EventFieldsInput;
    readonly now: string;
    /** The revision the person SAW (the form carries it); defaults to the access's. */
    readonly expectedRevision?: number;
    readonly newId?: () => string;
  },
): Promise<ProposeResult> {
  const { event, participation } = access;
  if (participation.editTier !== "propose" || participation.visibility === "HIDDEN")
    return { kind: "forbidden" };
  if (event.status !== "scheduled") return { kind: "closed" };
  const expected = input.expectedRevision ?? event.revision;
  if (expected !== event.revision) return { kind: "conflict" };
  const fields = eventFieldsSchema.parse(input.fields);
  if (Object.keys(diff(flatten(event), flatten(fields))).length === 0) return { kind: "unchanged" };

  const id = (input.newId ?? uuidv7)();
  const me = participation.personId;
  await storage.batch([
    {
      sql: `INSERT INTO event_change_proposal
              (id, canonical_event_id, proposed_by, base_revision, fields, status, created_at)
            SELECT ?, e.id, ep.person_id, e.revision, ?, 'pending', ?
            FROM canonical_event e
              JOIN event_participation ep ON ep.canonical_event_id = e.id AND ep.person_id = ?
            WHERE e.id = ? AND e.revision = ? AND e.status = 'scheduled'
              AND ep.edit_tier = 'propose' AND ep.visibility <> 'HIDDEN'
              AND (SELECT count(*) FROM event_change_proposal
                   WHERE canonical_event_id = e.id AND proposed_by = ep.person_id) < ?`,
      params: [id, JSON.stringify(fields), input.now, me, event.id, expected, PROPOSAL_CEILING],
    },
    {
      sql: `UPDATE event_change_proposal SET status = 'withdrawn', decided_by = ?, decided_at = ?
            WHERE canonical_event_id = ? AND proposed_by = ? AND status = 'pending' AND id <> ?
              AND changes() = 1`,
      params: [me, input.now, event.id, me, id],
    },
  ]);

  const written = await storage.query({
    sql: "SELECT id FROM event_change_proposal WHERE id = ?",
    params: [id],
  });
  if (written.length === 1) return { kind: "proposed", id };
  // Not written: say why, from the state as it is now.
  const state = await storage.query({
    sql: `SELECT e.revision, e.status, ep.edit_tier,
            (SELECT count(*) FROM event_change_proposal
             WHERE canonical_event_id = e.id AND proposed_by = ep.person_id) AS made
          FROM canonical_event e
            JOIN event_participation ep ON ep.canonical_event_id = e.id AND ep.person_id = ?
          WHERE e.id = ?`,
    params: [me, event.id],
  });
  const row = z
    .object({ revision: z.number(), status: z.string(), edit_tier: z.string(), made: z.number() })
    .safeParse(state[0]);
  if (!row.success || row.data.edit_tier !== "propose") return { kind: "forbidden" };
  if (row.data.status !== "scheduled") return { kind: "closed" };
  if (row.data.revision !== expected) return { kind: "conflict" };
  return { kind: "limit" };
}

export type DecideResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected" }
  /** The event changed after the proposal was made; it can no longer be accepted. */
  | { readonly kind: "superseded" }
  | { readonly kind: "forbidden" }
  /** Already decided or withdrawn, or not a proposal on this event. */
  | { readonly kind: "closed" };

/**
 * An editor accepts or rejects a pending proposal.
 *
 * Accept is one batch: the field edit at the proposal's base revision (gated on the
 * proposal still pending and the decider still an editor), its change_log row
 * attributed to the decider, the proposal marked accepted — chained on changes() —
 * then the material-change reack; and last, unchained, "superseded" if the event had
 * moved past the base. Exactly one of accepted / superseded / untouched results.
 */
export async function decideProposal(
  storage: StoragePort,
  access: EventAccess,
  input: {
    readonly proposalId: string;
    readonly decision: "accept" | "reject";
    readonly now: string;
  },
): Promise<DecideResult> {
  const { event, participation } = access;
  if (participation.editTier !== "edit") return { kind: "forbidden" };
  const me = participation.personId;
  const stillEditor = {
    sql: `EXISTS (SELECT 1 FROM event_participation
            WHERE canonical_event_id = ? AND person_id = ? AND edit_tier = 'edit')`,
    params: [event.id, me],
  };

  if (input.decision === "reject") {
    const done = await storage.query({
      sql: `UPDATE event_change_proposal SET status = 'rejected', decided_by = ?, decided_at = ?
            WHERE id = ? AND canonical_event_id = ? AND status = 'pending' AND ${stillEditor.sql}
            RETURNING id`,
      params: [me, input.now, input.proposalId, event.id, ...stillEditor.params],
    });
    return done.length === 1 ? { kind: "rejected" } : { kind: "closed" };
  }

  const rows = await storage.query({
    sql: `SELECT base_revision, fields, status FROM event_change_proposal
          WHERE id = ? AND canonical_event_id = ?`,
    params: [input.proposalId, event.id],
  });
  const found = z
    .object({ base_revision: z.number(), fields: z.string(), status: proposalStatusSchema })
    .safeParse(rows[0]);
  if (!found.success || found.data.status !== "pending") return { kind: "closed" };
  const base = found.data.base_revision;
  const fields = eventFieldsSchema.parse(JSON.parse(found.data.fields));
  // `event` was read at or after `base`; if it is still AT base, its fields are the
  // "before" of this edit. If it isn't, the guarded UPDATE matches nothing anyway.
  const change = diff(flatten(event), flatten(fields));

  try {
    await storage.batch([
      ...fieldEditStatements({
        eventId: event.id,
        expected: base,
        fields,
        change,
        actorId: me,
        now: input.now,
        gate: {
          sql: `status = 'scheduled' AND ${stillEditor.sql} AND EXISTS (SELECT 1 FROM
                  event_change_proposal WHERE id = ? AND status = 'pending')`,
          params: [...stillEditor.params, input.proposalId],
        },
        afterLog: [
          {
            sql: `UPDATE event_change_proposal SET status = 'accepted', decided_by = ?, decided_at = ?
                  WHERE id = ? AND status = 'pending' AND changes() = 1`,
            params: [me, input.now, input.proposalId],
          },
        ],
      }),
      {
        sql: `UPDATE event_change_proposal SET status = 'superseded', decided_at = ?
              WHERE id = ? AND status = 'pending'
                AND base_revision <> (SELECT revision FROM canonical_event WHERE id = ?)`,
        params: [input.now, input.proposalId, event.id],
      },
    ]);
  } catch {
    // UNIQUE(event, revision): a rival committed revision base+1 in between — which
    // means the event moved on. The next attempt sees it as superseded.
    return { kind: "closed" };
  }

  const after = await storage.query({
    sql: "SELECT status FROM event_change_proposal WHERE id = ?",
    params: [input.proposalId],
  });
  const status = proposalStatusSchema.parse(after[0]?.status);
  if (status === "accepted") return { kind: "accepted" };
  if (status === "superseded") return { kind: "superseded" };
  return status === "pending" ? { kind: "forbidden" } : { kind: "closed" };
}

/** The proposer takes back their pending proposal. */
export async function withdrawChange(
  storage: StoragePort,
  access: EventAccess,
  input: { readonly proposalId: string; readonly now: string },
): Promise<{ readonly kind: "withdrawn" } | { readonly kind: "closed" }> {
  const me = access.participation.personId;
  const done = await storage.query({
    sql: `UPDATE event_change_proposal SET status = 'withdrawn', decided_by = ?, decided_at = ?
          WHERE id = ? AND canonical_event_id = ? AND proposed_by = ? AND status = 'pending'
          RETURNING id`,
    params: [me, input.now, input.proposalId, access.event.id, me],
  });
  return done.length === 1 ? { kind: "withdrawn" } : { kind: "closed" };
}

export interface ProposalsView {
  /** For editors: every proposal that can still be accepted, oldest first. */
  readonly pending: readonly ChangeProposal[];
  /** The viewer's own latest proposal, whatever became of it. */
  readonly mine: ChangeProposal | null;
}

/**
 * What a person with proven access sees of proposals. Editors see what awaits a
 * decision; a proposer sees their own, so a rejection or a supersede is never silent.
 * Other people see none: a proposal is not the event (WORKFLOWS §5), and its fields are
 * still filtered per tier by the page, exactly like history.
 */
export async function listProposals(
  storage: StoragePort,
  access: EventAccess,
): Promise<ProposalsView> {
  const { event, participation } = access;
  const pending =
    participation.editTier === "edit"
      ? (
          await storage.query({
            sql: `SELECT ${PROPOSAL_COLUMNS} FROM ${PROPOSAL_FROM}
                  WHERE ecp.canonical_event_id = ? AND ecp.status = 'pending'
                    AND ecp.base_revision = ?
                  ORDER BY ecp.created_at, ecp.id`,
            params: [event.id, event.revision],
          })
        ).map((row) => toProposal(row, access))
      : [];
  const own = await storage.query({
    sql: `SELECT ${PROPOSAL_COLUMNS} FROM ${PROPOSAL_FROM}
          WHERE ecp.canonical_event_id = ? AND ecp.proposed_by = ?
          ORDER BY ecp.created_at DESC, ecp.id DESC LIMIT 1`,
    params: [event.id, participation.personId],
  });
  return { pending, mine: own[0] === undefined ? null : toProposal(own[0], access) };
}
