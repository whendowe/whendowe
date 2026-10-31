// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// DESIGN.md §10, transcribed. One SQLite dialect, two homes (D1 + SQLite file).
// Conventions: text PKs holding UUIDv7 generated in app code; enums as text + CHECK;
// time columns ISO-8601 text (instants UTC with Z; RFC 5545 wall-clock fields zone-less);
// JSON in text columns; booleans integer 0/1; created_at/updated_at set by app code.
// Note: §10 writes change_log.id as `bigserial` (a Postgres-ism); the SQLite-dialect
// rendering is INTEGER PRIMARY KEY AUTOINCREMENT — flagged for a design-deviation PR.

export const calendarConnection = sqliteTable(
  "calendar_connection",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    provider: text("provider").notNull().default("google"),
    accountEmail: text("account_email").notNull(),
    calendarId: text("calendar_id").notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    tokenExpiry: text("token_expiry"),
    syncToken: text("sync_token"),
    watchChannel: text("watch_channel"),
    // auth_error: revoked/expired grant (§12); worker skips its projections until reconnected.
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    // One connection per target calendar; a duplicate would double-mirror every event.
    unique("calendar_connection_target_uq").on(t.ownerId, t.provider, t.calendarId),
    check(
      "calendar_connection_status_chk",
      sql`${t.status} IN ('active', 'auth_error', 'disconnected')`,
    ),
  ],
);

