CREATE TABLE `event_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_event_id` text NOT NULL,
	`person_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_feedback_event_idx` ON `event_feedback` (`canonical_event_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `response_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`canonical_event_id` text NOT NULL,
	`person_id` text NOT NULL,
	`action` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "response_token_action_chk" CHECK("response_token"."action" IN ('vote', 'attend'))
);
--> statement-breakpoint
CREATE INDEX `response_token_person_idx` ON `response_token` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `response_token_scope_uq` ON `response_token` (`canonical_event_id`,`person_id`,`action`);--> statement-breakpoint
ALTER TABLE `event_participation` ADD `responded_at` text;