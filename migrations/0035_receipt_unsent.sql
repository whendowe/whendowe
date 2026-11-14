CREATE TABLE `receipt_unsent` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_event_id` text,
	`thread_id` text,
	`person_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "receipt_unsent_one_chk" CHECK(("receipt_unsent"."canonical_event_id" IS NULL) <> ("receipt_unsent"."thread_id" IS NULL)),
	CONSTRAINT "receipt_unsent_reason_chk" CHECK("receipt_unsent"."reason" IN ('suppressed', 'capped', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `receipt_unsent_event_idx` ON `receipt_unsent` (`canonical_event_id`);--> statement-breakpoint
CREATE INDEX `receipt_unsent_thread_idx` ON `receipt_unsent` (`thread_id`);