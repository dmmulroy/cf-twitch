# AGENTS.md

Instructions for AI coding agents working with this codebase.

**Generated:** 2026-01-14
**Change:** uxoyxrql (jj)

## Overview

Twitch stream integration platform on Cloudflare Workers. Manages OAuth tokens, stream lifecycle, song requests, achievements, and raffle systems via Durable Objects.

## Structure

```
cf-twitch/
├── apps/
│   ├── api/                  # Main worker (cf-twitch-api)
│   │   ├── src/
│   │   │   ├── index.ts      # Entry + DO/WF/Service exports
│   │   │   ├── durable-objects/  # DO implementations
│   │   │   ├── lib/          # Shared utilities
│   │   │   ├── routes/       # Route handlers (oauth.ts)
│   │   │   └── services/     # External API services
│   │   └── wrangler.jsonc
│   └── tail/                 # Error monitoring tail worker
├── docs/                     # Architecture docs, PRD
└── opensrc/                  # Vendored dependency source (gitignored)
```

## Where to Look

| Task               | Location                              | Notes                                     |
| ------------------ | ------------------------------------- | ----------------------------------------- |
| Add OAuth provider | `apps/api/src/routes/oauth.ts`        | Follow Spotify/Twitch pattern             |
| Create new DO      | `apps/api/src/durable-objects/`       | Export in index.ts, add to wrangler.jsonc |
| Add error type     | `apps/api/src/lib/errors.ts`          | Extend TaggedError                        |
| Environment vars   | `apps/api/wrangler.jsonc`             | Secrets in `.dev.vars`                    |
| DO stub utilities  | `apps/api/src/lib/durable-objects.ts` | getStub() for typed stubs w/ Result serde |
| Analytics          | `apps/api/src/lib/analytics.ts`       | writeDataPoint helper                     |

## Code Map

| Symbol              | Location                                 | Role                                                   |
| ------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `Env`               | `index.ts:15-53`                         | Environment interface (DOs, queues, services, secrets) |
| `app`               | `index.ts:55`                            | Hono app instance                                      |
| `default`           | `index.ts:65`                            | Worker export                                          |
| `queue`             | `index.ts:127-132`                       | Queue consumer (stub)                                  |
| `SpotifyTokenDO`    | `durable-objects/spotify-token-do.ts`    | OAuth token management                                 |
| `TwitchTokenDO`     | `durable-objects/twitch-token-do.ts`     | OAuth token management                                 |
| `StreamLifecycleDO` | `durable-objects/stream-lifecycle-do.ts` | Stream state, viewer tracking                          |

## Project-Specific Conventions

### Database / ORM

- **Drizzle ORM only** - all SQL uses Drizzle with `drizzle-orm/durable-sqlite` (official DO adapter)
- **Drizzle init**: `drizzle(this.ctx.storage, { schema })` - pass `DurableObjectStorage`, NOT `this.ctx.storage.sql`
- Define schemas in `schema.ts` files, use type-safe queries via `db.query.*`
- No raw SQL strings

### Error Handling

- **All errors extend `TaggedError`** from better-result
- Each error has `readonly _tag = "ErrorName"` discriminant
- **Type narrowing**: Use `MyError.is(error)` instead of `instanceof` for type guards
- **Errors as values**: Use `Result<T, E>` for ALL fallible operations - no throwing
- **Not found = error**: Return typed errors (e.g. `UserNotFoundError`) instead of `null` for missing data
- **RPC methods**: ALL public DO/service methods return `Result<T, E>`, use `Result.tryPromise()` for external calls
- **Caller side**: Use `getStub("DO_NAME")` from `lib/durable-objects.ts` - auto-hydrates Results and wraps errors in `DurableObjectError`

### Durable Object Patterns

- **ALL DOs extend `DurableObject<Env>`** from `cloudflare:workers` - required for RPC typing
- **Use `this.ctx` and `this.env`** - not `this.state`, base class provides these
- **Drizzle init**: `drizzle(this.ctx.storage, { schema })` - pass `DurableObjectStorage`, NOT `.sql`
- **ALL DOs use Drizzle ORM** with `drizzle-orm/durable-sqlite` - NEVER raw SQL
- **DO-to-DO calls use RPC methods**, NOT fetch - call `stub.myMethod()` directly
- **Use `getStub()`** from `lib/durable-objects.ts` for typed stubs with Result hydration + error handling
- **`blockConcurrencyWhile` in constructors**: Use `void this.ctx.blockConcurrencyWhile(...)` to mark intentional fire-and-forget
- **`DurableObjectNamespace<T>`** in Env interface - T must be the DO class for RPC methods to be typed
- Recreate stubs after infrastructure errors

### Services (Plain Classes)

- **External API calls** (Twitch Helix, Spotify) go through services (TwitchService, SpotifyService)
- **Services are plain classes** with `constructor(env: Env)` - NOT WorkerEntrypoint service bindings
- **Instantiate services directly**: `new TwitchService(this.env)` or `new SpotifyService(this.env)`
- **Services use `getStub()`** to call token DOs for authentication
- **DOs call services** via direct instantiation - never raw fetch to external APIs from DOs

### API Routes

- **All API routes use Hono** including worker entrypoint - no raw fetch handlers
- **Webhooks, REST, OAuth** all via Hono router

### Data Validation

- **Parse ALL external data with Zod** - never cast `as Type` at IO boundaries
- Response JSON, request bodies, OAuth responses, API responses - ALL parsed with schemas
- Use `z.parse()` or `z.safeParse()` - never type assertions on external data

