CREATE TABLE `calendar_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text DEFAULT 'google' NOT NULL,
	`account_email` text NOT NULL,
	`calendar_id` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`token_expiry` text,
	`sync_token` text,
	`watch_channel` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "calendar_connection_status_chk" CHECK("calendar_connection"."status" IN ('active', 'auth_error', 'disconnected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_connection_target_uq` ON `calendar_connection` (`owner_id`,`provider`,`calendar_id`);--> statement-breakpoint
CREATE TABLE `canonical_event` (
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
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "canonical_event_origin_chk" CHECK("canonical_event"."origin" IN ('user_edit', 'imported_from_calendar')),
	CONSTRAINT "canonical_event_status_chk" CHECK("canonical_event"."status" IN ('active', 'cancelled')),
	CONSTRAINT "canonical_event_all_day_chk" CHECK("canonical_event"."all_day" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `change_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_event_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor` text NOT NULL,
	`source` text NOT NULL,
	`diff` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "change_log_source_chk" CHECK("change_log"."source" IN ('ui', 'inbound_sync'))
);
--> statement-breakpoint
CREATE INDEX `change_log_event_idx` ON `change_log` (`canonical_event_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `change_log_revision_uq` ON `change_log` (`canonical_event_id`,`revision`);--> statement-breakpoint
CREATE TABLE `event_override` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_event_id` text NOT NULL,
	`recurrence_id` text NOT NULL,
	`field_overrides` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_override_occurrence_uq` ON `event_override` (`canonical_event_id`,`recurrence_id`);--> statement-breakpoint
CREATE TABLE `projection` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_event_id` text NOT NULL,
	`calendar_connection_id` text NOT NULL,
	`visibility_profile` text DEFAULT 'FULL' NOT NULL,
	`provider_event_id` text,
	`provider_etag` text,
	`last_pushed_hash` text,
	`recent_write_nonces` text DEFAULT '[]' NOT NULL,
	`base_revision` integer,
	`state` text DEFAULT 'pending_create' NOT NULL,
	`last_error` text,
	`retry_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`canonical_event_id`) REFERENCES `canonical_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`calendar_connection_id`) REFERENCES `calendar_connection`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "projection_state_chk" CHECK("projection"."state" IN ('pending_create', 'synced', 'pending_update', 'pending_delete', 'deleted', 'error'))
);
--> statement-breakpoint
CREATE INDEX `projection_state_idx` ON `projection` (`state`);--> statement-breakpoint
CREATE INDEX `projection_event_idx` ON `projection` (`canonical_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projection_target_uq` ON `projection` (`canonical_event_id`,`calendar_connection_id`);