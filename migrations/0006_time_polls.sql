CREATE TABLE `event_candidate` (
	`canonical_event_id` text NOT NULL,
	`slot_index` integer NOT NULL,
	`all_day` integer NOT NULL,
	`start_local` text NOT NULL,
	`end_local` text NOT NULL,
	`tzid` text,
	PRIMARY KEY(`canonical_event_id`, `slot_index`),
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "event_candidate_slot_chk" CHECK("event_candidate"."slot_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE `slot_response` (
	`canonical_event_id` text NOT NULL,
	`slot_index` integer NOT NULL,
	`person_id` text NOT NULL,
	`answer` text NOT NULL,
	`responded_at` text NOT NULL,
	PRIMARY KEY(`canonical_event_id`, `slot_index`, `person_id`),
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_event_id`,`slot_index`) REFERENCES `event_candidate`(`canonical_event_id`,`slot_index`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "slot_response_answer_chk" CHECK("slot_response"."answer" IN ('yes', 'ifneedbe', 'no'))
);
--> statement-breakpoint
CREATE INDEX `slot_response_person_idx` ON `slot_response` (`person_id`);