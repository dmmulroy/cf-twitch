# AGENTS.md

Instructions for AI coding agents working with this codebase.

**Generated:** 2026-01-29
**Change:** qourukkm (jj)

## Overview

Twitch stream integration on Cloudflare Workers. Manages OAuth tokens, stream lifecycle, song requests, achievements, and raffles via Durable Objects with Drizzle ORM.

## Structure

```
cf-twitch/
├── apps/
│   ├── api/                  # Main worker (cf-twitch-api)
│   │   ├── src/
│   │   │   ├── index.ts      # Entry + DO exports
│   │   │   ├── durable-objects/  # DO implementations
│   │   │   ├── lib/          # Shared utilities
│   │   │   ├── routes/       # Hono route handlers
│   │   │   └── services/     # External API wrappers
│   │   └── wrangler.jsonc
│   └── tail/                 # Error monitoring tail worker
├── docs/                     # Architecture docs, PRD
└── opensrc/                  # Vendored dependency source (gitignored)
```

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Add OAuth provider | `apps/api/src/routes/oauth.ts` | Follow Spotify/Twitch pattern |
| Create new DO | `apps/api/src/durable-objects/` | Export in index.ts, add to wrangler.jsonc |
| Add error type | `apps/api/src/lib/errors.ts` | Extend TaggedError |
| Environment vars | `apps/api/wrangler.jsonc` | Secrets in `.dev.vars` |
| DO stub utilities | `apps/api/src/lib/durable-objects.ts` | getStub() for typed stubs |
| Analytics | `apps/api/src/lib/analytics.ts` | writeDataPoint helper |
| Saga pattern | `apps/api/src/lib/saga-runner.ts` | Step execution + compensation |

## Code Map

| Symbol | Location | Role |
|--------|----------|------|
| `Env` | `index.ts:15-53` | Environment interface |
| `app` | `index.ts:55` | Hono app instance |
| `SpotifyTokenDO` | `durable-objects/spotify-token-do.ts` | OAuth token management |
| `TwitchTokenDO` | `durable-objects/twitch-token-do.ts` | OAuth token management |
| `StreamLifecycleDO` | `durable-objects/stream-lifecycle-do.ts` | Stream state, viewer tracking |
| `SongQueueDO` | `durable-objects/song-queue-do.ts` | Song request queue + sync |
| `AchievementsDO` | `durable-objects/achievements-do.ts` | Achievement tracking |
| `KeyboardRaffleDO` | `durable-objects/keyboard-raffle-do.ts` | Raffle system |
| `SongRequestSagaDO` | `durable-objects/song-request-saga-do.ts` | 7-step saga orchestration |

## Project-Specific Conventions

### Database / ORM

- **Drizzle ORM only** - `drizzle-orm/durable-sqlite` adapter
- **Drizzle init**: `drizzle(this.ctx.storage, { schema })` - pass `DurableObjectStorage`, NOT `.sql`
- Define schemas in `schema.ts`, query via `db.query.*`
- No raw SQL

### Error Handling

- **All errors extend `TaggedError`** from better-result
- Each error has `readonly _tag = "ErrorName"` discriminant
- **Type narrowing**: `MyError.is(error)` not `instanceof`
- **Errors as values**: `Result<T, E>` for ALL fallible ops - no throwing
- **Not found = error**: Return `UserNotFoundError`, not `null`
- **RPC methods**: Return `Result<T, E>`, use `Result.tryPromise()` for externals
- **Caller side**: `getStub("DO_NAME")` auto-hydrates Results

### Durable Object Patterns

- **Extend `DurableObject<Env>`** from `cloudflare:workers`
- **Use `this.ctx` and `this.env`** - not `this.state`
- **Drizzle init**: `drizzle(this.ctx.storage, { schema })`
- **DO-to-DO**: RPC methods, NOT `stub.fetch()`
- **Use `getStub()`** for typed stubs with Result hydration
- **`void this.ctx.blockConcurrencyWhile(...)`** - mark fire-and-forget
- **`DurableObjectNamespace<T>`** in Env - T is DO class for RPC typing

### Services (Plain Classes)

- **External API calls** go through services (TwitchService, SpotifyService)
- **Plain classes**: `constructor(env: Env)` - NOT WorkerEntrypoint
- **Instantiate directly**: `new TwitchService(this.env)`
- **Services use `getStub()`** for token DO auth

### API Routes

- **All routes use Hono** - no raw fetch handlers
- Webhooks, REST, OAuth via Hono router

### Data Validation

- **Zod at ALL boundaries** - never `as Type` on external data
- `z.parse()` or `z.safeParse()` - no type assertions

### Timestamps

- **ISO8601 TEXT** - `new Date().toISOString()`
- Never INTEGER epoch

### Linting & Formatting

- **oxlint** for linting, **oxfmt** for formatting (NOT biome/eslint/prettier)
- **Type-aware linting** via `oxlint-tsgolint`
- Config: `.oxlintrc.json`, `.oxfmtrc.json`
- No `baseUrl` in tsconfig (removed in TS 7+ / tsgolint)

### TypeScript

- **No type assertions** (`as Type`, `as unknown as T`)
- **No `any`** - use `unknown` with narrowing
- **No non-null assertion** (`!`)
- **`noUncheckedIndexedAccess`: true** - array access returns `T | undefined`

## Anti-Patterns (This Project)

- **Raw SQL** in DOs - use Drizzle ORM
- **`as Type` casts** at IO boundaries - use Zod
- **`stub.fetch()`** for DO-to-DO - use RPC
- **Direct fetch** to external APIs from DOs - use services
- **if/else routing** in fetch handler - use Hono
- **INTEGER timestamps** - use TEXT ISO8601
- **`throw` in RPC methods** - return `Result.err()`
- **`@deprecated` annotations** - delete old code

## Active Violations

### fetch() Handler in DO

- **StreamLifecycleDO** (`stream-lifecycle-do.ts:247-314`) - Has `fetch()` with switch routing
- Should expose RPC methods directly

### Type Casts at IO Boundaries

| File | Line | Cast |
|------|------|------|
| `stream-lifecycle-do.ts` | 125, 394 | `as WebSocket[]` (CF types issue) |

### Dead Code

| Location | Items |
|----------|-------|
| `lib/errors.ts` | `SpotifyError`, `TwitchError`, `ValidationError`, `InvalidSpotifyUrl` |
| `lib/analytics.ts` | `writeSongRequestMetric()`, `writeRaffleRollMetric()`, `writeErrorMetric()` |

## Commands

```bash
pnpm dev              # Start local dev (api worker)
pnpm deploy           # Deploy all apps
pnpm typecheck        # Type check
pnpm lint             # Basic linting
pnpm test             # Run vitest (apps/api)
pnpm fmt              # Format
pnpm check            # Full CI (lint + fmt:check)
wrangler types        # Regenerate worker-configuration.d.ts
```

## Notes

- **VCS**: Uses jj (Jujutsu), NOT git
- **Secrets**: `.dev.vars` for local dev (gitignored)
- **Tests**: Vitest with `@cloudflare/vitest-pool-workers`
- **Test pattern**: `runInDurableObject(stub, callback)`

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies available in `opensrc/` for implementation details.

See `opensrc/sources.json` for available packages.

### Fetching Source Code

```bash
npx opensrc <package>           # npm (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python
npx opensrc crates:<package>    # Rust
npx opensrc <owner>/<repo>      # GitHub repo
```

<!-- opensrc:end -->
