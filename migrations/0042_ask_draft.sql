-- rc46 (DESIGN §10 *Asking when*), slice A2: an unsent Ask when question, saved as you go.
-- Additive: a new table. Asking makes the thread and deletes the row in one batch.
CREATE TABLE `ask_draft` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`group_id` text,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `person_group`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ask_draft_author` ON `ask_draft` (`author_id`,`updated_at`);