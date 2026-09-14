# CF Twitch

A Twitch integration built with Effect and Alchemy on Cloudflare Workers and HTTP-only Durable Objects.

## Capabilities

- Spotify song requests, occurrence-level attribution, Now Playing, request history, statistics, and an OBS overlay.
- Keyboard raffles with cryptographic draws, redemption deduplication, compensation, and leaderboards.
- Viewer achievements, request streaks, stream sessions, and recoverable announcements.
- Persistent chat commands with permissions, aliases, dynamic values, counters, and administration.
- Signed EventSub intake, durable song/raffle/raid workflows, and explicit uncertain mutation outcomes.
- Spotify/Twitch OAuth, one-use authorization state, durable credentials, and stream-aware token refresh.
- Event retries, dead letters, replay, stream reconciliation, analytics, and optional telemetry.

Public compatibility expectations are recorded in the [acceptance ledger](docs/capability-parity.md); generate the current API document with `pnpm inspect:api`.

## Work locally

Use the Node and package-manager requirements in [package.json](package.json). Install with `pnpm install --frozen-lockfile`. Dependencies are used without local patches.

For tests and verification, follow [verification](docs/verification.md). Those suites use controlled providers and require no live Twitch/Spotify credentials.

For interactive development:

```sh
cp apps/api/.env.example apps/api/.env
# Configure dedicated non-production provider applications and your Alchemy profile.
pnpm dev
```

Alchemy reads `apps/api/.env`; keep credentials out of Git. Development is a real integration: authorizing accounts and invoking mutations can affect those accounts. Register the exact `/oauth/spotify/callback` and `/oauth/twitch/callback` URLs with the provider applications. OAuth authorization requires `x-setup-secret`; administrator routes require `Authorization: Bearer <ADMIN_SECRET>`.

**Ready:** the development Worker serves `/health`, and the configured callback URLs match the provider registrations. Production remains blocked by the [cutover gate](docs/production-cutover.md).

## Source map

| Location                                                                   | Ownership                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/api/alchemy.run.ts`                                                  | Stack and deployment-stage boundary                                 |
| `apps/api/src/runtime/twitch-worker.ts`                                    | Worker composition and hosted namespaces                            |
| `apps/api/src/features/<capability>`                                       | Services, rules, persistence, HTTP servers/clients, colocated tests |
| `packages/contracts/src`                                                   | Portable schemas, branded identities, public contracts              |
| [packages/shared-infrastructure](packages/shared-infrastructure/README.md) | Stage policy and infrastructure descriptors                         |
| `apps/api/test`                                                            | Controlled-provider and cross-capability runtime verification       |
| `tools/architecture`, `tools/verification`                                 | Executable architecture and verification gates                      |

Agents start with [AGENTS.md](AGENTS.md), which routes each task to its governing documentation.
