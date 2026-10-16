CREATE TABLE `group_member` (
	`group_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text NOT NULL,
	`default_edit_tier` text DEFAULT 'view' NOT NULL,
	`default_visibility` text DEFAULT 'FULL' NOT NULL,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `person_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "group_member_role_chk" CHECK("group_member"."role" IN ('organizer', 'member')),
	CONSTRAINT "group_member_edit_tier_chk" CHECK("group_member"."default_edit_tier" IN ('edit', 'propose', 'view')),
	CONSTRAINT "group_member_visibility_chk" CHECK("group_member"."default_visibility" IN ('FULL', 'DETAILS', 'BUSY', 'HIDDEN'))
);
--> statement-breakpoint
CREATE INDEX `group_member_person_idx` ON `group_member` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `group_member_uq` ON `group_member` (`group_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `person_group` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action
);
