-- rc60 (DESIGN §10 *Running without email*), slice S1: the setup link that makes an instance's
-- first owner, operators kept in the instance beside OPERATOR_EMAILS, and how a sign-in link was
-- handed out. Additive (§16).
CREATE TABLE `instance_operator` (
	`person_id` text PRIMARY KEY NOT NULL,
	`added_at` text NOT NULL,
	`added_by` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `setup_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setup_token_token_hash_unique` ON `setup_token` (`token_hash`);--> statement-breakpoint
ALTER TABLE `login_token` ADD `via` text;