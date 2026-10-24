CREATE TABLE `event_participant_change` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_event_id` text NOT NULL,
	`person_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "event_participant_change_action_chk" CHECK("event_participant_change"."action" IN ('added', 'removed'))
);
--> statement-breakpoint
CREATE INDEX `event_participant_change_event_idx` ON `event_participant_change` (`canonical_event_id`,`created_at`);