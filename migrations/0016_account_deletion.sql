CREATE TABLE `account_deletion` (
	`person_id` text PRIMARY KEY NOT NULL,
	`requested_at` text NOT NULL,
	`erase_after` text NOT NULL,
	`token_hash` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_token_hash_unique` ON `account_deletion` (`token_hash`);--> statement-breakpoint
CREATE INDEX `account_deletion_due_idx` ON `account_deletion` (`erase_after`);