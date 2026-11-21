-- rc56/rc57 (DESIGN §10 *Following calendars*), slice F1: calendars followed by their iCal
-- link — one row per link, who follows it (a person or a group), and its events in the window
-- kept, a cache replaced only where a fetch differs. New tables only.
CREATE TABLE `calendar_follow` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`person_id` text,
	`group_id` text,
	`name` text,
	`colour` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`calendar_id`) REFERENCES `followed_calendar`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `person_group`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "calendar_follow_one_chk" CHECK(("calendar_follow"."person_id" IS NULL) <> ("calendar_follow"."group_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_follow_person_uq` ON `calendar_follow` (`person_id`,`calendar_id`) WHERE "calendar_follow"."person_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_follow_group_uq` ON `calendar_follow` (`group_id`,`calendar_id`) WHERE "calendar_follow"."group_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `calendar_follow_calendar_idx` ON `calendar_follow` (`calendar_id`);--> statement-breakpoint
CREATE TABLE `followed_calendar` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`name` text,
	`etag` text,
	`last_modified` text,
	`fetched_at` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`left_out` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "followed_calendar_status_chk" CHECK("followed_calendar"."status" IN ('ok', 'unreadable', 'refused'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `followed_calendar_url_unique` ON `followed_calendar` (`url`);--> statement-breakpoint
CREATE TABLE `followed_event` (
	`calendar_id` text NOT NULL,
	`uid` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`description` text,
	`url` text,
	`start_local` text NOT NULL,
	`end_local` text NOT NULL,
	`tzid` text,
	`all_day` integer NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`calendar_id`, `uid`),
	FOREIGN KEY (`calendar_id`) REFERENCES `followed_calendar`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "followed_event_status_chk" CHECK("followed_event"."status" IN ('confirmed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `followed_event_start_idx` ON `followed_event` (`calendar_id`,`start_local`);