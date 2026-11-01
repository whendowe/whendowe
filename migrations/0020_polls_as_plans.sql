CREATE TABLE `plan_vote_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`person_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_vote_token_thread_person_uq` ON `plan_vote_token` (`thread_id`,`person_id`);--> statement-breakpoint
ALTER TABLE `plan_event` ADD `location` text;--> statement-breakpoint
ALTER TABLE `plan_event` ADD `description` text;--> statement-breakpoint
ALTER TABLE `plan_thread` ADD `group_id` text REFERENCES person_group(id) ON DELETE SET NULL;