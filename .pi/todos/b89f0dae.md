{
  "id": "b89f0dae",
  "title": "Investigate SongQueueDO stale-data sync failure log",
  "tags": [
    "debug",
    "song-queue"
  ],
  "status": "done",
  "created_at": "2026-04-10T12:17:47.819Z"
}

Investigated `log.sync_failed_using_stale_data` from SongQueueDO getSongQueue RPC.

Findings:
- `SongQueueDO.syncFromSpotify()` wrapped the underlying Spotify queue error as `new Error(queueResult.error.message)`, which discarded the original tagged error.
- `ensureFresh()` and `refreshQueueTick()` then logged `result.error.message` under the `error` field, causing logs to show `UnknownError`/generic top-level information instead of the real underlying cause.
- `SpotifyService.getQueue()` also did not classify HTTP 404 as `SpotifyNoActiveDeviceError`, unlike other Spotify player operations.

Changes made:
- Preserve the original `queueResult.error` as the `SongQueueDbError.cause`.
- Log the full error object plus `cause` in SongQueueDO stale-fallback and scheduled-refresh logs.
- Treat `GET /v1/me/player/queue` HTTP 404 as `SpotifyNoActiveDeviceError`.
- Added a regression test proving stale-fallback logs include the underlying Spotify error cause.

Validation:
- `pnpm --filter cf-twitch-api test -- src/__tests__/durable-objects/song-queue-do.test.ts`
- `pnpm --filter cf-twitch-api typecheck`
