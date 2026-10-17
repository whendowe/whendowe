# WhenDoWe — Design & Agent Bootstrap Brief

> **Status:** v1.0-rc13 (rc12 + MVP-2 slice 2E planned in §10: response requests — accept/acknowledge states, lifecycle as built, material change = time/date/location; link actions name the phase; `event_change_proposal` for the propose tier with §8 `proposal.ts`; whole-series RRULE; history attribution shown to every tier by owner decision) (v1.0-rc12: rc11 + §10: responses — votes, attendance, feedback — are attributed rows of their own, not change_log rows, because change_log's revision key serialises edits; `event_feedback` and `response_token` sketched; §13 token links as built: re-answerable vote/attend links, 14-day expiry, rotate-on-resend by replacement, no session) (v1.0-rc11: rc10 + MVP-2 layout in §8 — `src/events/`, `routes/events.ts`, `routes/respond.ts`; the event lifecycle as a single status column in §10; and §16's one recorded exception: migration 0005 rebuilds `canonical_event`, allowed only because nothing has ever been deployed) (v1.0-rc10: rc9 + §8 entries for `src/web/layout.ts` and `src/web/session.ts`, recorded before MVP-1 slice C) (v1.0-rc9: rc8 + mail provider decided: Cloudflare Email Service, sending from `notify.whendowe.org`, behind an app-enforced hard cap — §8 entries for `src/mail/cloudflare.ts` and `src/mail/capped.ts`) (v1.0-rc8: rc7 + §8 layout for MVP-1, recorded before the code: `src/people/`, `src/ids.ts`, `src/mail/console.ts`, `src/web/routes/{auth,groups}.ts`) (v1.0-rc7: rc6 + roadmap re-sequenced people-first after an owner review: Ring 0 widened from "the household" to small groups of people who know each other; two-way Google sync is MVP scope; edit tier split from visibility tier; WORKFLOWS §9 deltas folded in — multi-person, account-less responses; §17 single-vs-multi resolved; provider-neutrality made a hard constraint) (v1.0-rc6: rc5 + M1 as-built corrections to §8: `src/crypto/` and `src/oauth/` were introduced during M1 but never documented; `src/web/routes/` contents named; `src/web/escape.ts`; `src/providers/google-event.ts`; `src/recurrence.ts` — undocumented since the M1 recurrence spike; and a `scripts/` directory. Plus §13: the deployments repo is *credential*-human-only — the boundary is credential access, not repo write access, so instance config may be agent-authored and owner-merged) (rc4 + M0 as-built corrections: change_log id in SQLite dialect, fake provider filename, publish-not-deploy workflow comment, Hegel FFI mechanism) (rc3 + security hardening: token-link semantics, ICS/HTML injection, OAuth state/PKCE, supply-chain cooldown & ignore-scripts, agent privilege model, backup-tail deletion promise) (v0.9 + artifact-store port seam for feeds/pages; v0.7 + scheduling economics: cron fan-out vs DO alarms; v0.6 + platform pivot: TypeScript intersection contract — one codebase targeting Cloudflare Workers/D1/Durable Objects free tier *and* Node/Docker self-host; SQLite dialect; Hegel-based verification; earlier history in companions/git). **Name:** WhenDoWe — repo `github.com/whendowe/whendowe`, domain `whendowe.org` (Cloudflare-registered), package name `whendowe`.
> **Audience:** the coding agent bootstrapping this repo, and future human contributors.

---

## 1. Purpose of this document

This is two things at once:

1. **An executable bootstrap brief.** §6–§10 are concrete enough that an agent can initialise the repo, add the license, lay out the skeleton, and wire the verification harness from them directly.
2. **The design record.** §3–§5 and §11–§16 capture *why*, so implementation choices don't drift.

An agent picking this up should: read §2–§5 for context, follow §8–§10 to scaffold, then work the roadmap in §15 one milestone at a time, treating §9 (the verification gate) as the Definition of Done for **every** change and §16 as hard constraints.

**Document map.** This file has two companions: **`WORKFLOWS.md`** (personas, user stories, the north-star vision, and the response/consensus primitive — what people agree on and who sees it) and **`BUSINESS.md`** (segments, revenue model, business-mode triggers). Division of labor: DESIGN.md owns *how truth converges*; WORKFLOWS.md owns *what M3+ must do for people*; BUSINESS.md changes no scope but constrains decisions (e.g. provider priority, CLA timing). **Precedence note:** WORKFLOWS.md §9 lists schema/scope deltas *pending integration* into this file — where they conflict with §2's out-of-scope list or §17 (notably: visibility tiers, the proposal/response lifecycle, multi-person, account-less responses), WORKFLOWS.md reflects the owner's newer intent. The agent reads this file before M0 and WORKFLOWS.md before starting M3.

---

## 2. Problem & MVP scope