export const canonicalEvent = sqliteTable(
  "canonical_event",
  {
    id: text("id").primaryKey(),
    revision: integer("revision").notNull().default(1),
    origin: text("origin").notNull(),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    // RFC 5545-native time model: wall-clock + TZID is AUTHORITATIVE;
    // UTC instants are derived, never stored as truth.
    startLocal: text("start_local").notNull(),
    endLocal: text("end_local").notNull(),
    tzid: text("tzid"), // IANA TZID; NULL only when all_day
    allDay: integer("all_day").notNull().default(0),
    rrule: text("rrule"), // verbatim RFC 5545 RRULE (validated subset at the zod boundary)
    exdates: text("exdates").notNull().default("[]"), // MVP: stays empty (seam)
    // The lifecycle, WORKFLOWS §5 verbatim (DESIGN §10 rc11). One column, one CHECK:
    // impossible pairs are unrepresentable. M0's 'active' became 'scheduled'.
    status: text("status").notNull().default("scheduled"),
    // The group the event was made for, if any: for LISTING a group's events. Access
    // is never derived from it — you see an event because you participate in it.
    groupId: text("group_id").references(() => personGroup.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // rc21: purged this many days after it is past (§10 *Retention*); copied from its group.
    retainDays: integer("retain_days").notNull().default(365),
  },
  (t) => [
    index("canonical_event_group_idx").on(t.groupId),
    check(
      "canonical_event_origin_chk",
      sql`${t.origin} IN ('user_edit', 'imported_from_calendar')`,
    ),
    check(
      "canonical_event_status_chk",
      sql`${t.status} IN ('draft', 'proposed', 'scheduled', 'declined', 'withdrawn', 'cancelled')`,
    ),
    check("canonical_event_all_day_chk", sql`${t.allDay} IN (0, 1)`),
  ],
);

// RFC 5545 override components (RECURRENCE-ID). MVP: table EXISTS but stays EMPTY
// (seam, §5/§16) — no code path writes it yet. Phase 3 fills it; schema never moves.
export const eventOverride = sqliteTable(
  "event_override",
  {
    id: text("id").primaryKey(),
    canonicalEventId: text("canonical_event_id")
      .notNull()
      .references(() => canonicalEvent.id, { onDelete: "cascade" }),
    recurrenceId: text("recurrence_id").notNull(), // original occurrence DTSTART, wall-clock in parent tzid
    fieldOverrides: text("field_overrides").notNull(), // sparse {field: value}
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique("event_override_occurrence_uq").on(t.canonicalEventId, t.recurrenceId)],
);

export const projection = sqliteTable(
  "projection",
  {
    id: text("id").primaryKey(),
    canonicalEventId: text("canonical_event_id")
      .notNull()
      .references(() => canonicalEvent.id, { onDelete: "cascade" }),
    calendarConnectionId: text("calendar_connection_id")
      .notNull()
      .references(() => calendarConnection.id, { onDelete: "cascade" }),
    visibilityProfile: text("visibility_profile").notNull().default("FULL"),
    providerEventId: text("provider_event_id"), // null until first create
    providerEtag: text("provider_etag"),
    lastPushedHash: text("last_pushed_hash"), // hash of the FILTERED fieldset we last pushed
    recentWriteNonces: text("recent_write_nonces").notNull().default("[]"), // ring of last ~5 (§11)
    baseRevision: integer("base_revision"), // canonical revision last synced to this mirror
    state: text("state").notNull().default("pending_create"),
    lastError: text("last_error"),
    retryAt: text("retry_at"), // next retry for 'error' rows (capped backoff, §12)
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("projection_target_uq").on(t.canonicalEventId, t.calendarConnectionId),
    index("projection_state_idx").on(t.state), // worker scans by state
    index("projection_event_idx").on(t.canonicalEventId),
    check(
      "projection_state_chk",
      sql`${t.state} IN ('pending_create', 'synced', 'pending_update', 'pending_delete', 'deleted', 'error')`,
    ),
  ],
);

// Append-only; the UNIQUE (event, revision) makes the log a true serialization of history.
export const changeLog = sqliteTable(
  "change_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    canonicalEventId: text("canonical_event_id")
      .notNull()
      .references(() => canonicalEvent.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    actor: text("actor").notNull(), // connection id / user id / 'system'
    source: text("source").notNull(), // 'ui' | 'inbound_sync'
    diff: text("diff").notNull(), // {field: {before, after}}
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("change_log_revision_uq").on(t.canonicalEventId, t.revision),
    index("change_log_event_idx").on(t.canonicalEventId, t.revision),
    check("change_log_source_chk", sql`${t.source} IN ('ui', 'inbound_sync')`),
  ],
);

// --- People & login (MVP-1, DESIGN §10 rc7 sketch) ---------------------------------
// calendar_connection.owner_id will reference person.id; it gains no FK here because
// SQLite cannot add a constraint to an existing table without a rebuild, and §16's
// expand/contract rule forbids a destructive migration for it. The app enforces it.

export const person = sqliteTable("person", {
  id: text("id").primaryKey(),
  // Normalised (trimmed, lowercased) and verified: the identity key across login
  // methods, so a later "Sign in with Google" with the same address lands here.
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  createdAt: text("created_at").notNull(),
  // rc21: set on a TOMBSTONE — "a former member", standing in for an erased person in
  // one event, group or thread's history. Its address is '<id>@erased.invalid' (RFC 6761:
  // can never receive mail or sign in).
  erasedAt: text("erased_at"),
});

export const loginToken = sqliteTable(
  "login_token",
  {
    id: text("id").primaryKey(),
    // SHA-256 of the emailed token; the token itself is never stored (§13).
    tokenHash: text("token_hash").notNull().unique(),
    // Keyed on email, not person: the first login creates the person.
    email: text("email").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    // Rate limiting counts recent tokens per address.
    index("login_token_email_idx").on(t.email, t.createdAt),
  ],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    // SHA-256 of the cookie value; the cookie value itself is never stored (§13).
    tokenHash: text("token_hash").notNull().unique(),
    personId: text("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("session_person_idx").on(t.personId)],
);

// --- Outbound mail cap (DESIGN §13 rc9) -------------------------------------------
// One row per RESERVED send slot (src/mail/capped.ts). Deliberately no recipient,
// subject, or purpose: a counter needs none of it, and this table would otherwise be
// a log of who was emailed when — personal data with no reason to exist.
export const mailSend = sqliteTable(
  "mail_send",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(), // YYYY-MM-DD, UTC
    month: text("month").notNull(), // YYYY-MM, UTC
    createdAt: text("created_at").notNull(),
    // rc21: 1 for mail that nobody signed in caused — a sign-in link. Those draw on a
    // smaller share of the daily cap of their own (DESIGN §13), so a script asking for
    // links to many addresses can't stop invites and answer links for the day.
    anonymous: integer("anonymous").notNull().default(0),
  },
  (t) => [index("mail_send_day_idx").on(t.day), index("mail_send_month_idx").on(t.month)],
);

// --- Groups (MVP-1 slice D, DESIGN §10 rc7 sketch, refined) -------------------------
// Refinement over the sketch: group_member gains `role`. The sketch could not say who
// may invite people or change the group; `organizer` can, `member` cannot.

export const personGroup = sqliteTable("person_group", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => person.id),
  createdAt: text("created_at").notNull(),
  // rc21: how long its events are kept once past (§10 *Retention*); events copy it.
  retainDays: integer("retain_days").notNull().default(365),
});

