-- rc46 (DESIGN §10 *Asking when*), slice A0: a minute to take it back. An action that mails
-- other people is held here for a minute; Undo deletes it while taken_at is null, the scheduled
-- pass claims and runs it at most once, and outcome is shown to the actor for a day.
-- Additive: a new table.
CREATE TABLE `held_action` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`thread_id` text,
	`kind` text NOT NULL,
	`args` text DEFAULT '{}' NOT NULL,
	`due_at` text NOT NULL,
	`taken_at` text,
	`outcome` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "held_action_kind_chk" CHECK("held_action"."kind" IN ('vote_links'))
);
--> statement-breakpoint
CREATE INDEX `held_action_due` ON `held_action` (`due_at`) WHERE "held_action"."taken_at" IS NULL;--> statement-breakpoint
CREATE INDEX `held_action_thread_idx` ON `held_action` (`thread_id`,`actor_id`);