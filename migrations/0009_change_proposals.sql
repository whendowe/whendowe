CREATE TABLE `event_change_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_event_id` text NOT NULL,
	`proposed_by` text NOT NULL,
	`base_revision` integer NOT NULL,
	`fields` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposed_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "event_change_proposal_status_chk" CHECK("event_change_proposal"."status" IN ('pending', 'accepted', 'rejected', 'withdrawn', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX `event_change_proposal_event_idx` ON `event_change_proposal` (`canonical_event_id`,`status`);