export const groupMember = sqliteTable(
  "group_member",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => personGroup.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    // Copied onto new events for this group (MVP-2); editable per event.
    defaultEditTier: text("default_edit_tier").notNull().default("view"),
    defaultVisibility: text("default_visibility").notNull().default("FULL"),
    joinedAt: text("joined_at").notNull(),
    // rc21 (DESIGN §10 *Privacy basics*): how this person appears here. NULL handle =
    // their account's handle; their address is shown to the others only if show_email = 1.
    handle: text("handle"),
    showEmail: integer("show_email").notNull().default(0),
  },
  (t) => [
    unique("group_member_uq").on(t.groupId, t.personId),
    index("group_member_person_idx").on(t.personId),
    check("group_member_role_chk", sql`${t.role} IN ('organizer', 'member')`),
    check("group_member_edit_tier_chk", sql`${t.defaultEditTier} IN ('edit', 'propose', 'view')`),
    check(
      "group_member_visibility_chk",
      sql`${t.defaultVisibility} IN ('FULL', 'DETAILS', 'BUSY', 'HIDDEN')`,
    ),
  ],
);

// --- Group invites (MVP-1 slice D2) ----------------------------------------------
// An invite is ALSO a sign-in: the link was sent to that address, so following it
// proves ownership exactly as a magic link does. Token stored as a hash only (§13).
export const groupInvite = sqliteTable(
  "group_invite",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => personGroup.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    editTier: text("edit_tier").notNull(),
    visibility: text("visibility").notNull(),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("group_invite_group_idx").on(t.groupId, t.createdAt),
    check("group_invite_edit_tier_chk", sql`${t.editTier} IN ('edit', 'propose', 'view')`),
    check(
      "group_invite_visibility_chk",
      sql`${t.visibility} IN ('FULL', 'DETAILS', 'BUSY', 'HIDDEN')`,
    ),
  ],
);