### Timestamps

- **ISO8601 format** for all timestamps/dates (e.g., `2026-01-14T12:00:00.000Z`)
- Store as TEXT in SQLite, use `new Date().toISOString()` for generation

### Cloudflare Workers Types

- **No `@cloudflare/workers-types` package** - types auto-generated via `wrangler types`
- Run `wrangler types` after modifying `wrangler.jsonc` to regenerate `worker-configuration.d.ts`

### Linting & Formatting

- **oxlint** for linting, **oxfmt** for formatting (NOT biome/eslint/prettier)
- **Type-aware linting** via `oxlint-tsgolint` - uses `typescript-go` for type info
- Config files: `.oxlintrc.json`, `.oxfmtrc.json`
- **tsconfig compatibility**: No `baseUrl` - removed in TS 7+ / tsgolint
- Run `pnpm check` for full CI validation (lint + typecheck + format)

### TypeScript

- **No type assertions** (`as Type`, `as unknown as T`) - use proper typing or Zod parse
- **No `any`** - use `unknown` with narrowing or proper generics
- **No non-null assertion** (`!`) - handle nullability explicitly

## Anti-Patterns (This Project)

- **Raw SQL** in DOs - use Drizzle ORM (includes `this.sql.exec()`, `this.state.storage.sql`)
- **`as Type` casts** at IO boundaries - use Zod parse
- **`stub.fetch()`** for DO-to-DO - use RPC `stub.myMethod()`
- **Direct fetch** to Spotify/Twitch APIs from DOs - use services
- **if/else routing** in fetch handler - use Hono
- **INTEGER timestamps** - use TEXT with ISO8601
- **`throw` in RPC methods** - return `Result.err()` instead
- **`@deprecated` annotations** - refactor and delete old code, never deprecate

## CRITICAL: Pattern Violations (ACTIVE)

### fetch() Handlers in DOs

- **StreamLifecycleDO** (`stream-lifecycle-do.ts:268-329`) - Has `fetch()` handler with if/else routing
- Callers should use `stub.myMethod()` instead of `stub.fetch('http://do/path')`

### Type Casts at IO Boundaries

| File                     | Line     | Cast                                          | Notes          |
| ------------------------ | -------- | --------------------------------------------- | -------------- |
| `stream-lifecycle-do.ts` | 288      | `(await request.json()) as { count: number }` | Use Zod        |
| `stream-lifecycle-do.ts` | 162, 359 | `this.ctx.getWebSockets() as WebSocket[]`     | CF types issue |

### RPC Method Pattern (MOSTLY IMPLEMENTED)

- All public DO methods should return `Result<T, E>`, not throw
- **Token DOs**: Return `Result<string, TokenError>` from `getValidToken()` - DONE
- **SongQueueDO**: All public methods return `Result<T, E>` - DONE
- **StreamLifecycleDO**: `getStreamState()` returns Result, but lifecycle methods (`onStreamOnline`, `onStreamOffline`) return `Promise<void>` - PARTIAL

### Token DOs Direct Fetch (BY DESIGN)

- Token DOs call OAuth endpoints directly via `fetch()` for token refresh
- This is intentional - token refresh is a core DO responsibility
- Services fetch tokens via `getStub("TOKEN_DO").getValidToken()`

### Dead Code

| Location           | Item                                                                        | Status             |
| ------------------ | --------------------------------------------------------------------------- | ------------------ |
| `lib/errors.ts`    | `SpotifyError`, `TwitchError`, `ValidationError`, `InvalidSpotifyUrl`       | Defined but unused |
| `lib/analytics.ts` | `writeSongRequestMetric()`, `writeRaffleRollMetric()`, `writeErrorMetric()` | Defined but unused |

### Stub Code

| Stub                     | Location           | Status      |
| ------------------------ | ------------------ | ----------- |
| `SongQueueDO`            | `index.ts:72-76`   | Returns 501 |
| `AchievementsDO`         | `index.ts:78-82`   | Returns 501 |
| `KeyboardRaffleDO`       | `index.ts:84-88`   | Returns 501 |
| `SongRequestWorkflow`    | `index.ts:92-100`  | Throws      |
| `ChatCommandWorkflow`    | `index.ts:102-110` | Throws      |
| `KeyboardRaffleWorkflow` | `index.ts:112-120` | Throws      |
| Queue consumer           | `index.ts:127-132` | Just acks   |

### Infrastructure Issues

- **No CI/CD** - No `.github/workflows/`, manual deploy only
- **No tests** - No test framework configured
- **Outdated compatibility_date** - `2024-01-01` in wrangler.jsonc (~2 years old)
- **Redundant types package** - Has `@cloudflare/workers-types` despite using `wrangler types`

## Commands

```bash
pnpm dev              # Start local dev server (api worker)
pnpm deploy           # Deploy all apps to Cloudflare
pnpm typecheck        # Type check all apps
pnpm lint             # Basic linting
pnpm lint:types       # Type-aware linting
pnpm lint:all         # Type-aware + type-check (replaces tsc --noEmit)
pnpm fmt              # Format all files
pnpm check            # Full CI check (lint:all + fmt:check)
pnpm --filter cf-twitch-api run dev   # Dev specific app
wrangler types        # Regenerate worker-configuration.d.ts
```

## Notes

- **VCS**: Uses jj (Jujutsu), NOT git - check `.jj/` before VCS commands
- **Secrets**: Store in `.dev.vars` for local dev (gitignored)

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->
