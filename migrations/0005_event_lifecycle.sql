CREATE TABLE `event_participation` (
	`canonical_event_id` text NOT NULL,
	`person_id` text NOT NULL,
	`edit_tier` text NOT NULL,
	`visibility` text NOT NULL,
	`response_kind` text DEFAULT 'none' NOT NULL,
	`response_state` text,
	`attendance` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "event_participation_edit_tier_chk" CHECK("event_participation"."edit_tier" IN ('edit', 'propose', 'view')),
	CONSTRAINT "event_participation_visibility_chk" CHECK("event_participation"."visibility" IN ('FULL', 'DETAILS', 'BUSY', 'HIDDEN')),
	CONSTRAINT "event_participation_response_kind_chk" CHECK("event_participation"."response_kind" IN ('none', 'ack', 'accept', 'slot_vote')),
	CONSTRAINT "event_participation_attendance_chk" CHECK("event_participation"."attendance" IS NULL OR "event_participation"."attendance" IN ('going', 'maybe', 'not_going'))
);
--> statement-breakpoint
CREATE INDEX `event_participation_person_idx` ON `event_participation` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_participation_uq` ON `event_participation` (`canonical_event_id`,`person_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canonical_event` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`origin` text NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`start_local` text NOT NULL,
	`end_local` text NOT NULL,
	`tzid` text,
	`all_day` integer DEFAULT 0 NOT NULL,
	`rrule` text,
	`exdates` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`group_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `person_group`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "canonical_event_origin_chk" CHECK("__new_canonical_event"."origin" IN ('user_edit', 'imported_from_calendar')),
	CONSTRAINT "canonical_event_status_chk" CHECK("__new_canonical_event"."status" IN ('draft', 'proposed', 'scheduled', 'declined', 'withdrawn', 'cancelled')),
	CONSTRAINT "canonical_event_all_day_chk" CHECK("__new_canonical_event"."all_day" IN (0, 1))
);
--> statement-breakpoint
-- Hand-corrected (DESIGN §16 rc11 exception). drizzle-kit generated this copy with two
-- bugs: it SELECTed group_id from the old table, which has no such column, and copied
-- status verbatim, so an M0 'active' row would violate the new CHECK. group_id starts
-- NULL; 'active' becomes 'scheduled' (its meaning under the WORKFLOWS §5 lifecycle).
INSERT INTO `__new_canonical_event`("id", "revision", "origin", "owner_id", "title", "description", "location", "start_local", "end_local", "tzid", "all_day", "rrule", "exdates", "status", "created_at", "updated_at") SELECT "id", "revision", "origin", "owner_id", "title", "description", "location", "start_local", "end_local", "tzid", "all_day", "rrule", "exdates", CASE "status" WHEN 'active' THEN 'scheduled' ELSE "status" END, "created_at", "updated_at" FROM `canonical_event`;--> statement-breakpoint
DROP TABLE `canonical_event`;--> statement-breakpoint
ALTER TABLE `__new_canonical_event` RENAME TO `canonical_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `canonical_event_group_idx` ON `canonical_event` (`group_id`);