import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const achievementSchemaStatements = [
  "CREATE TABLE IF NOT EXISTS `achievement_definitions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`description` text NOT NULL,\n\t`icon` text NOT NULL,\n\t`category` text NOT NULL,\n\t`threshold` integer,\n\t`trigger_event` text NOT NULL,\n\t`scope` text DEFAULT 'cumulative' NOT NULL\n)",
  "INSERT OR IGNORE INTO `achievement_definitions` (`id`, `name`, `description`, `icon`, `category`, `threshold`, `trigger_event`, `scope`) VALUES\n  -- Song Request Achievements\n  ('first_request', 'First Timer', 'Request your first song', '1f3b5', 'song_request', 1, 'song_request', 'cumulative'),\n  ('request_10', 'Regular', 'Request 10 songs', '1f3b6', 'song_request', 10, 'song_request', 'cumulative'),\n  ('request_50', 'DJ in Training', 'Request 50 songs', '1f3a7', 'song_request', 50, 'song_request', 'cumulative'),\n  ('request_100', 'Certified DJ', 'Request 100 songs', '1f4bf', 'song_request', 100, 'song_request', 'cumulative'),\n  ('stream_opener', 'Stream Opener', 'First song request of the stream', '1f305', 'special', NULL, 'stream_first_request', 'session'),\n  -- Raffle Achievements\n  ('first_roll', 'Feeling Lucky', 'Enter your first raffle', '1f3b2', 'raffle', 1, 'raffle_roll', 'cumulative'),\n  ('roll_25', 'Persistent', 'Enter 25 raffles', '1f3b0', 'raffle', 25, 'raffle_roll', 'cumulative'),\n  ('roll_100', 'Never Give Up', 'Enter 100 raffles', '1f4aa', 'raffle', 100, 'raffle_roll', 'cumulative'),\n  ('first_win', 'Winner Winner', 'Win your first raffle', '1f3c6', 'raffle', 1, 'raffle_win', 'cumulative'),\n  ('close_call', 'So Close', 'Roll within 100 of winning number', '1f62c', 'raffle', NULL, 'raffle_close', 'cumulative'),\n  ('closest_ever', 'Heartbreaker', 'Hold the closest non-winning roll record', '1f494', 'special', NULL, 'raffle_closest_record', 'cumulative'),\n  -- Engagement Achievements\n  ('streak_3', 'On a Roll', '3 successful requests in a row', '1f525', 'engagement', 3, 'request_streak', 'session'),\n  ('streak_5', 'Hot Streak', '5 successful requests in a row', '26a1', 'engagement', 5, 'request_streak', 'session')",
  "CREATE TABLE IF NOT EXISTS `user_streaks` (\n\t`user_id` text PRIMARY KEY NOT NULL,\n\t`user_display_name` text NOT NULL,\n\t`session_streak` integer DEFAULT 0 NOT NULL,\n\t`longest_streak` integer DEFAULT 0 NOT NULL,\n\t`last_request_at` text,\n\t`session_started_at` text\n)",
  "CREATE TABLE IF NOT EXISTS `event_history` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`event_type` text NOT NULL,\n\t`user_id` text NOT NULL,\n\t`user_display_name` text NOT NULL,\n\t`event_id` text NOT NULL,\n\t`timestamp` text NOT NULL,\n\t`metadata` text\n)",
  "CREATE INDEX IF NOT EXISTS `idx_event_history_type_time` ON `event_history` (`event_type`, `timestamp`)",
  "-- Add unique index on event_id for idempotency\nCREATE UNIQUE INDEX IF NOT EXISTS `idx_event_history_event_id` ON `event_history` (`event_id`)",
  "CREATE TABLE IF NOT EXISTS `user_achievements` (\n  `id` text PRIMARY KEY NOT NULL,\n  `user_id` text NOT NULL,\n  `user_display_name` text NOT NULL,\n  `achievement_id` text NOT NULL,\n  `progress` integer DEFAULT 0 NOT NULL,\n  `unlocked_at` text,\n  `announcement_state` text DEFAULT 'pending' NOT NULL,\n  `event_id` text\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `user_achievement_viewer_unique` ON `user_achievements` (`user_id`, `achievement_id`)",
  "CREATE INDEX IF NOT EXISTS `idx_user_achievements_viewer` ON `user_achievements` (`user_id`)",
  "CREATE INDEX IF NOT EXISTS `idx_user_achievements_display_name` ON `user_achievements` (`user_display_name`)",
  "CREATE INDEX IF NOT EXISTS `idx_user_achievements_unlocked` ON `user_achievements` (`unlocked_at`)",
  "CREATE TABLE IF NOT EXISTS `achievement_stream_session` (\n  `singleton_id` integer PRIMARY KEY DEFAULT 1 NOT NULL CHECK (`singleton_id` = 1),\n  `status` text NOT NULL CHECK (`status` IN ('online', 'offline')),\n  `stream_id` text,\n  `started_at` text,\n  `transition_at` text NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS `achievement_unlock_outbox` (\n  `effect_id` text PRIMARY KEY NOT NULL,\n  `event_id` text NOT NULL,\n  `user_id` text NOT NULL,\n  `user_display_name` text NOT NULL,\n  `achievement_id` text NOT NULL,\n  `achievement_name` text NOT NULL,\n  `achievement_description` text NOT NULL,\n  `category` text NOT NULL,\n  `metric_state` text DEFAULT 'pending' NOT NULL CHECK (`metric_state` IN ('pending', 'claimed')),\n  `announcement_state` text DEFAULT 'pending' NOT NULL CHECK (`announcement_state` IN ('pending', 'sending', 'sent', 'abandoned', 'uncertain')),\n  `announcement_attempts` integer DEFAULT 0 NOT NULL,\n  `created_at` text NOT NULL,\n  `updated_at` text NOT NULL\n)",
  "CREATE INDEX IF NOT EXISTS `idx_achievement_unlock_outbox_pending` ON `achievement_unlock_outbox` (`announcement_state`, `metric_state`)",
];

const adoptAchievementSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of achievementSchemaStatements) yield* sql.unsafe(statement);
  // Baseline SQL is authoritative; never import the Agent JSON projection.
  yield* sql`SELECT user_id,announcement_state FROM user_achievements LIMIT 0`;
  yield* sql`CREATE TABLE IF NOT EXISTS achievement_outbox_retry (effect_id TEXT PRIMARY KEY NOT NULL, next_attempt_at INTEGER NOT NULL)`;
});
const fenceAchievementUnlockGeneration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Fences an old in-flight response from marking a later session's unlock as announced.
  yield* sql`CREATE TABLE IF NOT EXISTS achievement_current_unlock (user_id TEXT NOT NULL, achievement_id TEXT NOT NULL, effect_id TEXT NOT NULL UNIQUE, PRIMARY KEY(user_id,achievement_id))`;
  yield* sql`INSERT OR IGNORE INTO achievement_current_unlock(user_id,achievement_id,effect_id)
 SELECT u.user_id,u.achievement_id,o.effect_id FROM user_achievements u JOIN achievement_unlock_outbox o
 ON o.user_id=u.user_id AND o.achievement_id=u.achievement_id AND o.created_at=u.unlocked_at
 WHERE u.unlocked_at IS NOT NULL ORDER BY o.created_at DESC,o.effect_id DESC`;
});
/** Adopts complete baseline achievement SQL; older pre-viewer-ID databases fail closed. */
export const achievementMigrationLoader = SqliteMigrator.fromRecord({
  "1_adopt_achievement_sql": adoptAchievementSchema,
  "2_fence_unlock_generation": fenceAchievementUnlockGeneration,
});
