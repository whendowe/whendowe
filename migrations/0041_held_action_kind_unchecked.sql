-- rc46 (DESIGN §10 *Asking when*; §16 second exception, owner 2026-11-16): held_action loses
-- its kind CHECK, so a new held kind needs no rebuild; the app checks the kind on every read.
-- A rebuild, allowed only for a table of transient rows: every row is copied.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_held_action` (
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
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_held_action`("id", "actor_id", "thread_id", "kind", "args", "due_at", "taken_at", "outcome", "created_at") SELECT "id", "actor_id", "thread_id", "kind", "args", "due_at", "taken_at", "outcome", "created_at" FROM `held_action`;--> statement-breakpoint
DROP TABLE `held_action`;--> statement-breakpoint
ALTER TABLE `__new_held_action` RENAME TO `held_action`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `held_action_due` ON `held_action` (`due_at`) WHERE "held_action"."taken_at" IS NULL;--> statement-breakpoint
CREATE INDEX `held_action_thread_idx` ON `held_action` (`thread_id`,`actor_id`);