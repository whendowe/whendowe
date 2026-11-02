CREATE TABLE `guest_claim` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `guest_claim_thread_idx` ON `guest_claim` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `share_link` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_link_thread_id_unique` ON `share_link` (`thread_id`);--> statement-breakpoint
ALTER TABLE `person` ADD `guest_at` text;--> statement-breakpoint
ALTER TABLE `plan_thread` ADD `shared_at` text;