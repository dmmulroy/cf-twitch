#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-https://cf-twitch-api.dillon-mulroy.workers.dev}"
ADMIN_SECRET="${ADMIN_SECRET:-}"
TARGET_USER="${1:-}"
LIMIT="${LIMIT:-25}"
OFFSET="${OFFSET:-0}"

if [[ -z "$ADMIN_SECRET" ]]; then
	printf 'error: ADMIN_SECRET is not set\n' >&2
	exit 1
fi

if [[ -z "$TARGET_USER" ]]; then
	printf 'usage: %s <username>\n' "$0" >&2
	printf 'example: %s ar_ts\n' "$0" >&2
	exit 1
fi

TARGET_USER="${TARGET_USER#@}"

urlencode() {
	node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"
}

print_json() {
	if command -v jq >/dev/null 2>&1; then
		jq .
	else
		cat
	fi
}

run_get() {
	local title="$1"
	local url="$2"
	local tmp
	tmp="$(mktemp)"

	local status
	status="$(curl -sS -o "$tmp" -w '%{http_code}' -H "Authorization: Bearer ${ADMIN_SECRET}" "$url")"

	printf '\n=== %s ===\n' "$title"
	printf 'GET %s\n' "$url"
	printf 'status: %s\n' "$status"
	cat "$tmp" | print_json

	rm -f "$tmp"
}

ENCODED_USER="$(urlencode "$TARGET_USER")"

run_get "EventBus pending" "${BASE_URL}/api/admin/event-bus/pending?limit=${LIMIT}&offset=${OFFSET}"
run_get "Achievements debug counts" "${BASE_URL}/api/admin/achievements/debug/counts"
run_get "Achievements debug user" "${BASE_URL}/api/admin/achievements/debug/user/${ENCODED_USER}"
run_get "Stats debug user" "${BASE_URL}/api/admin/debug/stats/${ENCODED_USER}"
