# WhenDoWe

One canonical event, projected into many calendars — with attribution.

People maintain several overlapping shared calendars (co-parenting, partner,
extended family). An event relevant to more than one must be *copied*, edits
don't propagate, and there's no record of who changed what. WhenDoWe makes an
event exist **once** and projects it into many calendars, with edits propagating
and full change attribution.

## Status

**M0 — Bootstrap.** Skeleton, verification gate, and both deployment targets
booting a hello page. See `DESIGN.md` §15 for the roadmap.

## How it works (short version)

- A provider-agnostic **canonical event store** is the source of truth
  (RFC 5545-native: wall-clock + TZID, verbatim RRULE).
- A **reconcile loop** continuously converges every projection (one per
  event × calendar) toward what canonical says — desired-state reconciliation,
  never event-driven push.
- Identity is explicit: every mirror carries the canonical UID in provider-side
  hidden metadata. Change attribution lives in an append-only change log.

Read `DESIGN.md` for the full design; `AGENTS.md` for the contributor/agent
operating manual.

## One codebase, two deployments

| Target | Stack | Run |
|---|---|---|
| Cloudflare (hosted) | Workers + D1 + Durable Objects + Cron | `npm run dev:cf` |
| Self-host | Node 22 + SQLite in Docker | `docker compose -f deploy/node/docker-compose.yml up` |

Self-hosters pin a published image: `ghcr.io/whendowe/whendowe:<tag>`.

## Development

```sh
npm ci            # devcontainer recommended (Hegel requires Linux/macOS)
npm run check     # THE GATE: biome + tsc + vitest + workers-pool tests
npm run test:browser         # the browser tier, in the pinned Playwright image (podman/docker)
npm run test:browser:update  # same, rewriting the reference screenshots after a deliberate change
npm run dev:node  # Node target locally
npm run dev:cf    # Cloudflare target locally (wrangler dev)
```

`npm run check` must be green for every change — see `AGENTS.md` for the
Definition of Done and the rules around the verifier surface.

> **Note for NixOS hosts:** some dev tools ship dynamically-linked binaries
> (biome, workerd) that need a glibc environment — use the devcontainer, or run
> the gate in a container:
> `podman run --rm -v "$PWD:/work" -w /work --userns=keep-id docker.io/library/node:22-bookworm npm run check`

## License

[AGPL-3.0-or-later](LICENSE). WhenDoWe is open source; the network-use clause
keeps hosted forks open.
