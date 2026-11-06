CREATE TABLE `feed_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`token_enc` text NOT NULL,
	`person_id` text NOT NULL,
	`group_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `person_group`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feed_token_group_uq` ON `feed_token` (`person_id`,`group_id`) WHERE "feed_token"."group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `feed_token_own_uq` ON `feed_token` (`person_id`) WHERE "feed_token"."group_id" IS NULL;