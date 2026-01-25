CREATE TABLE `token_set` (
	`id` integer PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`token_type` text NOT NULL,
	`expires_in` integer NOT NULL,
	`expires_at` text NOT NULL
);
