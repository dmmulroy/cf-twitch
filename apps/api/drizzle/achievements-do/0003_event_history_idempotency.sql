-- Add unique index on event_id for idempotency
CREATE UNIQUE INDEX IF NOT EXISTS `idx_event_history_event_id` ON `event_history` (`event_id`);
