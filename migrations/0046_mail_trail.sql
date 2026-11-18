-- rc51 (DESIGN §10 *Mail that stops*), slice M1: in a verified event or thread of exactly
-- two people, the history records when one stopped the other's email or took it back, and
-- each email of the other's that then didn't go out. Additive: a new table, empty.
CREATE TABLE `mail_trail` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_event_id` text,
	`thread_id` text,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`what` text,
	`caused_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`caused_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "mail_trail_one_chk" CHECK(("mail_trail"."canonical_event_id" IS NULL) <> ("mail_trail"."thread_id" IS NULL)),
	CONSTRAINT "mail_trail_kind_chk" CHECK("mail_trail"."kind" IN ('stopped', 'stopped_links', 'again', 'unsent')),
	CONSTRAINT "mail_trail_what_chk" CHECK(("mail_trail"."kind" = 'unsent') = ("mail_trail"."what" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `mail_trail_event_idx` ON `mail_trail` (`canonical_event_id`);--> statement-breakpoint
CREATE INDEX `mail_trail_thread_idx` ON `mail_trail` (`thread_id`);