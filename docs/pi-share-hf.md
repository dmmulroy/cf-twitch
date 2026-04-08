# Sharing pi sessions to Hugging Face

This repo is set up to use [`pi-share-hf`](https://github.com/badlogic/pi-share-hf) with:

- workspace: `.pi/hf-sessions/`
- local-only helper files: `.pi/hf-private/`
- image stripping enabled by default (`--no-images`)
- explicit review context files:
  - `AGENTS.md`
  - `docs/prd.md`
  - `docs/cf-prototype-architecture.md`
  - `docs/effect-twitch-architecture.md`

## Why this setup

This project uses real Twitch and Spotify OAuth credentials locally, and pi sessions may include OAuth flows, callback URLs, or dashboard screenshots. The default workflow therefore:

- redacts exact local secret values from `.envrc`, `.dev.vars`, and selected API key env vars
- blocks matching topics via `.pi/hf-private/deny.txt`
- disables image publishing by default
- gives the review model enough architecture context to distinguish cf-twitch work from unrelated sessions

## Prerequisites

Install the required tools:

```bash
npm install -g pi-share-hf @mariozechner/pi-coding-agent
brew install trufflehog
```

Authenticate with Hugging Face:

```bash
export HF_TOKEN=hf_xxx
```

## One-time setup

Initialize the local workspace:

```bash
pnpm share:init
```

By default this uses the dataset repo `dmmulroy/cf-twitch-pi-sessions`.

To override it:

```bash
PI_SHARE_HF_REPO=my-org/cf-twitch-pi-sessions pnpm share:init
```

Or, if you prefer a bare repo name plus organization:

```bash
PI_SHARE_HF_REPO=cf-twitch-pi-sessions PI_SHARE_HF_ORGANIZATION=my-org pnpm share:init
```

## Local helper files

### `.pi/hf-private/deny.txt`

Starter deny patterns are created automatically. Review and extend them before collecting sessions.

Good candidates to add:

- private project names
- customer or counterparty names
- tunnel domains
- private callback hosts
- any personal identifiers you do not want in a public dataset

### `.pi/hf-private/secrets.txt`

Generate the exact-secret list used for deterministic redaction:

```bash
pnpm share:secrets
```

This script collects values from:

- `.envrc`
- `.dev.vars` if present
- selected provider env vars such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `HF_TOKEN`

## Workflow

Collect and review changed sessions:

```bash
pnpm share:collect
```

Rerun only the LLM review step:

```bash
pnpm share:review
```

List what is currently uploadable:

```bash
pnpm share:list
```

Search the uploadable set:

```bash
pi-share-hf grep --workspace .pi/hf-sessions -i 'oauth|workers\.dev|trycloudflare|ngrok|private'
```

Dry-run the upload:

```bash
pnpm share:upload:dry
```

Upload approved sessions:

```bash
pnpm share:upload
```

## Notes

- `.pi/hf-sessions/` and `.pi/hf-private/` are gitignored.
- `pnpm share:collect` regenerates `.pi/hf-private/secrets.txt` first.
- If `pi-share-hf` or `trufflehog` is not installed, the npm scripts will fail with the upstream tool error.
