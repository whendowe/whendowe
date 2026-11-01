CREATE TABLE `mail_suppression` (
	`address_hash` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`address_hash`, `scope`, `scope_id`),
	CONSTRAINT "mail_suppression_scope_chk" CHECK("mail_suppression"."scope" IN ('all', 'group', 'person'))
);
--> statement-breakpoint
CREATE TABLE `opt_out_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`sender_id` text,
	`group_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `person_group`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `opt_out_token_email_idx` ON `opt_out_token` (`email`);--> statement-breakpoint
ALTER TABLE `person` ADD `signed_in_at` text;--> statement-breakpoint
-- Who has signed in, from what survives of it (rc24). Erring towards "signed in" is the
-- safe side: such an address can't be deleted from an opt-out link, only by signing in.
-- Sessions are purged after they expire, so membership, owning an event, a calendar
-- connection or a chosen name also count.
UPDATE `person` SET `signed_in_at` = coalesce(
	(SELECT min(`created_at`) FROM `session` WHERE `session`.`person_id` = `person`.`id`),
	`created_at`
) WHERE `erased_at` IS NULL AND (
	EXISTS (SELECT 1 FROM `session` WHERE `session`.`person_id` = `person`.`id`)
	OR EXISTS (SELECT 1 FROM `group_member` WHERE `group_member`.`person_id` = `person`.`id`)
	OR EXISTS (SELECT 1 FROM `canonical_event` WHERE `canonical_event`.`owner_id` = `person`.`id`)
	OR EXISTS (SELECT 1 FROM `calendar_connection` WHERE `calendar_connection`.`owner_id` = `person`.`id`)
	OR `display_name` IS NOT NULL
);
