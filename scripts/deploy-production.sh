#!/usr/bin/env bash
# Deploys the cf-twitch API to the Alchemy "production" stage (Worker cf-twitch-api).
#
# Run from anywhere inside a checkout of main:
#   ./scripts/deploy-production.sh
#
# What it does, in order, stopping at the first problem:
#   1. Checks you are on a clean `main` that matches origin/main.
#   2. Checks every required production setting is present (values are never printed).
#   3. Installs from the lockfile and runs the full `pnpm verify`.
#   4. Runs `alchemy plan --stage production` and refuses to continue if it would
#      create, replace, or delete anything. Only updates are expected.
#   5. Asks you to type a confirmation, then runs `alchemy deploy --stage production`
#      WITHOUT --yes, so Alchemy shows the plan again and asks you to approve it, and
#      never redeploys the shared state store.
#   6. Smoke-tests the public endpoints.
#
# Settings come from your shell environment or apps/api/.env (Alchemy reads it).
# These values are uploaded as the Worker's secrets, so they must be the real
# production values. TWITCH_EVENTSUB_SECRET must be the secret the existing Twitch
# EventSub subscriptions were created with, or webhooks will start failing.
#
# Escape hatches (use deliberately):
#   CF_TWITCH_ALLOW_UNPUSHED=1  deploy a local main that differs from origin/main
#   CF_TWITCH_SKIP_VERIFY=1     skip `pnpm verify` (not recommended)

set -euo pipefail

readonly STAGE="production"
readonly WORKER_URL="https://cf-twitch-api.mulroy.workers.dev"
readonly CONFIRMATION="deploy production"
REQUIRED_SETTINGS=(
  TWITCH_CLIENT_ID
  TWITCH_CLIENT_SECRET
  TWITCH_BROADCASTER_ID
  TWITCH_BROADCASTER_NAME
  TWITCH_EVENTSUB_SECRET
  SPOTIFY_CLIENT_ID
  SPOTIFY_CLIENT_SECRET
  OAUTH_SETUP_SECRET
  ADMIN_SECRET
  SONG_REQUEST_REWARD_ID
  KEYBOARD_RAFFLE_REWARD_ID
)

fail() {
  printf '\n\033[31mStopped:\033[0m %s\n' "$1" >&2
  exit 1
}

step() {
  printf '\n\033[1m==> %s\033[0m\n' "$1"
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "run this inside the cf-twitch repository"
cd "$repo_root"
api_dir="$repo_root/apps/api"

step "Checking the checkout"
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || fail "you are on '$branch'; check out main first"
[[ -z "$(git status --porcelain)" ]] || fail "the working tree has uncommitted changes; commit or discard them first"

git fetch --quiet origin main || fail "could not fetch origin/main"
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"
if [[ "$local_head" != "$remote_head" ]]; then
  if [[ "${CF_TWITCH_ALLOW_UNPUSHED:-}" == "1" ]]; then
    printf 'Warning: main (%s) differs from origin/main (%s); continuing because CF_TWITCH_ALLOW_UNPUSHED=1.\n' \
      "${local_head:0:7}" "${remote_head:0:7}"
  else
    fail "main (${local_head:0:7}) differs from origin/main (${remote_head:0:7}); push or pull first, or set CF_TWITCH_ALLOW_UNPUSHED=1"
  fi
fi
printf 'Deploying commit %s: %s\n' "${local_head:0:7}" "$(git log -1 --format=%s)"

step "Checking production settings"
env_file="$api_dir/.env"
missing=()
for name in "${REQUIRED_SETTINGS[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    continue
  fi
  if [[ -f "$env_file" ]] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?${name}=.+" "$env_file"; then
    continue
  fi
  missing+=("$name")
done
if (( ${#missing[@]} > 0 )); then
  fail "missing production settings (export them or add them to apps/api/.env): ${missing[*]}"
fi
echo "All ${#REQUIRED_SETTINGS[@]} required settings are present."

step "Installing dependencies from the lockfile"
pnpm install --frozen-lockfile

if [[ "${CF_TWITCH_SKIP_VERIFY:-}" == "1" ]]; then
  step "Skipping pnpm verify (CF_TWITCH_SKIP_VERIFY=1)"
else
  step "Running pnpm verify"
  pnpm verify
fi

step "Planning the $STAGE stage"
plan_log="$(mktemp -t cf-twitch-plan.XXXXXX)"
(cd "$api_dir" && pnpm exec alchemy plan --stage "$STAGE" --no-input) 2>&1 | tee "$plan_log"
plan_text="$(perl -pe 's/\e\[[0-9;]*m//g' "$plan_log")"

grep -q 'Plan:' <<<"$plan_text" || fail "the plan did not finish; see the output above"
if grep -Eq '\] (create|replace|delete)( |$)' <<<"$plan_text"; then
  grep -E '\] (create|replace|delete)( |$)' <<<"$plan_text" >&2
  fail "the plan would create, replace, or delete resources; review it before deploying"
fi
printf '\nPlan summary: %s\n' "$(grep -m1 -o 'Plan:.*' <<<"$plan_text")"

step "Confirm"
read -r -p "Type \"$CONFIRMATION\" to deploy commit ${local_head:0:7} to $STAGE: " answer
[[ "$answer" == "$CONFIRMATION" ]] || fail "not confirmed; nothing was deployed"

step "Deploying to $STAGE (Alchemy will ask you to approve the plan)"
(cd "$api_dir" && pnpm exec alchemy deploy --stage "$STAGE")

step "Smoke-testing $WORKER_URL"
smoke_failed=0
for path in /health /api/now-playing; do
  status=000
  for _ in 1 2 3 4 5; do
    status="$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_URL$path" || true)"
    [[ "$status" == "200" ]] && break
    sleep 3
  done
  printf '%-18s %s\n' "$path" "$status"
  [[ "$status" == "200" ]] || smoke_failed=1
done
(( smoke_failed == 0 )) || fail "the deploy finished but a smoke test failed; check the Worker logs"

printf '\n\033[32mProduction deploy of %s finished.\033[0m\n' "${local_head:0:7}"
