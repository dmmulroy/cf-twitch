{
  "id": "d4abcf71",
  "title": "Complete cf-twitch-api.yaak.json so it covers current API/admin routes",
  "tags": [
    "yaak",
    "api-schema",
    "admin",
    "routes"
  ],
  "status": "closed",
  "created_at": "2026-04-13T12:32:53.922Z"
}

Completed `cf-twitch-api.yaak.json` coverage for current API/admin routes.

Added missing requests for:
- Admin commands CRUD/list
- Song request history
- Debug stream state
- Debug keyboard raffle leaderboard
- Achievement definitions
- User unlocked achievements
- Debug reconcile stream state
- Debug status
- Migration debug endpoints (already present and kept)

Added supporting env vars:
- COMMAND_NAME
- COMMAND_BODY_JSON
- COMMAND_PATCH_JSON
- HISTORY_LIMIT
- RAFFLE_SORT
- RAFFLE_LIMIT

Canonical Yaak source is now `cf-twitch-api.yaak.json` only; `yaak/` was removed.
