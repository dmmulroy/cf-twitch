# AGENTS.md - apps/api

Main Cloudflare Worker serving Twitch stream integrations via Hono + 8 Durable Objects.

## Structure

```
src/
├── index.ts              # Entry, Hono app, DO exports with withResultSerialization
├── durable-objects/      # DO classes + schemas/ subdir
├── routes/               # Hono handlers (oauth, webhooks, api, overlay, stats)
├── services/             # SpotifyService, TwitchService
├── lib/                  # Utilities (errors, getStub, saga-runner, analytics)
└── __tests__/            # Vitest tests + fixtures/
```

## Where to Look

| Task | Location |
|------|----------|
| Add DO binding | `wrangler.jsonc` durable_objects + migrations |
| Test config | `wrangler.test.jsonc` (no script_name, test vars) |
| Vitest config | `vitest.config.ts` (poolOptions.workers) |
| Test fixtures | `__tests__/fixtures/` (spotify.ts, twitch.ts) |
| Global test setup | `__tests__/setup.ts` (fetchMock activation) |

## Testing

```bash
pnpm test                 # Run vitest
```

- Uses `@cloudflare/vitest-pool-workers` with miniflare
- **Pattern**: `runInDurableObject(stub, callback)` for DO tests
- **fetchMock**: Enabled globally, `disableNetConnect()` by default
- **Limitation**: Tests using `getStub()` skipped (needs env param refactor)

## Deployment

```bash
pnpm dev                  # wrangler dev (local)
pnpm deploy               # wrangler deploy
wrangler types            # Regenerate worker-configuration.d.ts
```

**DO Migrations**: Add to `migrations[]` in wrangler.jsonc with incrementing tag.

**Secrets**: Set via `wrangler secret put <NAME>` or `.dev.vars` locally.

<!-- opensrc:start -->
## Source Code Reference
Source code for dependencies available in `opensrc/` for implementation details.
See `opensrc/sources.json` for available packages.
### Fetching Source Code
```bash
npx opensrc <package>           # npm
npx opensrc pypi:<package>      # Python
npx opensrc crates:<package>    # Rust
npx opensrc <owner>/<repo>      # GitHub repo
```
<!-- opensrc:end -->
