CREATE TABLE `plan` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author_id` text NOT NULL,
	`name` text NOT NULL,
	`message` text,
	`answers_id` text,
	`rest_of` integer DEFAULT 0 NOT NULL,
	`question_id` text NOT NULL,
	`status` text NOT NULL,
	`replaced_by` text,
	`decided_by` text,
	`decision_id` text,
	`sent_at` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`answers_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replaced_by`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "plan_status_chk" CHECK("plan"."status" IN ('draft', 'on_table', 'accepted', 'replaced', 'withdrawn')),
	CONSTRAINT "plan_rest_of_chk" CHECK("plan"."rest_of" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `plan_thread_idx` ON `plan` (`thread_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_one_draft_uq` ON `plan` (`thread_id`,`author_id`) WHERE "plan"."status" = 'draft';--> statement-breakpoint
CREATE TABLE `plan_event` (
	`plan_id` text NOT NULL,
	`sid` text NOT NULL,
	`title` text NOT NULL,
	`all_day` integer NOT NULL,
	`start_local` text NOT NULL,
	`end_local` text NOT NULL,
	`who` text DEFAULT '[]' NOT NULL,
	`canonical_event_id` text,
	PRIMARY KEY(`plan_id`, `sid`),
	FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "plan_event_all_day_chk" CHECK("plan_event"."all_day" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `plan_event_canonical_idx` ON `plan_event` (`canonical_event_id`);--> statement-breakpoint
CREATE TABLE `plan_note` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author_id` text NOT NULL,
	`first_day` text NOT NULL,
	`last_day` text NOT NULL,
	`body` text NOT NULL,
	`private` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plan_note_private_chk" CHECK("plan_note"."private" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `plan_note_thread_idx` ON `plan_note` (`thread_id`,`first_day`);--> statement-breakpoint
CREATE TABLE `plan_thread` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`organizer_id` text NOT NULL,
	`tzid` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organizer_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plan_thread_member` (
	`thread_id` text NOT NULL,
	`person_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `person_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `plan_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plan_thread_member_person_idx` ON `plan_thread_member` (`person_id`);--> statement-breakpoint
CREATE TABLE `plan_vote` (
	`plan_id` text NOT NULL,
	`person_id` text NOT NULL,
	`answer` text NOT NULL,
	`responded_at` text NOT NULL,
	PRIMARY KEY(`plan_id`, `person_id`),
	FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plan_vote_answer_chk" CHECK("plan_vote"."answer" IN ('yes', 'ifneedbe', 'no'))
);