// --- Event participation (MVP-2, DESIGN §10 rc7 sketch) ----------------------------
// The input desired() was always missing: who takes part in an event, what they may
// CHANGE (edit tier) and what they SEE (visibility) — two independent axes.
export const eventParticipation = sqliteTable(
  "event_participation",
  {
    canonicalEventId: text("canonical_event_id")
      .notNull()
      .references(() => canonicalEvent.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    editTier: text("edit_tier").notNull(),
    visibility: text("visibility").notNull(),
    // none | ack | accept | slot_vote — set by the organizer; filled in MVP-2 slice 2D.
    responseKind: text("response_kind").notNull().default("none"),
    responseState: text("response_state"),
    // going | maybe | not_going — any tier may state it (WORKFLOWS §3 rc7).
    attendance: text("attendance"),
    createdAt: text("created_at").notNull(),
    // When attendance was last stated (DESIGN §10 rc12: responses carry their own time).
    respondedAt: text("responded_at"),
    // When response_state last changed — "seen ✓ 14:02" (DESIGN §10 rc13, US-4).
    responseStateAt: text("response_state_at"),
    // rc21 (DESIGN §10 *Privacy basics*): how this person appears here. NULL handle =
    // their account's handle; their address is shown to the others only if show_email = 1.
    handle: text("handle"),
    showEmail: integer("show_email").notNull().default(0),
  },
  (t) => [
    unique("event_participation_uq").on(t.canonicalEventId, t.personId),
    index("event_participation_person_idx").on(t.personId),
    check("event_participation_edit_tier_chk", sql`${t.editTier} IN ('edit', 'propose', 'view')`),
    check(
      "event_participation_visibility_chk",
      sql`${t.visibility} IN ('FULL', 'DETAILS', 'BUSY', 'HIDDEN')`,
    ),
    check(
      "event_participation_response_kind_chk",
      sql`${t.responseKind} IN ('none', 'ack', 'accept', 'slot_vote')`,
    ),
    check(
      "event_participation_attendance_chk",
      sql`${t.attendance} IS NULL OR ${t.attendance} IN ('going', 'maybe', 'not_going')`,
    ),
  ],
);

// --- Time polls (MVP-2 slice 2C; WORKFLOWS §9 delta 3, US-13) -----------------------
// A `proposed` event carries candidate times; each participant answers per candidate.
// Candidates share the event's all_day/tzid (one poll, one kind of time) — stored per
// row anyway so confirm copies a self-contained time, exactly the event's shape.
export const eventCandidate = sqliteTable(
  "event_candidate",
  {
    canonicalEventId: text("canonical_event_id")
      .notNull()
      .references(() => canonicalEvent.id, { onDelete: "cascade" }),
    slotIndex: integer("slot_index").notNull(),
    allDay: integer("all_day").notNull(),
    startLocal: text("start_local").notNull(),
    endLocal: text("end_local").notNull(),
    tzid: text("tzid"),
  },
  (t) => [
    primaryKey({ name: "event_candidate_pk", columns: [t.canonicalEventId, t.slotIndex] }),
    check("event_candidate_slot_chk", sql`${t.slotIndex} >= 0`),
  ],
);

export const slotResponse = sqliteTable(
  "slot_response",
  {
    canonicalEventId: text("canonical_event_id").notNull(),
    slotIndex: integer("slot_index").notNull(),
    personId: text("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    answer: text("answer").notNull(),
    respondedAt: text("responded_at").notNull(),
  },
  (t) => [
    primaryKey({
      name: "slot_response_pk",
      columns: [t.canonicalEventId, t.slotIndex, t.personId],
    }),
    // A vote can only be for a candidate that exists; deleting the event cascades.
    foreignKey({
      name: "slot_response_candidate_fk",
      columns: [t.canonicalEventId, t.slotIndex],
      foreignColumns: [eventCandidate.canonicalEventId, eventCandidate.slotIndex],
    }).onDelete("cascade"),
    index("slot_response_person_idx").on(t.personId),
    check("slot_response_answer_chk", sql`${t.answer} IN ('yes', 'ifneedbe', 'no')`),
  ],
);

// --- Responses (MVP-2 slice 2D, DESIGN §10 rc12) -------------------------------------
// Feedback: append-only notes ("might be late"), attributed. Not change_log rows —
// those are keyed by revision and would turn every note into an edit conflict.
export const eventFeedback = sqliteTable(
  "event_feedback",
  {
    id: text("id").primaryKey(),
    canonicalEventId: text("canonical_event_id")
      .notNull()
      .references(() => canonicalEvent.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("event_feedback_event_idx").on(t.canonicalEventId, t.createdAt)],
);

// The account-less surface (DESIGN §13 token links): one action × one event × one
// person. Only the hash is stored; issuing again replaces the row (rotate on resend).
export const responseToken = sqliteTable(
  "response_token",
  {
    tokenHash: text("token_hash").primaryKey(),
    canonicalEventId: text("canonical_event_id")
      .notNull()
      .references(() => canonicalEvent.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("response_token_scope_uq").on(t.canonicalEventId, t.personId, t.action),
    index("response_token_person_idx").on(t.personId),
    check("response_token_action_chk", sql`${t.action} IN ('vote', 'attend')`),
  ],
);

// The propose tier (DESIGN §10 rc13, MVP-2 slice 2E-2): an edit that waits for an `edit`
// participant to accept or reject it. `fields` is the full proposed field set; accepting
// applies it only at `base_revision`, so an accepted proposal is always revision
// base_revision + 1 — the join that names the proposer in history.
export const eventChangeProposal = sqliteTable(
  "event_change_proposal",
  {
    id: text("id").primaryKey(),
    canonicalEventId: text("canonical_event_id")
      .notNull()
      .references(() => canonicalEvent.id, { onDelete: "cascade" }),
    proposedBy: text("proposed_by")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    baseRevision: integer("base_revision").notNull(),
    fields: text("fields").notNull(),
    status: text("status").notNull(),
    decidedBy: text("decided_by").references(() => person.id, { onDelete: "set null" }),
    decidedAt: text("decided_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("event_change_proposal_event_idx").on(t.canonicalEventId, t.status),
    check(
      "event_change_proposal_status_chk",
      sql`${t.status} IN ('pending', 'accepted', 'rejected', 'withdrawn', 'superseded')`,
    ),
  ],
);

// Who was added to or removed from an event, by whom (DESIGN rc15, slice 2F). Not a
// revision: a change_log row would bump the revision and turn a concurrent field edit
// into a conflict. Append-only; shown in the event's one attributed trail.
export const eventParticipantChange = sqliteTable(
  "event_participant_change",
  {
    id: text("id").primaryKey(),
    canonicalEventId: text("canonical_event_id")
      .notNull()
      .references(() => canonicalEvent.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("event_participant_change_event_idx").on(t.canonicalEventId, t.createdAt),
    check("event_participant_change_action_chk", sql`${t.action} IN ('added', 'removed')`),
  ],
);

// --- Plans (DESIGN §10 rc19, slice P1) ------------------------------------------------
// Several events proposed, compared and accepted as one. People plan in a thread with
// members and an organizer; a plan answers another plan (answers_id) and belongs to the
// question its chain of answers started (question_id). Accepting writes each plan event
// as a scheduled canonical_event and records the link in plan_event.canonical_event_id.
export const planThread = sqliteTable("plan_thread", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  organizerId: text("organizer_id")
    .notNull()
    .references(() => person.id, { onDelete: "cascade" }),
  tzid: text("tzid").notNull(),
  createdAt: text("created_at").notNull(),
});

export const planThreadMember = sqliteTable(
  "plan_thread_member",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => planThread.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    // rc21 (DESIGN §10 *Privacy basics*): how this person appears here. NULL handle =
    // their account's handle; their address is shown to the others only if show_email = 1.
    handle: text("handle"),
    showEmail: integer("show_email").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.personId] }),
    index("plan_thread_member_person_idx").on(t.personId),
  ],
);

export const plan = sqliteTable(
  "plan",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => planThread.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    message: text("message"),
    answersId: text("answers_id").references((): AnySQLiteColumn => plan.id),
    restOf: integer("rest_of").notNull().default(0),
    questionId: text("question_id").notNull(),
    status: text("status").notNull(),
    replacedBy: text("replaced_by").references((): AnySQLiteColumn => plan.id),
    decidedBy: text("decided_by").references(() => person.id, { onDelete: "set null" }),
    decisionId: text("decision_id"),
    sentAt: text("sent_at"),
    decidedAt: text("decided_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("plan_thread_idx").on(t.threadId, t.status),
    // At most one draft per author per thread: "Your draft" is a single thing.
    uniqueIndex("plan_one_draft_uq").on(t.threadId, t.authorId).where(sql`${t.status} = 'draft'`),
    check(
      "plan_status_chk",
      sql`${t.status} IN ('draft', 'on_table', 'accepted', 'replaced', 'withdrawn')`,
    ),
    check("plan_rest_of_chk", sql`${t.restOf} IN (0, 1)`),
  ],
);

export const planEvent = sqliteTable(
  "plan_event",
  {
    // Cascade only ever fires for a discarded draft: a sent plan is never deleted.
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "cascade" }),
    sid: text("sid").notNull(),
    title: text("title").notNull(),
    allDay: integer("all_day").notNull(),
    startLocal: text("start_local").notNull(),
    endLocal: text("end_local").notNull(),
    who: text("who").notNull().default("[]"),
    canonicalEventId: text("canonical_event_id").references(() => canonicalEvent.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.sid] }),
    index("plan_event_canonical_idx").on(t.canonicalEventId),
    check("plan_event_all_day_chk", sql`${t.allDay} IN (0, 1)`),
  ],
);

