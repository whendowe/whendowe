-- rc42 (DESIGN §10 *Who really answered*), slice 6a: what a verified event (and later a
-- thread) needs everyone on it to agree to, each person's answer, and the link mailed to each.
-- One open request per event or thread (partial unique indexes). New tables only.
CREATE TABLE `verified_request` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_event_id` text,
	`thread_id` text,
	`kind` text NOT NULL,
	`retain_days` integer,
	`asked_by` text,
	`asked_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`closed_at` text,
	`outcome` text,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asked_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "verified_request_one_chk" CHECK(("verified_request"."canonical_event_id" IS NULL) <> ("verified_request"."thread_id" IS NULL)),
	CONSTRAINT "verified_request_kind_chk" CHECK("verified_request"."kind" IN ('unverify', 'remove', 'shorten')),
	CONSTRAINT "verified_request_outcome_chk" CHECK("verified_request"."outcome" IS NULL OR "verified_request"."outcome" IN ('agreed', 'refused', 'lapsed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verified_request_open_event_uq` ON `verified_request` (`canonical_event_id`) WHERE "verified_request"."closed_at" IS NULL AND "verified_request"."canonical_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `verified_request_open_thread_uq` ON `verified_request` (`thread_id`) WHERE "verified_request"."closed_at" IS NULL AND "verified_request"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `verified_request_answer` (
	`request_id` text NOT NULL,
	`person_id` text NOT NULL,
	`answer` text NOT NULL,
	`answered_at` text NOT NULL,
	`answered_via` text NOT NULL,
	PRIMARY KEY(`request_id`, `person_id`),
	FOREIGN KEY (`request_id`) REFERENCES `verified_request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "verified_request_answer_chk" CHECK("verified_request_answer"."answer" IN ('yes', 'no')),
	CONSTRAINT "verified_request_answer_via_chk" CHECK("verified_request_answer"."answered_via" IN ('session', 'mailed'))
);
--> statement-breakpoint
CREATE TABLE `verified_request_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`person_id` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `verified_request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verified_request_token_uq` ON `verified_request_token` (`request_id`,`person_id`);