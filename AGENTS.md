# AGENTS.md

Instructions for AI coding agents working with this codebase.

**Generated:** 2026-01-25
**Change:** pqzwzzno (jj)

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
│   │   │   ├── workflows/    # Workflow implementations
│   │   │   ├── services/     # External API services
│   │   │   └── __tests__/    # Vitest tests
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
| Add workflow       | `apps/api/src/workflows/`             | Use warm pool + cf-workflow-rollback      |
| Add route          | `apps/api/src/routes/`                | Hono router, mount in index.ts            |

## Code Map

| Symbol              | Location                 | Role                                   |
| ------------------- | ------------------------ | -------------------------------------- |
| `Env`               | `index.ts:26`            | Environment interface (extends CF.Env) |
| `app`               | `index.ts:28`            | Hono app instance                      |
| `default`           | `index.ts:53-55`         | Worker export                          |
| `SongQueueDO`       | `index.ts:59`            | Song request queue management          |
| `SpotifyTokenDO`    | `index.ts:60-61`         | Spotify OAuth token management         |
| `StreamLifecycleDO` | `index.ts:62-63`         | Stream state, viewer tracking          |
| `TwitchTokenDO`     | `index.ts:64`            | Twitch OAuth token management          |
| `KeyboardRaffleDO`  | `index.ts:65-66`         | Raffle system                          |
| `WorkflowPoolDO`    | `index.ts:67-68`         | Warm workflow pool management          |
| `AchievementsDO`    | `index.ts:69-70`         | Achievement tracking                   |
| `getStub()`         | `lib/durable-objects.ts` | Typed stub with Result deserialization |

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
- **`withResultSerialization()`** wrapper - ALL DO exports use this for RPC Result serialization
- Recreate stubs after infrastructure errors

### Workflow Patterns

- **Extend `WorkflowEntrypoint<Env, Params | undefined>`** - support warm pool pattern
- **Warm pool**: Use `waitForActivation()` helper, activated via `triggerWarmWorkflow()`
- **Rollback**: Use `cf-workflow-rollback` for saga pattern with compensating actions
- **Fulfilled = point of no return**: After Twitch redemption fulfill, no rollback possible

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
- **Zod v4** in use - some API differences from v3

### Timestamps

- **ISO8601 format** for all timestamps/dates (e.g., `2026-01-14T12:00:00.000Z`)
- Store as TEXT in SQLite, use `new Date().toISOString()` for generation

### Cloudflare Workers Types

- **No `@cloudflare/workers-types` package** - types auto-generated via `wrangler types`
- Run `wrangler types` after modifying `wrangler.jsonc` to regenerate `worker-configuration.d.ts`

### Linting & Formatting

- **oxlint** for linting, **oxfmt** for formatting (NOT biome/eslint/prettier)
- Config files: `.oxlintrc.json`, `.oxfmtrc.json`
- **Formatting**: Tabs, double quotes, 100 char width
- **Banned**: `any` (error), `!` non-null assertion (error)
- Run `pnpm check` for CI validation (lint + fmt:check)

### TypeScript

- **No type assertions** (`as Type`, `as unknown as T`) - use proper typing or Zod parse
- **No `any`** - use `unknown` with narrowing or proper generics
- **No non-null assertion** (`!`) - handle nullability explicitly
- **`noUncheckedIndexedAccess`**: Array/object access returns `T | undefined`

## Anti-Patterns (This Project)

- **Raw SQL** in DOs - use Drizzle ORM (includes `this.sql.exec()`, `this.state.storage.sql`)
- **`as Type` casts** at IO boundaries - use Zod parse
- **`stub.fetch()`** for DO-to-DO - use RPC `stub.myMethod()`
- **Direct fetch** to Spotify/Twitch APIs from DOs - use services
- **if/else routing** in fetch handler - use Hono
- **INTEGER timestamps** - use TEXT with ISO8601
- **`throw` in RPC methods** - return `Result.err()` instead
- **`@deprecated` annotations** - refactor and delete old code, never deprecate
- **`return null`** for not found - return typed error instead

## CRITICAL: Pattern Violations (ACTIVE)

### fetch() Handler in StreamLifecycleDO

- **StreamLifecycleDO** (`stream-lifecycle-do.ts:247-314`) - Has `fetch()` handler with if/else routing
- Callers should use `stub.myMethod()` instead of `stub.fetch('http://do/path')`
- Test file uses `stub.fetch()` because it's testing this legacy handler

### Type Casts at IO Boundaries

| File                     | Line     | Cast                                      | Notes          |
| ------------------------ | -------- | ----------------------------------------- | -------------- |
| `stream-lifecycle-do.ts` | 125, 410 | `this.ctx.getWebSockets() as WebSocket[]` | CF types issue |
| `twitch-service.ts`      | 721      | `response.json() as Promise<...>`         | Use Zod        |
| `song-request.ts`        | 128      | `trackId as string`                       | Narrow instead |

### AI TODO Comments (Pending Refactors)

| File                | Line | Note                                         |
| ------------------- | ---- | -------------------------------------------- |
| `webhooks.ts`       | 165  | Create Hono middleware for header validation |
| `webhooks.ts`       | 274  | Create smaller handler functions             |
| `twitch-service.ts` | 192  | Return StreamOfflineError not Ok(null)       |
| `eventsub-setup.ts` | 232  | Blocking await in for loop                   |
| `oauth.ts`          | 123  | Add static .fromEnv on all classes           |

### Token DOs Direct Fetch (BY DESIGN)

- Token DOs call OAuth endpoints directly via `fetch()` for token refresh
- This is intentional - token refresh is a core DO responsibility
- Services fetch tokens via `getStub("TOKEN_DO").getValidToken()`

## Commands

```bash
pnpm dev              # Start local dev server (api worker)
pnpm deploy           # Deploy all apps to Cloudflare
pnpm typecheck        # Type check all apps
pnpm lint             # Basic linting
pnpm fmt              # Format all files
pnpm check            # CI check (lint + fmt:check)
pnpm test             # Run vitest tests (api worker)
pnpm --filter cf-twitch-api run dev   # Dev specific app
wrangler types        # Regenerate worker-configuration.d.ts
```

## Notes

- **VCS**: Uses jj (Jujutsu), NOT git - check `.jj/` before VCS commands
- **Secrets**: Store in `.dev.vars` for local dev (gitignored)
- **No CI/CD**: Manual deploy only - no `.github/workflows/`

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
