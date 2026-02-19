-- Add command counters for computed counter-based commands
CREATE TABLE IF NOT EXISTS `command_counters` (
	`command_name` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`command_name`) REFERENCES `commands`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

-- Upsert command definitions for stream commands migrated from StreamElements
INSERT INTO `commands` (
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
	('github', 'Shows GitHub link', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('twitter', 'Shows Twitter/X link', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('schedule', 'Shows stream schedule', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('font', 'Shows preferred coding font', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('dotfiles', 'Shows dotfiles repository link', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('functor', 'A fun one-liner response', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('location', 'Shows streamer timezone', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('ocaml', 'OCaml command response', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('lurk', 'Lurk acknowledgement command', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('youtube', 'Shows YouTube channel link', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('unlurk', 'Unlurk acknowledgement command', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('errors', 'Error meme link', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('vibes', 'Vibes check command', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('neovim', 'Neovim config walkthrough link', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('dict', 'Clip command', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('beam', 'BEAM slogan command', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('linux', 'GNU/Linux copypasta command', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('time', 'Shows current Eastern time', 'info', 'computed', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('leak', 'Security leak meme command', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('skillissue', 'Increments and shows skill issue count', 'stats', 'computed', 'vip', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('truth', 'Truth clip command', 'meta', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('job', 'Shows current job', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(`name`) DO UPDATE SET
	`description` = excluded.`description`,
	`category` = excluded.`category`,
	`response_type` = excluded.`response_type`,
	`permission` = excluded.`permission`,
	`enabled` = excluded.`enabled`;
--> statement-breakpoint

-- Upsert values for static/dynamic commands
INSERT INTO `command_values` (
	`command_name`,
	`value`,
	`updated_at`,
	`updated_by`
) VALUES
	('keyboard', 'ZSA Voyager with Choc White switches: https://www.youtube.com/watch?v=WfIfxaXC_Q4', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('socials', 'GitHub: github.com/dmmulroy | X: x.com/dillon_mulroy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('github', 'Follow me on GitHub! -> https://github.com/dmmulroy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('twitter', 'Follow me on Twitter (X)! -> https://twitter.com/dillon_mulroy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('schedule', 'My stream schedule -> https://www.twitch.tv/dmmulroy/schedule', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('font', 'MonoLisa - https://www.monolisa.dev', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('dotfiles', 'My dotfiles can be found here: https://github.com/dmmulroy/.dotfiles !neovim for a youtube walkthrough of my neovim config.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('functor', 'Functor? I hardly know her!', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('location', 'I am in Eastern Standard Time!', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('ocaml', 'dmmulrOCaml', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('lurk', '${user} is here but they are Lurking! Thank you for watching! ${random.emote}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('youtube', 'Check out my youtube! https://www.youtube.com/@dmmulroy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('unlurk', '${user} is back on the saddle! Thanks for coming back! ${random.emote}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('errors', 'https://twitter.com/vitalyf/status/1582270207229251585', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('vibes', 'Immaculate', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('neovim', 'Here is a youtube video walkthrough of my neovim config: https://youtu.be/oo_I5lAmdi0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('dict', 'https://clips.twitch.tv/SlipperySarcasticMosquitoTwitchRPG-9V43D-1B4NjpX1B0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('beam', 'BEAM WORK MAKES THE DREAM WORK', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('linux', 'I''d just like to interject for a moment. What you''re refering to as Linux, is in fact, GNU/Linux, or as I''ve recently taken to calling it, GNU plus Linux. Linux is not an operating system unto itself, but rather another free component of a fully functioning GNU system made useful by the GNU corelibs, shell utilities and vital system components comprising a full OS as defined by POSIX.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('leak', 'Dillon last leaked his keys on 23 Jan 2026 (before on 09 Dec 2025 ), admin secret on 16 Feb 2026', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('truth', 'https://www.twitch.tv/dmmulroy/clip/RichObedientWalletKeyboardCat-UiKKTpgvCKHVyFHd', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('job', 'I am Principal Engineer and Rockstar TypeScript Developer at Cloudflare 1.1.1.1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL),
	('today', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
ON CONFLICT(`command_name`) DO UPDATE SET
	`value` = excluded.`value`,
	`updated_at` = excluded.`updated_at`,
	`updated_by` = excluded.`updated_by`;
