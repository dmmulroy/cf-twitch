-- Seed default command registry entries
INSERT OR IGNORE INTO `commands` (
	`name`,
	`description`,
	`category`,
	`response_type`,
	`permission`,
	`enabled`,
	`created_at`
) VALUES
	('keyboard', 'Shows keyboard info and build video', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('socials', 'Shows social media links', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('dotfiles', 'Shows dotfiles repository link', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('today', 'Shows what''s being worked on today', 'info', 'dynamic', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('project', 'Shows current project (alias for today)', 'info', 'dynamic', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('achievements', 'Shows user''s unlocked achievements', 'stats', 'computed', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('stats', 'Shows user''s song/achievement/raffle stats', 'stats', 'computed', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('raffle-leaderboard', 'Shows top raffle winners', 'stats', 'computed', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('commands', 'Lists available commands', 'meta', 'computed', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('update', 'Updates dynamic command values', 'meta', 'computed', 'moderator', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('song', 'Request a song via Spotify URL', 'music', 'computed', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('queue', 'Shows current song queue', 'music', 'computed', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint

-- Seed default values for static/dynamic commands
INSERT OR IGNORE INTO `command_values` (
	`command_name`,
	`value`,
	`updated_at`,
	`updated_by`
) VALUES
	('keyboard', 'SA Voyager with Choc White switches: https://youtube.com/watch?v=WfIfxaXC_Q4', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('socials', 'GitHub: github.com/dmmulroy | X: x.com/dillon_mulroy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('dotfiles', 'https://github.com/dmmulroy/.dotfiles', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('today', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL);