**Problem.** People maintain several overlapping shared calendars (co-parenting, partner, extended family, a friend group's game night). An event relevant to more than one must be *copied*, edits don't propagate to the copies, and there's no record of who changed what — so calendars silently disagree. We want an event to exist **once** and be projected into many calendars, with edits propagating and full change attribution.

**Audience (MVP):** the first ~100 people — the owner's household and friends, deliberately a diverse mix: households coordinating kids, and ad-hoc groups such as a D&D table. Small groups of people who know each other (WORKFLOWS Ring 0). Not a public sign-up product yet.

**In scope (MVP):**
- **People without a calendar:** persons, magic-link login, groups, email invites. A person with zero calendar connections is a full participant (WORKFLOWS §2 account-less rule).
- A provider-agnostic **canonical event store** (the source of truth), created and edited in WhenDoWe's own UI.
- **Responses:** accept, acknowledge, slot votes, attendance intent (going / maybe / not going) and feedback — all deliverable by token link without an account.
- **Per-person edit tier** (`edit` / `propose` / `view`) and **visibility tier** (`FULL` / `DETAILS` / `BUSY` / `HIDDEN`) — two independent axes (WORKFLOWS §3).
- Change attribution ("who changed what, when").
- Single events and whole-series recurrence.
- **Read-only ICS feeds** per person and per group — calendar presence for every calendar app, no OAuth.
- **Shared views:** unlisted (anyone with the link) or invite-only (specific people by email).
- **Two-way Google sync:** projection into each person's Google calendar, *and* edits made there flow back, gated by that person's edit tier (§11).

**Out of scope (deferred behind seams — see §5):**
- Two-way Apple (CalDAV) and Microsoft (Graph) — ICS feeds cover them read-only meanwhile, and the provider port must not preclude them (§16). Discoverable public pages / capacity-limited RSVP / booking (Rings 1–2). Importing a person's existing native events (§11). Per-instance recurrence overrides. Multi-*tenant* (org) hosting. Google OAuth verification — the MVP stays within the unverified-app cap (§12).

**Phasing:** the earlier Phase 1 (one-way) / Phase 2 (bidirectional) split survives as an *internal* sequence (§15 MVP-4 and MVP-5), not as a release boundary: both ship before the first 100. Rationale (owner): "I need to remember to log in to a different app to change this thing I have in my calendar" is the friction that kills apps like this.

**Demo moment (MVP success):** a group agrees a time without anyone creating an account; the confirmed event appears in each member's own calendar; one member moves it *in their Google calendar*; everyone's copy follows, or — if they may only propose — it becomes a proposal the group can accept; the change log shows who did what.

---

## 3. Architectural principles

1. **Desired-state reconciliation, not event-driven propagation.** A worker continuously drives each projection toward "what canonical says it should be." Never "on edit, push everywhere."
2. **Idempotency & convergence.** Re-running reconcile must be a no-op when state already matches. This is the central invariant and the reason echoes and partial failures are survivable: you converge, you don't replay.
3. **Everything is a projection of a canonical event.** Calendars are output targets today; ICS feeds and public pages are just more output types later. Sources are inputs. The canonical store is the convergence point.
4. **Identity is explicit, never fuzzy.** Every mirror carries the canonical UID in provider-side hidden metadata. Never match events by title/time.
5. **Types are a hard gate; invariants are property-tested.** Strict type-checking blocks merges; reconcile invariants are verified with property-based tests (§9).

---

## 4. Core concepts (glossary)

- **CanonicalEvent** — the source of truth, modelled RFC 5545-natively: wall-clock DTSTART/DTEND + TZID, verbatim RRULE, EXDATEs, and override children (RECURRENCE-ID) — see §10. Stable UID, monotonic `revision`, provider-agnostic fields, an `origin`.
- **CalendarConnection** — one connected external calendar: OAuth tokens, target calendar id, incremental sync cursor.
- **Projection** — one row per (CanonicalEvent × CalendarConnection). The identity map *and* the echo detector: holds the provider event id, etag, last-pushed content hash, a small ring of recent write-nonces, the canonical revision it was last synced to, a visibility profile, and a state.
- **VisibilityProfile** — which fields a projection mirrors. MVP: `FULL` only.
- **Reconcile loop** — the worker that converges projections to desired state.
- **Echo** — a change notification caused by our own write, which must not be mistaken for a user edit.
- **ChangeLog** — append-only record of accepted changes; doubles as attribution feed and merge base.

---

## 5. Extensibility seams — build the *shape* now, defer the *feature*

| Seam (build now) | MVP implementation | Deferred behind it |
|---|---|---|
| **Provider port** (`CalendarProvider` interface: `list_changes`, `upsert`, `delete`, `find_by_metadata`, later `watch`) | `GoogleCalendarProvider` only | CalDAV (Apple), Microsoft Graph |
| **Source-agnostic canonical + `origin` field** | `user_edit`, `imported_from_calendar` | `ics_import`, `public_page`, `venue_feed` |
| **`project(event, profile) -> fields`** routed on every push | `FULL` (identity) only | `PUBLIC`, `INVITED`, `CONFIRMED` (per-audience views) |
| **Polymorphic subscription target** | target is always a `CalendarConnection` | public ICS feed, public event page, notified person |
| **RFC 5545-native recurrence model** (wall-clock+TZID, RRULE, EXDATE, `event_override` table) | whole-series only; EXDATEs empty, override table empty | per-instance overrides & cancellations; ICS import/export becomes serialization |
| **Deployment adapters** (`deploy/` — Hono app + storage port are platform-blind) | Cloudflare Workers/D1/DO (hosted, free tier) **and** Node/Docker/SQLite (self-host) | other runtimes (Bun, Deno), managed Postgres via a third driver if scale ever demands |
| **Artifact-store port** (write-once published artifacts: ICS/RSS feeds, public pages — a *projection whose provider is a file*) | port defined, unused (MVP has no feeds) | R2 driver (CF) / filesystem driver (Node); feeds regenerate on change via normal reconcile, subscribers read CDN-cached artifacts — publishing at ~zero marginal cost; later ActivityPub as a push adapter |

Rule: getting these shapes right is cheap now and expensive later; building the deferred features now is expensive and easy to add later behind a stable seam. Do the former, not the latter.

---

## 6. Tech stack (pinned)

**The intersection contract (governs everything below).** One codebase targets **two deployments**: **Cloudflare Workers** (Workers + D1 + Durable Objects + Cron Triggers — free tier covers household scale, no VPS to run) and **plain Node in Docker** (self-host on any VPS — the AGPL/community story). Rule: every component is designed against the **weaker** guarantee of the two platforms:

- **Storage:** SQLite dialect only; atomicity = statement-list `batch()` (D1 has no interactive transactions).
- **Concurrency:** structural single-writer per connection (Durable Object on CF; single process on Node) — never row locks (SQLite has none).
- **Scheduling:** chunked ticks — Cron Trigger + DO alarms on CF; in-process scheduler on Node. No long-lived daemon assumptions.
- **Mail:** HTTPS transactional email API (raw SMTP is unavailable from Workers).
- **Economics:** a steady-state reconcile tick performs **zero writes** — D1's free tier caps daily writes, so the idempotent no-op path is economically load-bearing, not just elegant (verified by a §9 property).

Domain code imports neither `wrangler`/binding APIs nor Node APIs directly; the adapters in `deploy/` (§8) are the only platform-aware files.

**Language & runtime:** TypeScript, `strict` plus `noUncheckedIndexedAccess`. Node 22 LTS locally / workerd on Cloudflare. npm.

**Application:**
- **Hono** — HTTP layer, runtime-agnostic by design: the same app object serves under workerd and `@hono/node-server`. Server-rendered views + **HTMX**; no SPA; views render typed view-models only (§16).
- **zod** — all I/O boundary schemas and typed view-models (runtime validation where agent code is riskiest), including the parsed-env config.
- **Drizzle ORM + drizzle-kit** — typed SQL over the storage port; migrations are **generated as plain `.sql` files** (§16 portability constraint) and applied by `wrangler d1 migrations` or a ten-line Node runner.
- **Storage drivers:** D1 binding (CF) and better-sqlite3-wrapped-async or libsql (Node). The port interface is **async-only** — better-sqlite3 is synchronous and must be wrapped; a sync-shaped port would fork the adapters' code shape immediately.
- **Google Calendar via plain REST (`fetch`)** — no SDK; the official Node client is Node-bound and oversized for workerd, and OAuth refresh is two fetches. The `CalendarProvider` port hides this entirely.
- **Recurrence:** **rrule.js expanding in floating (naive) time only** + **temporal-polyfill** for localisation via `tzid`. rrule.js's notorious timezone quirks are avoided by never letting it see a zone — which is exactly the §10 wall-clock model. Riskiest translation from the Python plan: pinned by an **M1 spike** plus the §9 DST/round-trip properties; fallback is hand-rolled expansion of the deliberately small validated RRULE subset.
- **Mail:** HTTPS transactional API (e.g. Resend) behind a tiny mail port; needed from M3 (WORKFLOWS §9 delta 10).

**Verification toolchain (the gate — §9):**
- **tsc `--noEmit`** — blocking type gate. The `Action` ADT is a discriminated union checked with `never`-exhaustiveness (arguably stronger than the Python equivalent).
- **Biome** — lint + format, one fast tool.
- **vitest** — test runner. **Hegel (`@hegeldev/hegel`)** for property-based testing: Hypothesis internals (choice-sequence generation and shrinking) exposed over the Hegel protocol. Beta with semver-shifted versioning — **pin the minor**. As-built (verified at M0): the native Rust core (`libhegel`) is driven **in-process via FFI**, with prebuilt binaries bundled in the npm package (Linux amd64/arm64, macOS arm64, Windows amd64/arm64) — nothing downloaded or compiled at install time, which also keeps it compatible with `ignore-scripts=true` (§18). The devcontainer remains the canonical environment for contributors and agents. **fast-check is the documented fallback** — only tests may depend on the PBT library, never domain code, so swapping costs a test directory, not the core.
- **@cloudflare/vitest-pool-workers** — adapter/contract tests against real D1/DO bindings inside workerd. Hegel cannot run there (native core); pure-core tests don't need to.

Rationale: free hosting (CF) and `docker compose up` self-hosting are both first-class from one codebase. TypeScript is the price of the intersection; it is paid back by exhaustiveness-checked ADTs and by Hegel retaining Hypothesis-quality shrinking — the two pillars of the verification strategy.

---

## 7. License

**Recommendation: GNU AGPL-3.0-or-later.** It fits the intended model (open source; revenue from hosting + support) and prevents a third party from running a closed, modified hosted version — the network-use clause forces them to share modifications. This is the standard choice for "open but defended" server software.

**Tradeoff to accept consciously:** AGPL deters some corporate contributors/users and blocks *you* from later shipping closed proprietary extensions served over the network. If max adoption matters more than defence, Apache-2.0 (permissive) or an open-core split (AGPL core + separately licensed add-ons, requires a CLA so you own copyright) are the alternatives.

**Agent action:** add the verbatim GNU AGPL-3.0 text as `LICENSE`, add `SPDX-License-Identifier: AGPL-3.0-or-later` headers to source files, and state the license in `README` and `package.json`.

---

## 8. Repository skeleton

```
whendowe/
  LICENSE                      # AGPL-3.0 verbatim
  README.md
  AGENTS.md                    # canonical agent operating manual (short; binding)
  CLAUDE.md                    # one-line import of AGENTS.md (no duplicated rules)
  CODEOWNERS                   # owner review required: tests/property/**, .github/**, migrations/**, *.md design docs, AGENTS.md
  .github/workflows/
    ci.yml                     # npm run check (both-driver contract matrix)
    deploy.yml                 # PUBLISHES artifacts (§18): ghcr image on main; release on tag v*.
                               # Never deploys — promotion lives in whendowe/deployments.
    soak.yml                   # nightly npm run soak
  .devcontainer/               # identical env for owner, contributors, cloud agents (Hegel needs Linux)
  DESIGN.md                    # this document
  WORKFLOWS.md                 # user stories, north star, response primitive (companion)
  BUSINESS.md                  # segments, revenue model, business-mode triggers (companion)
  package.json                 # deps, npm scripts (check/soak/dev)
  package-lock.json
  tsconfig.json                # strict + noUncheckedIndexedAccess
  biome.json
  drizzle.config.ts
  .env.example                 # config keys, no secrets
  migrations/                  # plain .sql — applied by wrangler d1 migrations OR the node runner
  scripts/                     # developer/agent helpers; never part of the build or the gate
    watch-pr-checks.sh         # stream PR check results until they settle (gh + jq)
  src/
    config.ts                  # zod-parsed env
    ids.ts                     # UUIDv7 for text primary keys, generated in app code (schema.ts convention)
    recurrence.ts              # validated RRULE subset + occurrence expansion (rrule-floating + temporal)
    crypto/
      base64.ts                # base64 / base64url over the btoa/atob globals (platform-blind)
      tokens.ts                # AES-GCM cipher for the *_enc columns; key-id prefix = rotation without migration (§13)
    db/
      schema.ts                # Drizzle schema (SQLite dialect)
      port.ts                  # async storage port (query/batch) — the ONLY way domain code touches storage
      d1.ts                    # driver: D1 binding
      sqlite.ts                # driver: better-sqlite3 (async-wrapped) / libsql
    people/                    # MVP-1 (§15): identity is domain code, not web code
      person.ts                # person repository; email normalisation; one person per verified email
      tokens.ts                # opaque bearer tokens: random bytes out, only SHA-256 hashes stored
      login.ts                 # magic links: single-use, short-lived, issued per email (sign-up = sign-in)
      session.ts               # sessions + CSRF tokens
      group.ts                 # groups + members with default edit/visibility tiers (§10)
      invite.ts                # email invites into a group
    events/                    # MVP-2 (§15): events, who takes part, polls and responses
      event.ts                 # canonical events: create/edit with optimistic revision + change_log; lifecycle
      participation.ts         # who takes part, with edit tier + visibility; copied from group defaults
      poll.ts                  # candidate times + votes (yes / if-need-be / no) + confirm (WORKFLOWS US-13)
      proposal.ts              # propose tier: a pending change an editor accepts or rejects (MVP-2, rc13)
      response.ts              # accept / acknowledge / attendance / feedback, incl. account-less token links
    oauth/
      pkce.ts                  # RFC 7636 verifier/challenge (S256 only) + state nonce (§13)
      authorize.ts             # Google authorization request URL (§12)
      flow-cookie.ts           # in-flight flow: an ENCRYPTED COOKIE, not an oauth_state table (§13)
      http.ts                  # minimal fetch surface + zod-validated JSON — no SDK (§6)
      token-exchange.ts        # authorization code -> tokens
      primary-calendar.ts      # account/calendar identity for a new connection (§10)
    providers/
      base.ts                  # CalendarProvider port
      google.ts                # REST via fetch
      google-event.ts          # Google event resource -> ProviderEvent (pure mapping, §12)
      fake.ts                  # fault-injecting simulator (§9)
    reconcile/
      actions.ts               # Action ADT — discriminated union (§9 functional core)
      decide.ts                # pure decide(projection, canonical, incoming) -> Action
      desired.ts               # desired-state policy, incl. deletion model (§10)
      echo.ts                  # 3-layer echo detection
      project.ts               # project(event, profile) -> fields
      conflict.ts              # conflict resolution policy
      tick.ts                  # one chunked reconcile tick — orchestration over the ports
    web/
      app.ts                   # Hono app (shared by both deployments)
      escape.ts                # HTML escaping — provider/event text is untrusted input (§13)
      layout.ts                # the shared page shell every route renders into (escapes its inputs)
      session.ts               # session middleware: cookie -> person on the request context; CSRF check
      routes/                  # OAuth, events UI (HTMX)
        oauth.ts               # POST connect (GET never mutates) + GET callback: state, PKCE, store
        oauth-deps.ts          # config + storage port -> route dependencies
        auth.ts                # magic-link request + confirm (GET renders, POST acts — §13), sign-out
        groups.ts              # create group, invite, accept invite
        events.ts              # create/view/edit events in a group; polls; change history (MVP-2)
        respond.ts             # token-link responses: vote / attend / acknowledge with no account (MVP-2)
    changelog.ts               # append + diff
    mail/
      port.ts                  # HTTPS mail port (invites, token links — MVP-1)
      console.ts               # development adapter: prints the message, never sends
      cloudflare.ts            # Cloudflare Email Service: Workers binding (hosted) + REST (Node self-host)
      capped.ts                # hard send cap: an atomic per-day/per-month slot reservation before every send
  deploy/
    cloudflare/
      wrangler.jsonc           # bindings: D1, DO, cron
      worker.ts                # entry: Hono fetch + scheduled handler
      connection-do.ts         # Durable Object per connection: serialization + retry alarms ONLY
    node/
      server.ts                # @hono/node-server + in-process scheduler
      Dockerfile
      docker-compose.yml       # app + sqlite volume (+ litestream backup)
  tests/
    unit/
    property/                  # Hegel: invariants + simulation state machine (plain vitest)
    contract/                  # storage-port contract suite — MUST pass on BOTH drivers
    workers/                   # vitest-pool-workers: adapter tests in workerd
    conftest.ts
```

---

## 9. Static analysis & test harness — the verification gate

A single command must run the whole gate; CI and the agent both use it — `npm run check`:

```
biome check .
tsc --noEmit                       # strict; blocking
vitest run                         # unit + property (Hegel) + contract suite vs sqlite driver
vitest run --project workers       # adapter/contract tests in workerd vs D1/DO bindings
```

CI runs the storage-port **contract suite against both drivers** (sqlite locally, D1 via the workers pool) — this matrix is what stops the two deployment adapters drifting apart silently.

**Definition of Done for every change:** `npm run check` is green. No merge with type errors, lint errors, or failing tests. No `any`, no `@ts-expect-error`/`as`-cast without an inline justification.

**Property-test targets (Hegel) — these are the heart of correctness:**
- *Idempotency:* reconciling an already-synced projection performs no write.
- *Convergence:* from any starting state, reconcile reaches desired state in finite steps.
- *Echo suppression:* a read-back of our own write (matching nonce/etag/hash) never mutates canonical.
- *Stale-echo suppression:* a read-back of an **older** write (nonce earlier in the ring, superseded by a newer push) is still suppressed — it must not be applied inbound, or canonical oscillates between old and new content.
- *No duplicate mirrors:* re-running reconcile after a simulated crash between the provider write and the bookkeeping update adopts the existing provider event (found via its `canonical_uid` metadata) instead of creating a second one. The fake provider should be able to inject this crash.
- *No cascade:* deleting one projection/mirror never deletes the canonical event or other projections.
- *Cancel/restore round-trip:* cancel then restore re-converges to mirrors present with identical content (new provider ids permitted); no change_log history is lost.
- *Visibility integrity:* a projection never contains a field its profile excludes (forward-looking; trivially true for `FULL`).
- *Wall-clock stability:* every expanded occurrence of a recurring event has the same local time-of-day in its TZID, across DST transitions (generate rrules straddling transitions).
- *Time-model round-trip:* canonical → provider/ICS representation → canonical is the identity on the supported RRULE subset.
- *Steady-state zero-write:* a reconcile tick over fully-synced projections issues no storage writes (no `updated_at` churn). Correctness twin of *Idempotency*; economically load-bearing on D1's free write budget (§6).

**Fake provider:** `providers/fake.ts` implements the `CalendarProvider` port in memory. All reconcile/property tests run against it — fast, deterministic, and they never touch the real Google API. (This is a second payoff of the port abstraction.)

**Deterministic simulation harness — catching distributed-systems bugs in-process.** The failure modes that matter here (duplicate-create crash window, stale-echo oscillation — §11) live in *interleavings* of crashes, delayed notifications, and reordering. They are made testable by construction:

1. **Functional core, imperative shell.** Each reconcile step is a pure function `decide(projection, canonical, incoming) -> Action`, where `Action` is an exhaustive tagged union of frozen dataclasses (`CreateMirror | AdoptOrphan | Push | SuppressEcho | ApplyInbound | DeleteMirror | Noop`). a `switch` with a `never`-exhaustiveness check guarantees every case is handled; effects (provider calls, storage writes) live in a thin interpreter. Pure decisions are what Hegel exercises cheaply — and they run under plain vitest, which is required: Hegel's native core cannot run inside workerd.
2. **The fake provider is a fault-injecting simulator, not a stub.** Change notifications go into an explicit outbox that tests drain *on command* — later, reordered, or duplicated (this reproduces stale echoes). Every effect boundary has a crash hook: "raise after the provider state mutates but before returning the result" (this reproduces the duplicate-create window). The clock and nonce generator are injected. No threads, no sleeps: concurrency is modeled as interleaving choices made by the test.
3. **A Hegel draw-loop state machine** drives the simulator: one property draws a sequence of actions (`tc.draw` over an action generator, in a loop) and applies each to model + system. Actions: edit canonical; edit a mirror externally; run one reconcile tick; deliver one pending notification (the draw chooses which); crash mid-push then restart from persisted state. This hand-rolled shape is deliberate: Hypothesis-style **choice-sequence shrinking** shrinks correctly through arbitrary imperative loops (the reason for Hegel over fast-check), and it depends only on the stable `draw` primitive, insulating the suite from beta API churn. Invariants after every step, plus a **quiescence check** (run ticks to fixpoint, then assert):
   - ≤1 provider event per (connection, `canonical_uid`) — catches duplicate creates;
   - quiesced canonical equals the last genuine write, and `revision` growth is bounded by the count of genuine edits — catches echo oscillation (symptom: revision climbs without external edits);
   - the §9 property list above holds throughout.

When Hegel finds a failing interleaving it shrinks it to a minimal action sequence, replayable by seed — turning would-be production incidents into pinned regression tests. The simple per-method property tests above still run against the same fake with faults disabled.

**Gate vs soak.** The stateful suite lives in `tests/property/` and runs in `npm run check` with a modest budget (small step/example counts) so the gate stays fast on every change. A separate `npm run soak` target runs the *same* state machine with a large step count and high example count — nightly or pre-release. Bug-finding power scales with the number of interleavings explored; the gate must not pay that cost on every commit. Any failure found in soak gets its shrunken sequence pinned as an explicit regression test that then runs in the fast gate.

---

## 10. Database schema (SQLite dialect — identical on D1 and plain SQLite)

One dialect, two homes (§6 intersection contract): the same plain-`.sql` migrations run on Cloudflare D1 and on a SQLite file. Conventions: `text` PKs holding UUIDv7 **generated in app code** (no DB-side generation); enums as `text` + CHECK. **Time columns are ISO-8601 `text`**: instants as UTC with `Z` suffix (`created_at`, `token_expiry`, `retry_at`, …); RFC 5545 wall-clock fields as zone-less local `YYYY-MM-DDTHH:MM:SS` (`start_local`, `end_local`, `recurrence_id`), where the instant is *derived* via `tzid` — see the time-model note below. (ISO-8601 sorts lexicographically, so index/range semantics survive.) JSON lives in `text` columns (SQLite's JSON functions apply); booleans are `integer` 0/1; `created_at`/`updated_at` are set by app code — no `now()` defaults. Atomicity is the statement-list `batch()`, never an interactive transaction. Token columns are encrypted at rest (§13).

```sql
CREATE TABLE calendar_connection (
    id                 text PRIMARY KEY,
    owner_id           text NOT NULL,                 -- account that owns the connection
    provider           text NOT NULL DEFAULT 'google',-- seam: provider port
    account_email      text NOT NULL,
    calendar_id        text NOT NULL,                 -- the external calendar this targets
    access_token_enc   text NOT NULL,
    refresh_token_enc  text NOT NULL,
    token_expiry       text,
    sync_token         text,                          -- incremental cursor (nullable -> full sync)
    watch_channel      text,                          -- nullable; for later webhook support
    status             text NOT NULL DEFAULT 'active',-- 'active' | 'auth_error' | 'disconnected'
                                                      -- auth_error: revoked/expired grant (§12);
                                                      -- worker skips its projections until reconnected
    created_at         text NOT NULL,
    updated_at         text NOT NULL,
    UNIQUE (owner_id, provider, calendar_id)          -- one connection per target calendar;
                                                      -- a duplicate would double-mirror every event
);

CREATE TABLE canonical_event (
    id           text PRIMARY KEY,
    revision     integer NOT NULL DEFAULT 1,           -- monotonic; bumped on every accepted change
    origin       text NOT NULL,                        -- 'user_edit' | 'imported_from_calendar' (seam)
    owner_id     text NOT NULL,
    title        text NOT NULL,
    description  text,
    location     text,
    -- RFC 5545-native time model. Wall-clock + TZID is the AUTHORITATIVE representation;
    -- UTC instants are derived, never stored as truth.
    start_local  text NOT NULL,                   -- DTSTART: naive wall-clock
    end_local    text NOT NULL,                   -- DTEND: naive wall-clock, same tzid
    tzid         text,                                 -- IANA TZID; NULL only when all_day
    all_day      integer NOT NULL DEFAULT 0,       -- DATE-valued DTSTART/DTEND semantics
    rrule        text,                                 -- verbatim RFC 5545 RRULE (validated subset, see note)
    exdates      text NOT NULL DEFAULT '[]',          -- EXDATE: cancelled occurrences as local datetimes.
                                                       -- MVP: stays empty (seam)
    status       text NOT NULL DEFAULT 'active',       -- 'active' | 'cancelled'
    created_at   text NOT NULL,
    updated_at   text NOT NULL
);

CREATE TABLE event_override (                          -- RFC 5545 override components (RECURRENCE-ID).
                                                       -- MVP: table EXISTS but stays EMPTY (seam, §5/§16) —
                                                       -- inbound instance edits are skipped in §11, and the
                                                       -- UI creates none. Phase 3 fills it; schema never moves.
    id                 text PRIMARY KEY,
    canonical_event_id text NOT NULL REFERENCES canonical_event(id) ON DELETE CASCADE,
    recurrence_id      text NOT NULL,             -- original occurrence DTSTART, wall-clock in parent tzid
    field_overrides    text NOT NULL,                 -- sparse {field: value}; unlisted fields inherit parent
    created_at         text NOT NULL,
    updated_at         text NOT NULL,
    UNIQUE (canonical_event_id, recurrence_id)
);

-- Why RFC 5545-native, from day one (consequences, not aspirations):
-- 1. DST correctness by construction. "Weekly 09:00" is stored as wall-clock + TZID, which is
--    what it means. Expansion iterates the rrule on naive local datetimes and localises each
--    occurrence (zoneinfo); there is no UTC-instant drift to guard against, because no UTC
--    instant is authoritative. Push to Google as dateTime + timeZone + RRULE — near-identity.
-- 2. The instance-override problem (§11) gets a real home: an inbound per-instance edit is a
--    legitimate write to event_override, not a misread series edit. MVP still skips them;
--    the upgrade is "start accepting rows", not a migration.
-- 3. ICS import/export (§15 post-M5) becomes serialization, not translation.
-- Semantics split, per the RFC: EXDATE = occurrence cancelled; event_override row = occurrence
-- modified. Cancellation of an overridden occurrence removes the row AND adds the EXDATE.
-- Validated RRULE subset at the zod boundary: FREQ in {DAILY,WEEKLY,MONTHLY,YEARLY},
-- INTERVAL, BYDAY, COUNT|UNTIL. Reject everything else loudly; widen deliberately, with tests.
-- Range queries ("events this week") expand in the app layer at MVP scale; if it ever matters,
-- add DERIVED instant columns (clearly non-authoritative) for indexing — never the reverse.

CREATE TABLE projection (
    id                     text PRIMARY KEY,
    canonical_event_id     text NOT NULL REFERENCES canonical_event(id) ON DELETE CASCADE,
    calendar_connection_id text NOT NULL REFERENCES calendar_connection(id) ON DELETE CASCADE,
    visibility_profile     text NOT NULL DEFAULT 'FULL',
    provider_event_id      text,                        -- null until first create
    provider_etag          text,
    last_pushed_hash       text,                        -- hash of the FILTERED fieldset we last pushed
    recent_write_nonces    text NOT NULL DEFAULT '[]', -- ring of last ~5 nonces; echo detection (§11)
    base_revision          integer,                     -- canonical revision last synced to this mirror
    state                  text NOT NULL DEFAULT 'pending_create',
                                                        -- pending_create|synced|pending_update|pending_delete|deleted|error
    last_error             text,
    retry_at               text,                 -- next retry for 'error' rows (capped backoff, §12)
    created_at             text NOT NULL,
    updated_at             text NOT NULL,
    UNIQUE (canonical_event_id, calendar_connection_id)
);
CREATE INDEX projection_state_idx ON projection(state);     -- worker scans by state
CREATE INDEX projection_event_idx ON projection(canonical_event_id);

-- Deletion model — record intents, interpret later (UX intentionally deferred, §17):
-- 1. No user action ever hard-DELETEs a row. User acts are appended FACTS: 'cancel',
--    'remove_from_calendar(X)', 'restore', 'purge_request' — change_log rows (actor + diff)
--    plus status flips. History is never destroyed by the act it records.
-- 2. INTERPRETATION is a pure policy: desired(canonical, projection) -> Present(fields) | Absent.
--    Reconcile converges mirrors to it. Every candidate deletion UX is just a policy variant:
--    instant vanish (cancelled -> Absent), grace period (Present with "CANCELLED:" transform for
--    30 days, then Absent), trash-with-restore, per-calendar unsubscribe (Absent for one
--    projection). Swapping policies touches no schema and no sync machinery.
-- 3. HARD DELETE is a separate, explicit purge pipeline (the §13 data-deletion path), permitted
--    only when every projection is 'deleted' — otherwise provider-side events would be orphaned
--    as unmanaged copies (the disease this project cures). The ON DELETE CASCADE FKs are a
--    row-hygiene backstop *inside* purge, never a code path reachable from user action.
-- 4. Undo is free: 'restore' flips status back and reconcile recreates mirrors. New provider
--    event ids are fine — identity is the canonical UID (§3.4), not the provider id.

CREATE TABLE change_log (                                -- append-only
    id                 integer PRIMARY KEY AUTOINCREMENT, -- (bigserial was a Postgres-ism;
                                                          --  this is the §6 SQLite dialect)
    canonical_event_id text NOT NULL REFERENCES canonical_event(id) ON DELETE CASCADE,
    revision           integer NOT NULL,
    actor              text NOT NULL,                    -- connection id / user id / 'system'
    source             text NOT NULL,                    -- 'ui' | 'inbound_sync'
    diff               text NOT NULL,                   -- {field: {before, after}}
    created_at         text NOT NULL,
    UNIQUE (canonical_event_id, revision)               -- one accepted change per revision; makes
                                                        -- the log a true serialization of history
);
CREATE INDEX change_log_event_idx ON change_log(canonical_event_id, revision);
```


### Event lifecycle (rc11)

`canonical_event.status` is the single lifecycle column, WORKFLOWS §5's state machine verbatim:
`draft | proposed | scheduled | declined | withdrawn | cancelled`. One column with one CHECK, so an
impossible pair (say, "cancelled" and "draft" at once) is unrepresentable rather than ruled out in
code. The original `active` value means `scheduled`. Migration 0005 replaces the M0 constraint by
rebuilding the table — see the one-time exception in §16.

### People, groups & participation (rc7 — folded from WORKFLOWS §9)

A sketch, not a migration: each table lands as a plain `.sql`, additive migration in the milestone that first needs it (§15), and is refined there. Recorded here so the shape is agreed before code.

```sql
CREATE TABLE person (                      -- MVP-1. A person exists with zero calendar connections.
    id          text PRIMARY KEY,
    email       text NOT NULL UNIQUE,      -- verified; the identity key across login methods
    display_name text,
    created_at  text NOT NULL
);
-- calendar_connection.owner_id → person.id (MVP-1; replaces the M1a placeholder owner 'self').

CREATE TABLE person_group (                -- MVP-1. A reusable set of people: a household, a D&D table.
    id text PRIMARY KEY, name text NOT NULL, created_by text NOT NULL REFERENCES person(id),
    created_at text NOT NULL
);
CREATE TABLE group_member (                -- MVP-1. Per-member DEFAULTS, copied onto new events
    group_id text NOT NULL REFERENCES person_group(id),   -- (WORKFLOWS §9 delta 6 "role templates").
    person_id text NOT NULL REFERENCES person(id),
    default_edit_tier text NOT NULL,       -- edit | propose | view
    default_visibility text NOT NULL,      -- FULL | DETAILS | BUSY | HIDDEN
    UNIQUE (group_id, person_id)
);

CREATE TABLE event_participation (        -- MVP-2. The input desired() was always missing (§10 policy).
    canonical_event_id text NOT NULL REFERENCES canonical_event(id),
    person_id          text NOT NULL REFERENCES person(id),
    edit_tier          text NOT NULL,      -- edit | propose | view     (what they may CHANGE)
    visibility         text NOT NULL,      -- FULL | DETAILS | BUSY | HIDDEN (what they SEE)
    response_kind      text NOT NULL,      -- none | ack | accept | slot_vote
    response_state     text,               -- per kind; facts also appended to change_log
    attendance         text,               -- going | maybe | not_going | NULL — any tier
    UNIQUE (canonical_event_id, person_id)
);
-- Candidate slots + votes: WORKFLOWS §9 delta 3, unchanged (MVP-2).

-- rc12: responses are attributed rows of their own, NOT change_log rows (see below).
-- event_participation gains responded_at (when attendance was last stated).
CREATE TABLE event_feedback (              -- MVP-2. Append-only notes: "might be late".
    id                 text PRIMARY KEY,   -- UUIDv7
    canonical_event_id text NOT NULL REFERENCES canonical_event(id),
    person_id          text NOT NULL REFERENCES person(id),
    body               text NOT NULL,      -- short; escaped on render like every event field
    created_at         text NOT NULL
);
CREATE TABLE response_token (              -- MVP-2. The account-less surface (§13 token links).
    token_hash         text PRIMARY KEY,   -- SHA-256 of the 256-bit token; the token is never stored
    canonical_event_id text NOT NULL REFERENCES canonical_event(id),
    person_id          text NOT NULL REFERENCES person(id),
    action             text NOT NULL,      -- vote | attend — one action × one event × one person
    expires_at         text NOT NULL,
    created_at         text NOT NULL,
    UNIQUE (canonical_event_id, person_id, action)   -- issuing again REPLACES: rotate on resend
);
```

**Responses are not change_log rows (rc12).** `change_log` is the revision history of an
event's *fields*, keyed `UNIQUE(canonical_event_id, revision)` — that key is what serialises
concurrent edits (§11). Writing a vote, an attendance change or a feedback note there would
bump the revision on every response, turning each one into an edit conflict for whoever is
editing the event at that moment. So responses live in their own attributed rows
(`slot_response`, `event_participation.attendance` + `responded_at`, `event_feedback`), each
carrying actor and time; lifecycle transitions that change the event — confirming a poll's
time, and in 2E accepting a proposal — remain change_log rows. The UI presents both as one
attributed trail (WORKFLOWS §3's "one UI list, one attribution trail" is kept at the view,
not the table).

### Response requests, change proposals and series (rc13 — MVP-2 slice 2E)

**Response requests.** When creating an event the organizer may ask individual participants
to **agree** (`response_kind = 'accept'`) or to **acknowledge** (`'ack'`); everyone else is
`'none'` (or `'slot_vote'` on a poll). `response_state` holds the answer:

| kind | states |
|---|---|
| `accept` | `pending` → `accepted` \| `declined`; after a material change: `reack` |
| `ack` | `pending` → `acknowledged`; after a material change: `reack` |

`response_state` has no CHECK constraint (the column predates these values, and SQLite can't
add one without a rebuild — §16); the app validates it with zod at the boundary.

Lifecycle, WORKFLOWS §5 as built:
- An event with **any** `accept` participant is created `proposed`; it becomes `scheduled` when
  the last of them accepts, and `declined` the moment one declines. Its creator may **withdraw**
  it while it is `proposed`. With no `accept` participant it is `scheduled` at once (§5 "skip
  straight to scheduled").
- `ack` never gates: the event exists immediately; the request is a "needs your
  acknowledgment" flag, and the organizer sees "seen ✓" with its time (US-4).
- A **material change** to a `scheduled` event — time, date or location; *not* the title or the
  notes (WORKFLOWS §10, owner default) — applies immediately (last-write-wins, US-7 MVP) and
  sets every `accepted` / `acknowledged` participant back to `reack`.
- **Cancel / restore** (US-9): editors move `scheduled → cancelled` and back, attributed in
  change_log. `desired()` already makes `cancelled` Absent; the grace-period "CANCELLED:" title
  is a sync-side policy and arrives with MVP-4.
- Every transition that changes the event (accept-to-schedule, decline, withdraw, cancel,
  restore, confirm) is a change_log row; the answers themselves are participation state
  (rc12).

**Link actions name the phase, not the widget.** `response_token.action` keeps its two values
(no table rebuild): `vote` answers a *proposed* event — slot votes on a poll, accept/decline on a
consent proposal — and `attend` answers a *scheduled* one — attendance and acknowledgment.

**Change proposals (the `propose` tier).** A `propose` participant's edit does not apply; it
becomes a pending proposal an `edit` participant accepts or rejects:

```sql
CREATE TABLE event_change_proposal (       -- MVP-2 slice 2E-2
    id                 text PRIMARY KEY,   -- UUIDv7
    canonical_event_id text NOT NULL REFERENCES canonical_event(id),
    proposed_by        text NOT NULL REFERENCES person(id),
    base_revision      integer NOT NULL,   -- the revision the proposer saw
    fields             text NOT NULL,      -- JSON: the full proposed field set
    status             text NOT NULL,      -- pending | accepted | rejected | withdrawn | superseded
    decided_by         text REFERENCES person(id),
    decided_at         text,
    created_at         text NOT NULL
);
```
Accepting applies the fields through the ordinary optimistic edit at `base_revision`; if the
event moved on since, the proposal is `superseded` and the proposer is told — never silently
merged. The inbound-sync path (§11) reuses this table in MVP-4.

**Series.** Events may carry an RRULE from the supported subset (`src/recurrence.ts`), created
and edited as a whole series; pages show the next occurrences. Editing a single occurrence stays
parked behind the `event_override` seam (WORKFLOWS US-8: swaps are ordinary events).

**History attribution (owner decision, 2026-10-17).** Each history entry names its author to
every tier that can see the event, including `DETAILS` and `BUSY`, which don't see the
participant list: attribution is the product. What an entry *changed* is still filtered per
tier (§9 visibility integrity).

The two tier columns are deliberately independent: a D&D player is `view` + `FULL` (sees everything, cannot reschedule); a grandparent is `view` + `BUSY`; a co-parent is `propose` or `edit` + `FULL`. Every tier, including `view`, can acknowledge, state attendance and leave feedback — "decided by the organizer" never means "participants have no voice".

---

## 11. Core reconcile loop

**Worker tick (runs on a schedule; see §12 poll-first):**

```
for each calendar_connection:
    PULL: changes, new_cursor = provider.list_changes(connection.sync_token)
          (on cursor-expired error -> full resync)
    for each changed provider_event in changes:
        classify_and_apply(connection, provider_event)   # see below
    connection.sync_token = new_cursor

for each projection where state in ('pending_create','pending_update','pending_delete')
                       or (state = 'error' and retry_at <= now()):
    PUSH: reconcile_projection(projection)               # see below
```
(The selector must respect `retry_at` — scanning plain `state != synced` would re-hammer every
errored projection each tick, defeating the §12 backoff.)

**PUSH — `reconcile_projection`:**
```
if projection.state == 'pending_delete':
    provider.delete(projection.provider_event_id)        # 404/410 = already gone -> still success
    projection.state = 'deleted'
    return

# Crash-window recovery: if we're about to CREATE (no provider_event_id) it is possible a
# previous tick crashed after the provider accepted the write but before we stored result.id.
# Blind create would duplicate the event. So first look for an orphan by identity metadata:
if projection.provider_event_id is None:
    existing = provider.find_by_metadata(canonical_uid=canonical_event.id)   # Google:
    if existing: adopt it (store id/etag) instead of creating                # privateExtendedProperty
# (This is lookup by explicit identity, not fuzzy matching — consistent with §3.4.)

fields = project(canonical_event, projection.visibility_profile)   # FULL = identity in MVP
h = hash(fields)
if h == projection.last_pushed_hash and projection.state == synced:
    return                                   # already matches -> no-op (idempotency)
nonce = new_nonce()
result = provider.upsert(
    projection.provider_event_id, fields,
    metadata={canonical_uid: canonical_event.id, write_nonce: nonce},
)
projection.provider_event_id = result.id
projection.provider_etag     = result.etag
projection.last_pushed_hash  = h
push nonce onto projection.recent_write_nonces (keep last ~5)
projection.base_revision     = canonical_event.revision
projection.state             = 'synced'
```
*PUSH never decides whether a mirror should exist.* Existence comes from the desired-state policy (§10 deletion model) setting projection states; reconcile only converges to them. This keeps deletion semantics swappable without touching this loop.

**PULL classification — `classify_and_apply`:**
```
if provider_event.recurring_event_id is not None:
    return            # an INSTANCE of a recurring series. In Google, instances inherit the
                      # series' extendedProperties, so the canonical_uid lookup below would
                      # succeed and a per-instance tweak would be misapplied as a series edit.
                      # MVP: skip + log 'skipped_instance_edit' (§14). The designed upgrade is
                      # NOT cleverer sync-loop handling — it's accepting the edit as a row in
                      # event_override / an EXDATE (§10), at which point this branch routes
                      # there instead of returning.

uid = provider_event.metadata.get(canonical_uid)
if uid is None:
    return            # native event we don't manage (unless this connection imports natives - future)
projection = lookup(uid, connection)

if provider_event.is_deleted:
    append change_log fact: removed_from_calendar(actor=connection)
                                             # attribution is MVP scope — an external delete is a
                                             # "who changed what" event like any other
    interpret via desired-state policy (§10 deletion model):
        default policy -> unsubscribe (projection.state = 'deleted')
        a stricter policy may instead restore (mark pending_update -> next PUSH recreates)
    # Either way: NEVER delete canonical or sibling projections
    return

if is_echo(provider_event, projection):      # see echo detection
    refresh stored etag/markers; return      # our own write reflected back

# genuine external edit:
if projection not editable (read-only profile/role):
    leave as pending_update -> next PUSH reverts it      # or surface as proposal (future)
    return
apply_inbound_edit(projection, provider_event)           # -> conflict resolution + canonical update
```

**Echo detection (3 layers, cheapest first) — `is_echo`:**
1. **Write-nonce:** read-back nonce ∈ `projection.recent_write_nonces` → echo.
2. **ETag:** provider etag == `projection.provider_etag` → echo.
3. **Content hash:** hash(incoming fields normalised to our set) == `projection.last_pushed_hash` → echo.
Any one true → suppress.

*Why a nonce **ring**, not a single nonce:* two pushes in quick succession (content A then B) can deliver the notification for A *after* B's bookkeeping has overwritten the stored nonce, etag, and hash. With a single nonce, all three layers miss, the stale read-back of A is classified as an external edit, canonical flips back to A, reconcile re-pushes A… and the system oscillates. Membership in a small ring of recent nonces suppresses these stale echoes; layer 3 stays a fallback for notifications where the provider strips metadata.

**Concurrency & failure windows:**
- **One writer per connection — structural, not locked.** SQLite has no row locks and D1 no interactive transactions, so serialization is architectural (§6): on Cloudflare, a **Durable Object per `calendar_connection`** owns every PULL/PUSH for that connection and its `retry_at` alarms — and holds **no domain data** (§16); on Node, the single scheduler process provides the identical guarantee. Overlapping ticks are impossible by construction, not prevented by locks.
- **Regular ticks are cron fan-out; DO alarms are for retry backoff ONLY.** Each `setAlarm()` bills as a row written — alarm-per-tick polling would spend the entire free-tier daily write budget on scheduling. The cron handler fans out to connection DOs; an alarm is set only when a projection enters `error` with a `retry_at`.
- **Optimistic canonical updates.** Bump revisions with `UPDATE … SET revision = revision + 1 WHERE id = :id AND revision = :expected`; on zero rows, re-read and retry. Pairs with the `change_log` UNIQUE constraint (§10) to serialize history.
- **Batch atomicity.** Commit `connection.sync_token = new_cursor` in the same statement-list `batch()` as that batch's inbound applies — the platforms' shared unit of atomicity. A crash mid-batch then re-delivers the whole batch — which is safe because:
- **Inbound apply is idempotent too.** Re-applying an inbound edit whose fields already match canonical must be a no-op (empty diff → no revision bump, no change_log row). Same convergence invariant as PUSH, in the other direction.
- **Steady-state ticks write nothing.** A fully-synced projection takes the no-op path without touching storage. On D1's free tier the daily write budget is the scarce resource: this is the §6 economic invariant, enforced by the §9 zero-write property.

**Inbound edits are gated by the editor's edit tier** (rc7; WORKFLOWS §3). The `projection not editable` branch above generalises to the owner of the projection's connection:
- **`edit`** → `apply_inbound_edit` (below).
- **`propose`** → the edit becomes a *proposal* (WORKFLOWS §5 lifecycle) attributed to them; their mirror is marked `pending_update` so the next PUSH reverts it to canonical until the proposal is accepted. They receive a token-link email: "proposed — waiting for …".
- **`view`** → mirror marked `pending_update` (revert); they receive "this change wasn't applied — leave feedback → [link]". A *silent* revert is not acceptable: it reads as the app being broken.
In every case the inbound change is a change_log fact (actor = the connection's person). Deletion is unaffected by tier: an inbound delete is always an unsubscribe for that person only (§10 deletion model).

**Inbound edit / conflict (`apply_inbound_edit`):** map provider fields → canonical. MVP policy: **last-write-wins**. Designed-in upgrade path: the incoming edit is based on `projection.base_revision`; if canonical advanced and the changed fields don't overlap, fast-forward merge; only true same-field collisions need a tiebreak. On accept: bump `canonical_event.revision`, append a `change_log` row (actor, source, field-level diff), then let reconcile drive all *other* projections.

---

## 12. Google integration constraints

- **Scopes:** `https://www.googleapis.com/auth/calendar` and `.../auth/calendar.events`. These are **sensitive** (lighter than restricted): public use needs OAuth/brand verification (consent screen + demo video) but **not** the CASA security assessment.
- **MVP stays in "testing" mode:** your own OAuth client, ≤100 test users → no verification, no cost. **Gotcha:** in testing mode refresh tokens expire after **7 days**. Mitigation: re-consent occasionally for the tiny private group, or flip the app to unverified "production" (users click through the warning screen) for long-lived tokens.
- **Poll-first:** no webhooks in MVP. Poll each connection (~60 s) — trivial load for a handful of users, and no need for a public webhook endpoint or channel renewal. The `watch` method on the provider port is the later upgrade; it triggers the same `list_changes`. (On Cloudflare the calculus shifts: inbound HTTP is the cheap native primitive while polling spends cron + D1 ops — expect `watch` to be pulled forward there. Prerequisites when it lands: a channel-renewal alarm (~weekly expiry), a Search-Console-verified **custom domain** for the push endpoint — `whendowe.org` qualifies once verified; `workers.dev` does not — and **validation of the channel id/token on every notification** plus per-channel rate limiting: forged pokes can't corrupt data (identity + echo layers hold) but each one triggers a quota-burning `list_changes`, so unauthenticated pokes are a DoS vector.)
- **Incremental sync:** use `events.list` sync tokens. On `410 GONE` (token expired), do a full resync — which is **not** just "replay everything": deletions that occurred while the cursor was dead never appear as `is_deleted` changes. Full resync = list all events, classify each as usual, **and** diff the other direction: any live projection on this connection whose `provider_event_id` is absent from the listing has been deleted provider-side → route it through the same inbound-deletion handling in §11. (Note: Google's `privateExtendedProperty` filter needs an exact key=value, so "list managed events" can't be wildcarded — list all, partition by presence of `canonical_uid` in the returned metadata.)
- **Provider metadata:** stamp canonical UID and write-nonce into `extendedProperties.private` (`canonical_uid`, `write_nonce`). Note: `events.list` supports filtering by `privateExtendedProperty` — this is what makes the duplicate-create recovery in §11 possible.
- **Rate limits & retries:** on 429/`rateLimitExceeded`/5xx, exponential backoff with jitter inside the tick; after N attempts set `state='error'` + `last_error` + `retry_at` (capped backoff). Error projections are retried from `retry_at`, never dropped — convergence includes recovering from transient provider failure. Hard 4xx (invalid field, revoked token) should not retry blindly; a revoked/expired grant sets `connection.status='auth_error'` (the worker then skips that connection's projections) and surfaces in the UI for reconnect.

---

## 13. Security & privacy

- **Encrypt OAuth tokens at rest** (the `*_enc` columns) with WebCrypto AES-GCM — key from env/wrangler secret, never committed, and **never stored in D1** (Time Travel keeps 30 days of DB history; the backups must not contain the safe *and* its combination). Version-prefix ciphertexts (key id byte) so key rotation needs no migration. The refresh tokens are the crown jewels: whoever can read prod secrets can read every user's calendar — which is why the deployments repo (§18) is **credential-human-only**, 2FA-enforced, minimal-membership. The boundary that matters is *credential access*, not repository write access: secrets, API tokens and Environment approvals are the owner's alone, and no agent ever holds a provider credential. Instance *configuration* may be authored by an agent as a PR and merged by the owner, reviewed exactly as product changes are — CI reads credentials from Environment secrets the agent cannot see. An agent that can propose a config diff but never read a token does not widen the blast radius this rule exists to contain.
- **OAuth flow:** validate `state` on the callback (login-CSRF) and use PKCE. Agents reliably forget `state`; it is gate-worthy.
- **Token links (the account-less surface, WORKFLOWS §2/§9):** the link is the identity, so: single-purpose scope (one action × one event × one person), short expiry, invalidate-on-use for one-shot actions, rotate on resend. (rc12, as built in `response_token`: only the SHA-256 is stored; vote and attend links are *re-answerable* rather than one-shot — people change their minds — so they live until expiry (14 days) or until the action closes, e.g. a poll is confirmed; re-issuing replaces the row, killing the old link; a link never creates a session or an account; the person's tier is re-checked on every use, so removing someone from an event kills their links too.) **GET never mutates** — the link renders a page; the action is a POST button (email security scanners follow every link and would otherwise "respond" on the user's behalf). Never log URL query strings.
- **All calendar content is untrusted input, both directions.** Inbound titles/descriptions are authored by arbitrary calendar-sharers: escape on HTML render (no raw HTML from event fields), and escape per **RFC 5545 TEXT rules when serializing ICS** — an unescaped newline in a title is a forged `ORGANIZER:`/`ATTENDEE:` line in the feed. Feeds are serializers with injection semantics.
- **Visibility tiers are an authorization system**, not presentation: the §9 visibility-integrity property must hold at the web/view-model layer too. Every event/response route authorizes against the requester's participation row; view-models are built per-tier. `/event/{id}` returning FULL fields to any authenticated person is an IDOR, not a styling bug.
- **Sessions & CSRF:** cookies HttpOnly + Secure + SameSite=Lax; CSRF tokens on all HTMX mutations.
- **Deletion promise includes the backup tail:** purge (§10 deletion model) plus D1 Time Travel's 30-day history window — state this in the privacy policy rather than over-promising instant erasure.
- **Outbound mail is capped in the app, not trusted to the bill** (rc9, owner decision). Provider: Cloudflare Email Service (Workers Paid: 3,000/month included, then metered; no provider-side hard spend cap). Every send first reserves a slot with ONE atomic statement — insert only if today's and this month's counts are under their caps — and sends only if a row came back. A count-then-send check would race across concurrent Workers isolates and overshoot. Defaults sit under the included allowance (200/day, 2,500/month), so the default configuration cannot incur overage; a reached cap refuses the send loudly rather than queueing it. Slots count *attempts*, so a failed send still consumes one — conservative by design. Mail is sent from the `notify.` subdomain so automated mail never shares reputation or SPF lookups with the apex domain's human mail.
- **Config via env**, parsed and validated by a zod schema (`src/config.ts`); `.env.example` documents keys with no real values; on Cloudflare, secrets via `wrangler secret`.
- **Least scope:** request only the calendar scopes actually used.
- **Data deletion path:** support deleting a connection and purging its data (Google's user-data policy requires deletion on request; also just correct).
- **Logging hygiene:** do not log event titles/descriptions or tokens at info level (see §14).

---

## 14. Observability

- **Structured logging.** Every reconcile decision logs a reason: `pushed`, `skipped_unchanged`, `echo_suppressed`, `inbound_applied`, `inbound_delete_unsubscribed`, `skipped_instance_edit`, `adopted_orphan`, `retry_scheduled`, `error` — with ids, not event content. This vocabulary should map 1:1 onto the `Action` ADT (§9): every decision the pure core can make is a loggable reason, so the logs are a trace of decisions, not prose.
- The **`change_log` is the audit trail**; it also backs the "who changed this" UI later. No separate audit system needed for MVP.

---

## 15. Implementation roadmap

- **M0 — Bootstrap.** Repo (project renamed — §17), LICENSE, skeleton (§8), `npm run check` green on an empty skeleton, CI running the gate with the both-drivers contract matrix, and **both deploy targets boot a hello page** (`wrangler dev` and `docker compose up`). Proving the dual-deploy seam is M0 scope — it is the riskiest assumption and the cheapest moment to test it. (Agent starts here.)
- **M1a — Google connect & read** *(done, rc7)*. OAuth connect (PKCE, state, encrypted flow cookie, encrypted token storage), `listChanges` + event mapping, the recurrence spike (soak-verified). The original M1 clause "materialise canonical events" is withdrawn: canonical events are *created in WhenDoWe*, and importing a person's native events stays deferred (§2, §11).

**Re-sequenced people-first (rc7).** Rationale: canonical events need people and a UI to exist before a sync engine has anything to sync, and a usable app is easier to conceptualise and show than a sync engine without one. Each milestone ends in something a person can use; acceptance tests in WORKFLOWS §4.

The new milestones are labelled **MVP-1…MVP-5**, deliberately *not* reusing M2–M5: roughly 70 existing references in these docs and in code comments ("upsert lands in M2") mean the original milestones, and renumbering would have made every one of them silently wrong. They stay valid via this mapping:

| original | meaning | now |
|---|---|---|
| M1 | Read | **M1a** (done); "materialise" withdrawn |
| M2 | Project, one-way | **MVP-4** |
| M3 (M3a/M3b) | Manage: people, UI, responses | **MVP-1** + **MVP-2** |
| M4 | Bidirectional | **MVP-5** |
| M5 | Hardening | after the MVP |


- **MVP-1 — People.** `person`, magic-link login, sessions + CSRF, groups, email invites; the mail port with a console adapter for development and an HTTPS provider for real use. Email deliverability (SPF/DKIM/DMARC, `whendowe/deployments`) is a *blocker* here, not polish. One person per verified email address — a later "Sign in with Google" with the same address must land on the same person. Closes the M1a gap where the connect route has no authenticated owner. *Accept: a D&D group exists (US-14).*
- **MVP-2 — Events & responses.** Create/edit events (single + whole-series), per-person edit and visibility tiers, the proposal lifecycle, accept / acknowledge / slot vote / attendance / feedback by token link, the change log visible in the UI. *Accept: "when do we play?" is answered without anyone installing anything.* Slices: 2A domain · 2B event pages · 2C polls · 2D account-less responses · 2E-1 agreement & acknowledgment requests, cancel/restore · 2E-2 change proposals (propose tier) · 2E-3 recurring series.
- **MVP-3 — Feeds & sharing.** Read-only ICS feed per person and per group (the §5 artifact-store seam's first driver; Google polls subscribed feeds slowly — hours — which is stated to users, not hidden); unlisted and invite-only views; `project()` tiers enforced in every output (§9 visibility integrity becomes load-bearing). *Accept: a player subscribes from an iPhone.*
- **MVP-4 — Google one-way.** "Sign in with Google" (basic profile scopes only — must not consume the sensitive-scope user cap, §12), calendar connection as a *separate*, opt-in grant, token refresh, the reconcile loop and PUSH (§11). *Accept: the owner's household lives on it.*
- **MVP-5 — Google two-way.** PULL classification, echo detection, tier-gated inbound edits (§11), inbound deletes as unsubscribe, conflict policy, 410 full resync with the reverse diff. *Accept: a member moves an event in Google and the group follows or receives a proposal (US-15).*
- **→ Public MVP: the first ~100.**
- **Later:** Microsoft Graph and CalDAV two-way; Google OAuth verification (required before user 101 — start it before it is needed); hardening of whole-series recurrence end to end.

After the MVP, per-instance overrides are "start accepting rows into `event_override`/`exdates`" (no migration), and the first *sourcing* feature (subscribe-and-import an ICS feed) and first *sharing* feature (emit a read-only ICS feed) are each one adapter plus serialization of an already-5545-shaped canonical.

---

## 16. Non-goals & anti-patterns (hard constraints — do NOT do)

- **No event-driven push.** Reconcile/desired-state only.
- **Never identify events by title/time.** Identity is the canonical UID in `extendedProperties`.
- **A mirror deletion must never cascade** to deleting the canonical event or sibling projections — it's an unsubscribe.
- **No per-instance recurrence overrides** in MVP (whole-series + single events only). The *schema* for them exists (`event_override`, `exdates` — §10) as a seam; it stays empty. The constraint is behavioral: no code path writes it yet.
- **No multi-tenant / OAuth-verification path** in MVP. *Multi-person* is MVP scope (§2); multi-*tenant* means orgs, seats and admins over people (BUSINESS §6) and is not. Isolation between unrelated groups comes from participation — you see an event because you participate in it — not from a tenant id.
- **No provider-specific concept in domain code.** Google is the first two-way provider, not the model. Identity metadata, sync cursors, and change classification go through the `CalendarProvider` port in provider-neutral terms, so Microsoft Graph and CalDAV are new adapters, never a refactor (§5). Google-only shortcuts belong in `src/providers/google*.ts` alone.
- **No business logic in views/templates.** Build a typed (zod) view-model; views only render its fields.
- **Compute the push hash over the FILTERED fieldset**, per projection — not over raw canonical (matters once profiles exist).
- **One recorded exception to expand/contract (rc11): migration 0005 rebuilds `canonical_event`** to widen its status CHECK, which SQLite cannot alter in place. It is safe for exactly one reason: **no instance has ever been deployed**, so no data and no running version depend on the old shape. The moment a first instance is deployed, the additive-first rule binds without exception — a later change of this kind ships as a new column plus a contract step, never as a rebuild.
- **Migrations are plain `.sql` files** — applied identically by `wrangler d1 migrations` and the Node runner; no programmatic migrations, ever.
- **The storage port is async-only, SQLite-dialect-only, and uses no D1-exclusive features** in domain code; better-sqlite3's sync API never leaks past its driver.
- **Durable Objects hold no domain data** — serialization + alarms only; all state lives in D1/SQLite.
- **A steady-state reconcile tick performs zero writes** (§6 economics, §9 property). Corollary: regular ticks are scheduled by cron fan-out, never by per-tick DO alarms (each `setAlarm` bills as a write — §11).
- **No platform imports in domain code** — `deploy/` adapters are the only platform-aware files.
- **No new dependency** without a one-line justification; keep the surface small. PBT library usage is confined to `tests/` (Hegel primary, fast-check fallback — §6).

---

## 17. Open decisions (owner: you)

- ~~Project name~~ — **resolved: WhenDoWe** (`whendowe.org`, `github.com/whendowe/whendowe`). It states the product's question. M0 pre-flight: verify `whendowe.org` in Google Search Console now (needed later for the OAuth consent screen branding and the push-notification endpoint — §12) and reserve the `whendowe` npm name.
- **Confirm AGPL-3.0** vs Apache-2.0 vs open-core (§7).
- ~~Single-user MVP vs multi-account~~ — **resolved (rc7): multi-person from MVP-1** (WORKFLOWS §9 delta 1), magic-link login first and "Sign in with Google" when Google arrives (MVP-4). Not multi-tenant (§16).
- ~~Deploy/hosting target~~ — **resolved (§6):** dual-target intersection contract; Cloudflare free tier hosts the primary instance, Node/Docker is the self-host build. Both are gate-verified from M0.
- **Recurrence expansion approach** — rrule.js-floating + temporal-polyfill (default) vs hand-rolled expansion of the validated subset. Decide via the M1 spike against the §9 DST/round-trip properties; pin before M2.
- **Deletion UX** — instant vanish vs visible-cancelled grace period vs trash-with-restore vs per-calendar unsubscribe presentation. *Safely deferred:* it's a desired-state policy + UI choice (§10 deletion model), not a data-model decision. Experiment in M3 without migrations.

---

## 18. Delivery & agent operations (GitOps)

**Two repos: product vs instances.**
- **`whendowe/whendowe` — the product (public-ready from commit one).** App, deploy *adapters* (wrangler template, Dockerfile, compose), migrations, CI. Its CI **never deploys — it publishes**: green gate → versioned artifacts (`ghcr.io/whendowe/whendowe:<tag>`, tagged releases). Nothing instance-specific ever enters this repo or its history: no account/database IDs, no zones, no secrets (history is forever; it will be open-sourced). Schema + code stay one atomic PR because migrations live here, with the code.
- **`whendowe/deployments` — private instance registry (GitOps).** One directory per instance (`staging/`, `prod/`, later `customer-x/`): a product **version pin** + instance identity (vars, D1 ids, domain) + secret references. Its CI performs migrate-then-deploy against the instance's target. Promotion = PRs changing pins: staging auto-bumps via bot PR on new builds; production is an owner-reviewed pin change (the Environment approval lives here). **A new paid deployment — on-prem bundle or dedicated Cloudflare account — is one new directory**, which is the commercial on-prem story (BUSINESS §3 line 2) made operational.

Privilege separation inside the product repo remains: branch protection (no direct pushes to `main`, owner included) and **CODEOWNERS** on the verifier surface. Issues + Actions in the product repo orchestrate *development*; the deployments repo orchestrates *operation*.

**Protect the verifier, delegate the doer.** Agents may merge anything on green CI *except* changes to the things that define "green": `tests/property/**`, `.github/workflows/**`, `migrations/**`, `AGENTS.md`, and the design docs require owner review (CODEOWNERS). This is the load-bearing human-in-the-loop control for agent-driven development: the failure mode is not bad code (the gate catches it) but a weakened gate.

**Pipeline (git is the only deploy path):**
- Product repo: PR → `npm run check` (CI matrix, both storage drivers) → merge to `main` → **publish** build artifacts. Tag `v*` → release artifacts. No deploy step exists here.
- Deployments repo: bot PR bumps `staging/` pin on each main build → auto migrate-then-deploy to staging (staging subdomain of whendowe.org). `prod/` (and `customer-*/`) pins change only via owner-reviewed PRs. Rollback = revert the pin (Workers versions provide the fast path).
- Self-hosters need neither repo's CI: they pin `ghcr.io/whendowe/whendowe:<tag>` in the published compose file — that is their GitOps.
- **No dashboard configuration, ever.** `wrangler.jsonc` + `migrations/` are the sole truth; resource bootstrap (D1 create, R2 bucket, DNS) lives in an idempotent documented script in `deploy/cloudflare/`. No drift because there is no second author.
- **Migrations are expand/contract** (migration and deploy are not atomic on D1): additive first, code second, destructive cleanup only when no running version needs the old shape. Append-only; never edit an applied migration.

**Environment parity:** the devcontainer is the canonical toolchain for the owner, contributors, and cloud agents alike (also solves Hegel's Linux/macOS-only constraint). Dependency updates via Renovate with grouped PRs **and a minimum-release-age cooldown (~7 days)** — never auto-ingest a package in its first, most-likely-compromised hours; gate-relevant packages (Hegel, vitest, wrangler, drizzle) route through CODEOWNERS. `.npmrc` sets `ignore-scripts=true` (kills the dominant npm-worm vector). GitHub secret-scanning push protection on from day one; gitleaks in CI. The Cloudflare API token in CI is least-privilege: this Worker + this D1 only. **Agent privilege model:** any agent exposed to external content (public issues, PRs from strangers — adversarial input by definition once the repo is public) runs with repo-write at most: no secrets, no deployments-repo access, ever. The CODEOWNERS-protected verifier is the backstop against a socially-engineered agent.