export const planVote = sqliteTable(
  "plan_vote",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    answer: text("answer").notNull(),
    respondedAt: text("responded_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.personId] }),
    check("plan_vote_answer_chk", sql`${t.answer} IN ('yes', 'ifneedbe', 'no')`),
  ],
);

// Notes on days (slice P5): need no agreement, only attribution; private = author only.
export const planNote = sqliteTable(
  "plan_note",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => planThread.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    firstDay: text("first_day").notNull(),
    lastDay: text("last_day").notNull(),
    body: text("body").notNull(),
    private: integer("private").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("plan_note_thread_idx").on(t.threadId, t.firstDay),
    check("plan_note_private_chk", sql`${t.private} IN (0, 1)`),
  ],
);

export type CalendarConnectionRow = typeof calendarConnection.$inferSelect;
export type CanonicalEventRow = typeof canonicalEvent.$inferSelect;
export type EventOverrideRow = typeof eventOverride.$inferSelect;
export type ProjectionRow = typeof projection.$inferSelect;
export type ChangeLogRow = typeof changeLog.$inferSelect;
export type PersonRow = typeof person.$inferSelect;
export type LoginTokenRow = typeof loginToken.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type EventParticipationRow = typeof eventParticipation.$inferSelect;

// --- Privacy basics (DESIGN §10 rc21) -------------------------------------------------
// What the purge pipeline removed, by id only — never an address or any content — kept
// for the backup window (35 days) so a restore can re-apply it before serving again.

export const erasureLedger = sqliteTable(
  "erasure_ledger",
  {
    kind: text("kind").notNull(), // person | event | group | thread
    id: text("id").notNull(),
    erasedAt: text("erased_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.id] }),
    check("erasure_ledger_kind_chk", sql`${t.kind} IN ('person', 'event', 'group', 'thread')`),
  ],
);

// rc22: an account whose deletion was asked for, waiting 7 days. The emailed link (its
// hash here) keeps the account or deletes it at once; the cron's purge pass deletes it
// at erase_after. The row goes with the person.
export const accountDeletion = sqliteTable(
  "account_deletion",
  {
    personId: text("person_id")
      .primaryKey()
      .references(() => person.id, { onDelete: "cascade" }),
    requestedAt: text("requested_at").notNull(),
    eraseAfter: text("erase_after").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
  },
  (t) => [index("account_deletion_due_idx").on(t.eraseAfter)],
);
