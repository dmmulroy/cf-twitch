# API Worker

Main Cloudflare Worker for cf-twitch. See root AGENTS.md for conventions.

## Entry Point

`src/index.ts` - Hono app with DO/Workflow/Service exports.

## Routes

| Route          | Handler                    | Purpose               |
| -------------- | -------------------------- | --------------------- |
| `/oauth/*`     | `routes/oauth.ts`          | OAuth flows           |
| `/eventsub/*`  | `routes/eventsub-setup.ts` | EventSub registration |
| `/webhooks/*`  | `routes/webhooks.ts`       | Twitch webhooks       |
| `/api/*`       | `routes/api.ts`            | REST API              |
| `/api/stats/*` | `routes/stats.ts`          | Stats endpoints       |
| `/overlay/*`   | `routes/overlay.ts`        | Stream overlays       |
| `/health`      | inline                     | Health check          |

## Bindings (wrangler.jsonc)

| Binding               | Type      | Class                    |
| --------------------- | --------- | ------------------------ |
| `SPOTIFY_TOKEN_DO`    | DO        | `SpotifyTokenDO`         |
| `TWITCH_TOKEN_DO`     | DO        | `TwitchTokenDO`          |
| `STREAM_LIFECYCLE_DO` | DO        | `StreamLifecycleDO`      |
| `SONG_QUEUE_DO`       | DO        | `SongQueueDO`            |
| `ACHIEVEMENTS_DO`     | DO        | `AchievementsDO`         |
| `KEYBOARD_RAFFLE_DO`  | DO        | `KeyboardRaffleDO`       |
| `WORKFLOW_POOL_DO`    | DO        | `WorkflowPoolDO`         |
| `SONG_REQUEST_WF`     | Workflow  | `SongRequestWorkflow`    |
| `CHAT_COMMAND_WF`     | Workflow  | `ChatCommandWorkflow`    |
| `KEYBOARD_RAFFLE_WF`  | Workflow  | `KeyboardRaffleWorkflow` |
| `ANALYTICS`           | Analytics | -                        |

## Testing

```bash
pnpm test        # vitest run
pnpm test:watch  # vitest watch mode
```

Uses `@cloudflare/vitest-pool-workers` with `wrangler.test.jsonc`.

## Drizzle Migrations

Per-DO migration folders in `drizzle/`:

```bash
pnpm run db:generate  # Generate migrations for all DOs
```

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
