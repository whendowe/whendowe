# WhenDoWe — User Workflows & Stories

> **Status:** v0.8 (US-19–US-20 and a US-12 amendment: handles instead of addresses, leaving and deleting, an account that goes leaves "a former member" behind; owner decisions 2026-10-31, folded into DESIGN rc21 §10 *Privacy basics*) (v0.7: §3 *Plan* and US-16–US-18: several events proposed, compared and accepted as one; owner decisions from the plans prototype, 2026-10-25…30; folded into DESIGN rc19 §10 *Plans*) (v0.6: renamed to WhenDoWe) (v0.5 + delta 10 aligned to the DESIGN §6 intersection contract: HTTPS mail port, no SMTP). Companion to `DESIGN.md`.
> **Audience:** the owner (product decisions) and the coding agent (what M3+ must actually do for people).
> **Relationship to DESIGN.md:** DESIGN.md defines the sync core (canonical truth, projections, reconcile). This document defines *who* uses it, *what they're trying to do*, and which design seams each story lands on. §9 lists the schema/scope deltas these stories imply, to be folded back into DESIGN.md once accepted.

---

## 1. Personas & the anchor household

The anchor scenario is a **shared-custody household triangle**:

- **Mara (mom).** Organizes the kids' life during her custody time. Needs: propose schedule changes to David, know he saw them, keep her personal notes private.
- **David (dad).** Same needs, mirrored. Additionally coordinates his own household with Petra.
- **Petra (dad's partner).** Day-to-day involved in David's household; helps with pickups. Needs: see what's happening — but Mara and David control *how much* she sees, per event. Conversely, when David & Petra plan something, Mara may be the reduced-visibility viewer.
- **Kids.** Not users. They appear in event content, never as accounts.
- **Secondary persona — Grandparents (Mara's parents).** Occasionally babysit. Only ever need busy/free: "is that weekend a Mara-weekend or a David-weekend?"

**Second anchor group (rc7) — the D&D table.** Five friends and a DM who play roughly fortnightly. No custody, no trust asymmetry — the question is literally the product's name: *when do we (play)?* The DM proposes candidate dates, players vote, the DM confirms; sessions then live in each player's own calendar, whichever app that is. Players should be able to see everything and say "I'm in / maybe / out" and "Thursday's bad for me" — but a stray drag in someone's own calendar must not reschedule the table. This group exists to keep the MVP honest about people who will never connect a calendar, and about groups that aren't households.

Each adult connects their own Google calendar (a `CalendarConnection`); the kids' schedule exists **once** as canonical events and is projected into each adult's calendar, shaped per person.

**The trust asymmetry is half the product; consensus-seeking is the other half.** A normal shared Google calendar gives everyone everything and records nobody's agreement. This household needs *graded* sharing (full collaboration between co-parents, configurable involvement for a partner, free/busy for grandparents — per event) **and** a record of consent: who proposed, who agreed, who has seen it. The calendar is the interface; the product is **agreed-upon truth**. Accept, acknowledge, and slot-voting (§US-13) are three grades of one primitive: a recorded response to a proposed fact.

---

## 2. North star (vision constraint — explicitly NOT MVP scope)

The fragmented space — Doodle, Calendly, shared Google calendars, Facebook events, club newsletters, WhatsApp coordination groups — is one problem wearing six costumes: **a group converging on, committing to, and staying truthfully informed about shared events.** Every product above is a point in a three-dial space this architecture already spans:

| Dial | Range |
|---|---|
| **Audience** — who sees it | household → roster (club, class, team) → public page |
| **Time authority** — who fixes when | organizer fixes · group votes + organizer confirms · invitee picks from published availability (auto-confirm, capacity) |
| **Response sought** | none · acknowledge · accept · vote · RSVP · book |

Doodle = (closed, vote+confirm, vote). Calendly = (semi-open, availability + auto-confirm, book — the only point needing a genuinely new mechanism: availability-derived candidates). Facebook event = (broad, fixed, RSVP). Shared calendar = (standing, fixed, none). A newsletter isn't even a new dial — it's another *projection target* (a periodic digest of scheduled events for an audience), exactly the polymorphic-target seam in DESIGN §5. And the "old-school social network" is what appears when the audience dial widens over real relationships: the content is **commitments, not posts** — no feed, no engagement optimization, no ads; attribution and consent are the product. (AGPL + self-hostability, DESIGN §7, are part of this stance, not just a license choice.)

**One hard architectural rule the vision imposes NOW: responding never requires an account.** Each end of this spectrum grows only because incumbents are frictionless for responders — a Doodle vote or Calendly booking needs no signup. Therefore: every response (acknowledge / accept / vote / RSVP) must be deliverable via a tokenized link; a `person` exists independently of any calendar connection (created lazily from an email address); connecting a calendar is an *upgrade* ("want this in your calendar?"), never the entry fee. Cheap to honor from M3, prohibitive to retrofit.

**Expansion rings — the architecture spans, the roadmap refuses:**
- **Ring 0 (MVP):** small groups of people who know each other — the household *and* ad-hoc friend groups like the D&D table (rc7: widened from "the household"). Includes attendance intent (going / maybe / not going), read-only ICS feeds, and views shared unlisted-by-link or with specific people by email. Everything in this document.
- **Ring 1:** rosters — clubs, classes, teams: capacity-limited RSVP, organizer teams, digest emails, org tenancy. Only after Ring 0 is genuinely loved.
- **Ring 2:** public — event pages, open feeds, availability booking, discovery. Only after Ring 1 earns it.

No MVP code may *target* Ring 1–2; no MVP shape may *preclude* them. (Naming: resolved — **WhenDoWe** states the product's question; see DESIGN §17.)

---

## 3. Concepts the stories introduce (beyond DESIGN.md)

- **Person** — a human identity in the system. Owns one or more calendar connections. (DESIGN.md has `owner_id` but no person model; the stories force one.)
- **Group (rc7; rc15)** — a reusable set of people with per-member default tiers: a household, a D&D table. Since DESIGN rc15 a group is an *address book*, not a container: an event names its people directly, and "add the people from this group" copies the members and their defaults onto the event, editable per event. Joining a group later does not add you to its earlier events; an editor adds you to the events you should be on.
- **Edit tier (rc7)** — what a person may *change*, per event. Replaces the old organizer/participant/viewer roles, which conflated changing with seeing:
  - **`edit`** — changes apply directly (UI or, with two-way sync, their own calendar). The organizer has it; others can be granted it.
  - **`propose`** — changes become proposals the group accepts (§5). The "other co-parent" default.
  - **`view`** — cannot change the event. An "organizer decides by fiat" event is simply one where everyone else is `view`.
  An edit made in a person's own synced calendar follows their tier: applied, turned into a proposal, or reverted *with a notice* (US-15). Never a silent revert.
- **Every tier can respond.** Acknowledge, state **attendance** (going / maybe / not going), and leave **feedback** (a short note on the event, in the change log). "The organizer decides" never means "participants have no voice".
- **Visibility tier** — what a person's projection contains, **independent of edit tier** (a D&D player is `view` + `FULL`). The concrete MVP set (this instantiates DESIGN.md's `VisibilityProfile` seam):
  | Tier | title | time | location | description | notes/attachments | participant list |
  |---|---|---|---|---|---|---|
  | `FULL` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
  | `DETAILS` | ✓ | ✓ | ✓ | — | — | — |
  | `BUSY` | placeholder label (configurable, e.g. "Kids — scheduled") | ✓ | — | — | — | — |
  | `HIDDEN` | (no projection at all) | | | | | |
- **Response (the core primitive)** — per (event, person), a recorded answer to a proposed fact. Three grades, chosen by the organizer:
  - **accept required** — consent. The event isn't *scheduled* until accepted (custody changes).
  - **acknowledge requested** — FYI, but "seen" matters (dentist appointment in the other parent's time).
  - **slot vote** — the proposal carries *multiple candidate times*; each responder answers per slot (`yes | if-need-be | no`); confirming one slot schedules it (US-13).
  - **none** — pure information.
  All three are the same shape — actor + answer + timestamp, appended to the change log — which is why acknowledgments, consent, and Doodle-style polls share one mechanism, one UI list, and one attribution trail.
- **Plan (rc19)** — several events proposed **as one**: "the weeks until Christmas", "four sessions to take us to the holidays", "how Christmas goes". People put plans *on the table*, vote on them (yes / if need be / no), and answer a plan with one of their own ("Suggest changes…") instead of editing someone else's. A plan is accepted **as a whole** — never event by event; whoever dislikes part of it suggests changes. Two people decide by consensus (it is accepted when both say yes); in a larger group the organizer decides, after the votes are in. Accepting a plan replaces the plans that were alternatives to it, and its events become ordinary scheduled events for everyone planning. Each event in a plan can say **who it is for** (one person, several, or everyone). Undecided time is shown as nothing at all: a calendar holds what is agreed, never what is merely on the table. A poll is the smallest case: several one-event plans on the table at once (DESIGN rc19).
- **Event lifecycle** — `draft → proposed → scheduled → cancelled` (extends DESIGN.md's `active|cancelled`). Crucially, the lifecycle lives **entirely in canonical + the desired-state policy**: a `proposed` event projects only to the proposer and the approver (as tentative); acceptance flips it to `scheduled`, and reconcile fans it out. The sync machinery doesn't know proposals exist.

---

## 4. User stories

Format: narrative → who sees what → acceptance criteria → design mapping & phase.

### US-1 — Onboard the household
David signs up, connects his Google account, picks his target calendar. He invites Mara and Petra by email; each connects their own Google account and picks their own target calendar.
**Sees:** each person, only their own connection state.
**Done when:** three persons exist, three active connections, no events yet.
**Maps to:** `person` model (new, §9), `calendar_connection` (exists), M1 OAuth + M3 invite UI.

### US-2 — The standing custody rhythm
David creates the recurring backbone: "Kids with David", Fri 17:00 → Mon 08:00, every other week. Mara is **participant/FULL** with **accept required** (it defines her weekends too). Petra is **viewer/DETAILS**. Grandparents: **viewer/BUSY**.
**Sees:** David & Mara full series; Petra title/time/location; grandparents a "Kids — scheduled" block.
**Done when:** after Mara accepts, the series appears in all four calendars, each shaped per tier, and re-running sync changes nothing (idempotency).
**Maps to:** RFC 5545 recurrence (DESIGN §10), `project(event, profile)` with `DETAILS`/`BUSY`, proposal lifecycle. Phase: M3.

### US-3 — Propose a schedule change (consent)
Mara has a work trip and proposes: kids stay with David an extra night next month. She creates the event with David as **accept required**. Until he responds, it's `proposed`: visible to both of them (tentative in their calendars), invisible to Petra and the grandparents — viewers see only *scheduled* reality.
David **accepts** → `scheduled`, fans out to everyone per tier; the change log records proposer and acceptor. David **declines** → it never projects beyond the two of them; Mara sees the attributed decline. Mara can **withdraw** before response.
**Done when:** no viewer ever saw a non-scheduled event; acceptance/decline is attributed; declined/withdrawn proposals leave no calendar residue.
**Maps to:** lifecycle in `desired()` (DESIGN §10 deletion model generalizes: *desired-state policy decides existence per person*), `change_log` facts. Phase: M3.

### US-4 — FYI with acknowledgment
Mara books a dentist appointment during *her* time. No consent needed, but David should know. She sets David **acknowledge requested**, Petra `HIDDEN`. The event schedules immediately (no gate); David's calendar shows it, and the WhenDoWe UI shows it in his "needs acknowledgment" list until he taps acknowledge — recorded with timestamp.
**Done when:** event syncs without waiting; acknowledgment state is visible to Mara ("seen ✓"); nothing requires David to act for the event to exist.
**Maps to:** response state on participation rows; pure UI + change_log, zero sync changes. Phase: M3.

### US-5 — Dad & partner plan, mom as limited viewer
David and Petra plan a weekend trip with the kids (David's custody time). Petra is **organizer-grade** in David's household, so David grants her **organizer** on this event. Mara is **viewer/DETAILS**: she sees "Trip to the coast, Fri–Sun, Ostsee" — dates and where the kids are — but not the lodging details, cost notes, or who else is coming.
**Done when:** Mara's mirror contains exactly the DETAILS fieldset (verify: the DESIGN §9 *visibility integrity* property); Petra can edit and her edits propagate with attribution.
**Maps to:** per-event roles independent of "whose household"; `project()` filtering; push-hash over the *filtered* fieldset (DESIGN §16 — this story is why that constraint exists). Phase: M3.

### US-6 — Private notes never leak
On the custody series, Mara keeps a note: "J. is anxious about handoffs, keep them short." That's in description/notes — `FULL` tier only. Petra (DETAILS) and grandparents (BUSY) must never receive it, in any sync, ever, including after tier downgrades.
**Done when:** property-tested: no projection ever contains a field its tier excludes, including after a tier is *changed* (downgrade triggers a re-push of the reduced fieldset).
**Maps to:** DESIGN §9 visibility-integrity property becomes non-trivial; tier change = projection content change → normal reconcile. Phase: M3.

### US-7 — Edits propagate, with attribution and re-acknowledgment
David moves Friday pickup 17:00 → 18:00 on the custody series. All mirrors update. Mara sees in the UI: "David changed start time 17:00 → 18:00, yesterday." Because her participation was accept-required, a **material change** (time/date/location) resets her state to *re-acknowledge* (MVP: the edit applies immediately, last-write-wins, and is flagged for her review — softer than re-gating the whole event, honest about Phase-1 capabilities).
**Done when:** field-level diff visible with actor; material-change flag set; non-material edits (typo in description) don't nag.
**Maps to:** `change_log` (exists), material-change classification = small pure function over the diff. Phase: M3.

### US-8 — Swap a weekend: just more events
"Swap *this* weekend" is modelled as ordinary events, not as machinery: Mara proposes a new single event ("Kids with Mara, <dates>") with David accept-required, optionally a matching one the other way. The recurring series is never touched; the standalone events coexist with it and titles make reality unambiguous. No dedicated swap flow, no per-instance overrides needed for this — the `event_override` seam stays parked for the day instance-level *edits* of a series genuinely matter.
**Done when:** the generic proposal flow (US-3) covers this with zero special-case code.
**Maps to:** nothing new — that's the point. Phase: M3, free.

### US-9 — Cancellation that people actually see
Soccer practice is cancelled. If the mirror just vanishes, Petra drives there anyway because she saw it Tuesday. Policy (from DESIGN §10 deletion model): cancelled events stay projected for a grace period with a "CANCELLED:" title transform, then go Absent. Attribution shows who cancelled.
**Done when:** all tiers see the cancelled rendering (even BUSY flips its placeholder to "Cancelled"); the grace period is one policy constant; restore-on-mistake works (cancel/restore round-trip property).
**Maps to:** deletion-as-interpretation, verbatim. Phase: M3 (this is the first concrete deletion-UX experiment §17 deferred).

### US-10 — Grandparents: busy/free only
Mara's parents connect a calendar and are added as `BUSY` viewers on the custody series only. They see which weekends are "kid weekends" — nothing else, and nothing about events they're not on.
**Done when:** their calendar contains only placeholder blocks; adding them required no per-event work beyond the series (role templates make this one action).
**Maps to:** `BUSY` tier; per-person default-role templates (a convenience, §9). Phase: M3 (templates can slip to M3.5).

### US-11 — Concurrent edit
Mara and David edit the same event within a minute (UI edits, Phase 1). Last-write-wins; **both** edits are in the change log, so nothing is silently lost — the "loser" is visible and re-applicable by hand. (Phase 2 inbound sync inherits the same policy plus the non-overlapping-fields fast-forward, DESIGN §11.)
**Done when:** revision serialization holds (change_log UNIQUE); the UI shows "your edit was superseded by…" rather than nothing.
**Maps to:** optimistic revision bump (DESIGN §11). Phase: M3 surface, M4 inbound.

### US-14 — The D&D table (rc7)
The DM creates a group "Thursday Table" with five players at `view` + `FULL`, invites them by email, and proposes three candidate dates. Players vote via the emailed link — no account, no calendar connection. The DM confirms Saturday. Two players subscribed the group's ICS feed (one on an iPhone), two connected Google, one did neither. Mid-week a player marks "maybe" and leaves feedback "might be late".
**Done when:** nobody needed an account to vote; the confirmed session reaches all three calendar paths; attendance and feedback are visible to the DM with attribution.
**Maps to:** person, group, slot votes (US-13), attendance + feedback (§3), ICS feed, MVP-4 sync. Phase: MVP-1…MVP-3 for everything but the Google path (MVP-4).

### US-15 — An edit made in your own calendar (rc7)
Three people move the same event in their own Google calendars. Petra has `edit`: her change applies and propagates, attributed. Mara has `propose`: her change becomes a proposal to David, her calendar shows the original time until he accepts, and she is emailed "proposed — waiting for David". A D&D player has `view`: their copy reverts, and they're emailed "this change wasn't applied — leave feedback →". Anyone deleting the event from their own calendar only removes it for themselves.
**Done when:** each tier's outcome holds; no revert is silent; every inbound change is in the change log; a delete never touches anyone else's copy.
**Maps to:** DESIGN §11 tier-gated inbound edits, §10 deletion model. Phase: MVP-5.

### US-16 — Weeks with the kid, two months ahead (rc19)
Adam and Mara share Kiddo week about. Today they agree the next couple of months in a messaging app, by retyping dates. Adam puts **"Rest of November"** on the table: five whole-week stretches, each *for* one of them, plus "Scout trip: Adam on standby with the car" over a weekend that is Mara's. Mara opens the link, sees the weeks as rows with each parent in their own colour, swaps the last two weeks by dragging an end across the week boundary (or by tapping an end, then the day it should go to), and sends **her changes to Adam's plan**. Adam sees exactly what she changed — "With Adam moved 23 Nov → 30 Nov", "now for Mara (was Adam)" — not two calendars to compare by eye. He says yes; with two people, both yeses accept it. The weeks are now agreed and appear on both their event lists; his original plan is marked *replaced*.
**Done when:** the plan is accepted only when both said yes; each change is listed against the plan it answers; a stretch can be edited across a week boundary on a phone, with and without dragging; the accepted events exist once each, for both; the replaced plan stays readable.
**Maps to:** DESIGN rc19 §10 *Plans* (plan, plan_event `sid` + `who`, plan_vote, the consensus rule, accept-materialises). Phase: Plans P1–P4.

### US-17 — The game table picks a rhythm (rc19)
Ann runs a table of five. She proposes "Every other Thursday" (four sessions to Christmas). Bob answers with "Saturday afternoons" (three longer sessions); Cat answers Ann's plan with the 19th moved a week. Everyone votes on each plan they can see. Ann, the organizer, sees the tally per plan and **accepts** Cat's; Bob's and her own original are replaced, because they answered the same question. Bob's replaced plan still has a **"Plan the rest…"** for any part of it that the accepted one doesn't cover.
**Done when:** only the organizer can accept in a group larger than two, and she sees every vote first; accepting one replaces its alternatives in one step; nobody else's plan is edited by anyone but its author.
**Maps to:** DESIGN rc19 §10 *Plans* (organizer rule, question = the plans that answer each other, replacement). Phase: Plans P1–P3.

### US-18 — Christmas, and who goes sledging (rc19)
Jana plans the family Christmas for four households: the cottage stretch, Christmas Eve dinner, and "Sledging, if there's snow" *for* Petr and Tom. Lena answers: Christmas Eve in town, the cottage after, and sledging moves to Sunday — **for Lena and Tom**. The change list says "Sledging moved Sat 26 → Sun 27, now for Lena, Tom (was Petr, Tom)". Who an event is for is part of the plan: changing it is a change like any other.
**Done when:** `who` survives copying, is diffed like time and title, and colours follow a person when an event is for one person; an event for nobody in particular is for everyone.
**Maps to:** DESIGN rc19 §10 *Plans* (`who`). Phase: Plans P1–P2.

### US-19 — A name, not an address (rc21)
Lena joins the swing scene's practice group from her personal address and the rope group from another. In the swing group she is "Lena"; in the rope group she is "Kestrel". Nobody in either group sees either address: the organizer typed it once to invite her, and from then on sees the handle. The practice group's teachers want to be reachable, so they turn on *show my email* for that group only.
**Done when:** every list of people — members, "Taking part", voters, history, the mail an invite sends — shows a handle; an address appears only to its owner, or to a container where its owner turned it on; a guest who never signed in shows as the name the inviter gave, or "Guest 2", never part of their address.
**Maps to:** DESIGN rc21 §10 *Privacy basics*. Phase: rc21 R1.

### US-20 — Leaving without a trace (rc21)
Tom stops going to the rope jams. He leaves the group, and his RSVPs and notes there go with him. A year later the old jams themselves are gone: the group keeps 12 months. Then he deletes his account. He is signed out everywhere, his address is no longer anywhere in WhenDoWe, and in the history of the events he helped plan he is now "a former member" — not the same former member in each one. A month later, not even the backup holds him.
Separately, Ana was added by email to a picnic by someone she doesn't know. The email tells her who added her and why she got it; one link stops all further mail to her address and deletes it.
**Done when:** leave, delete an event (cancel first if it's upcoming), garbage collection of events nobody can edit, account deletion with per-event tombstones, export, retention and the opt-out link each have a test that checks nothing of the person is left in storage; a restore re-applies the erasure ledger.
**Maps to:** DESIGN rc21 §10 *Privacy basics*, §13. Phase: rc21 R2–R5.

### US-12 — Someone leaves
Worst case: David and Petra separate. David removes Petra's person from all his events (bulk action). Her mirrors are deleted from *her* calendar via normal reconcile; canonical history — including changes she made — is preserved with attribution (it's an append-only log; her past actions happened). Symmetric case: Petra disconnects her own account → connection `disconnected`, mirrors deleted, person record remains for history.
**Done when:** no-cascade property holds (her removal deletes only her projections); change_log untouched; re-adding her later recreates mirrors (new provider ids, fine).
*(rc21)* If Petra deletes her **account** rather than leaving, her past changes stay but are attributed to "a former member", a different one in each event (US-20).
**Maps to:** deletion model intents (`remove_from_calendar` at person scope), connection `status`. Phase: M3.

### US-13 — Find a slot (the Doodle replacement)
The kid's birthday party needs a date that works for Mara, David, Petra, *and* the grandparents. Mara creates one proposal with **three candidate slots** (Sat 14th, Sun 15th, Sat 21st) and marks everyone as **slot vote**. Each responder answers per slot: `yes / if-need-be / no` — from the WhenDoWe UI, where each candidate is shown against their own calendar.
While voting is open, the candidates project as **tentative events into responders' calendars** — this is the advantage over Doodle: the options *hold space* where scheduling actually happens, instead of living in a forgotten poll link. Viewers (anyone not voting) see nothing yet.
Mara watches responses fill in and **confirms** a slot: that candidate becomes the `scheduled` event and fans out per tier; the losing candidates go Absent everywhere via normal reconcile — no cleanup code, just desired-state. The change log records every vote and the confirmation.
**Done when:** N candidates project tentatively to voters only; confirmation atomically schedules one and withdraws the rest; a re-vote after confirmation is impossible (lifecycle); the whole flow is attributed end-to-end.
**Maps to:** proposal lifecycle + multi-candidate slots (§9 delta), `desired()` policy (tentative-to-voters / absent-to-others is just another interpretation), reconcile unchanged. Phase: **M3b — this is the consensus feature's showpiece.**

---

## 5. Proposal lifecycle (state machine)

```
draft ──propose──▶ proposed ──accept/confirm──▶ scheduled ──cancel──▶ cancelled
  │                  │  │                          ▲   │                  │
  │                  │  └──decline──▶ declined      │   └─edit (material)─┘─▶ flag re-ack (MVP)
  └─────discard      └──withdraw──▶ withdrawn       └────restore──────────── (from cancelled)
```

- A proposal carries **one or more candidate slots**. Single candidate + accept-required = consent flow (US-3); multiple candidates + slot votes = poll flow (US-13). `confirm` picks the winning candidate, writes it as the event's time, and is the same transition as `accept` from the lifecycle's point of view — losing candidates simply stop being part of desired state.
- Only `scheduled` (and grace-period `cancelled`) project to viewers. `proposed` projects tentatively to the people who must respond. `draft/declined/withdrawn` project to no one but live in the log.
- Events with no response-required participant skip straight `draft → scheduled`.
- All transitions and all responses (accept, acknowledge, slot votes) are change_log facts (actor + answer + timestamp): the lifecycle is *interpreted* by `desired()`, exactly like deletion. One mechanism, not three.

## 6. Who-sees-what reference (custody series example)

| | Mara | David | Petra | Grandparents |
|---|---|---|---|---|
| role | participant | organizer | viewer | viewer |
| tier | FULL | FULL | DETAILS | BUSY |
| sees notes/description | ✓ | ✓ | — | — |
| sees title/location | ✓ | ✓ | ✓ | placeholder |
| response | accept | — | — | — |
| proposed events visible | ✓ (party to them) | ✓ | — | — |

## 7. Notifications (MVP posture)

The synced calendar **is** the notification channel — that's the product thesis. On top of it, MVP needs exactly two things:
1. An in-app "needs your response / changed since you looked" list (HTMX page), driven entirely by change_log + participation state.
2. **Transactional email** — and only transactional: invites (US-1) and response-request token links (north star §2 / delta 10) *are* emails; the account-less rule is unimplementable without a send path. One template each, no scheduling, no digests.

Digest emails, reminders, nagging, and push infrastructure are post-MVP (digests are a Ring-1 projection target). The line: MVP email is *request-scoped* (sent because a specific person must act), never *periodic*.

## 8. Non-stories (explicitly out)

Messaging/chat between parents; expense splitting; legal custody documentation; kid-facing views; *automatic* scheduling ("find a free slot for me" — US-13 is manual candidates + human votes, not solver-driven suggestions); cross-household discovery. The product is a truthful, graded, attributed, **consensus-seeking** shared calendar — not a co-parenting suite.

## 9. Deltas to fold back into DESIGN.md (once stories are accepted)

> **Status (rc7):** deltas 1, 2, 4 (as edit + visibility tiers), 6 (as groups), 7 (superseded by DESIGN §15's MVP-1…MVP-5, which carry an old→new milestone mapping so existing "Phase: M3" labels below stay valid) and 9 are folded into DESIGN v1.0-rc7 (§2, §10, §11, §15–§17). The rest stand as written. Kept below as the record of what was decided and why.

1. **`person` table** + invite flow; `calendar_connection.owner_id` → references person; answers §17's "single-user vs multi-account": **multi-person from M3**.
2. **`event_participation` table:** `(canonical_event_id, person_id, role, visibility_tier, response_kind: none|ack|accept|slot_vote, response_state, responded_at)`, UNIQUE(event, person). `desired(canonical, projection)` consults the connection-owner's participation row → `Present(project(event, tier)) | Absent`. This is the §10 policy function gaining its real inputs.
3. **Candidate slots + votes:** `event_candidate (canonical_event_id, slot_index, start_local, end_local, tzid)` and `slot_response (canonical_event_id, person_id, slot_index, answer: yes|ifneedbe|no, responded_at)`. While `status='proposed'`, candidates project tentatively to responders; `confirm` copies the winning candidate into the event's time fields and the candidates leave desired state. Reconcile is untouched.
4. **Visibility tiers `DETAILS`/`BUSY`/`HIDDEN`** implemented in `project()` at M3 (pulls the §5 profile seam forward; `FULL`-only still holds through M2). DESIGN §9 visibility-integrity property becomes load-bearing.
5. **`canonical_event.status` extends** to `draft|proposed|scheduled|cancelled`; lifecycle transitions and all responses are change_log facts interpreted by `desired()`.
6. **Role templates** (per person-pair defaults) as a convenience table — optional, M3.5.
7. **Roadmap refinement:** M3 splits into **M3a** (persons, roles, tiers, manage UI) and **M3b** (responses: acknowledgments, accept-gated proposals, multi-slot polls/US-13, cancellation grace UX).
8. **DESIGN §9 additions:** lifecycle property (*no viewer ever receives a non-scheduled event*), tier-downgrade re-push property, confirm atomicity property (*confirming slot k schedules exactly one event and removes all candidate projections in finite reconcile steps*).
9. **Account-less responses (Ring-0 requirement from the north star, §2):** every response must be deliverable via a signed, single-purpose, expiring token link bound to (event, person); `person` rows are valid with zero calendar connections; a calendar connection is an optional upgrade. Token hygiene joins DESIGN §13.
10. **Transactional email becomes a stack dependency (DESIGN §6):** invites and token-link delivery require an outbound mail path in M3 — an HTTPS transactional email API behind a tiny mail port (raw SMTP is unavailable on Cloudflare Workers; the DESIGN §6 intersection contract therefore mandates the HTTPS path on both deployments). Request-scoped sends only (§7); deliverability engineering is a business-mode concern (BUSINESS §6).

## 10. Open product questions (owner)

- Who confirms a slot vote — always the organizer, or auto-confirm when everyone said `yes` to exactly one slot? (Start: organizer confirms; show a "this slot works for everyone" hint.)
- Voting deadline: do candidates expire / nag, or live until confirmed? (Start: live until confirmed or withdrawn; nagging is a notification-layer concern.)
- Should candidate slots be visible to BUSY-tier viewers as tentative blocks, or only to voters? (Start: voters only.)
- Does a declined proposal notify viewers it almost existed? (Current answer: no — viewers see scheduled reality only.)
- Grace period length for cancelled events (per-household setting vs constant — start with a constant).
- Material-change definition for re-acknowledgment: time/date/location only, or also title? (**Default, DESIGN rc13:** time/date/location only — a renamed event changes nobody's plans, so it shouldn't nag.)
- Should `BUSY` placeholder labels be per-event or per-relationship? (Start per-relationship.)
- *(rc19, plans)* Should a plan put on the table mail the people planning, or is the copy-to-paste message enough while the owner's real channel is a messaging app? (Start: no mail; after sending, the page offers a short message with the link to paste.)
- *(rc19, plans)* Repeat patterns ("week about until June") as a way to *write* a plan — a generator of ordinary plan events, not a series. (Start: none; weeks are drawn by hand or copied from the plan answered.)
- *(rc19, plans)* Voting on a plan without an account (token links, as for polls). (Start: sign in by magic link; the account-less rule is met again when polls become one-event plans.)
