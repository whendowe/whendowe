CREATE TABLE `group_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text NOT NULL,
	`edit_tier` text NOT NULL,
	`visibility` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `person_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "group_invite_edit_tier_chk" CHECK("group_invite"."edit_tier" IN ('edit', 'propose', 'view')),
	CONSTRAINT "group_invite_visibility_chk" CHECK("group_invite"."visibility" IN ('FULL', 'DETAILS', 'BUSY', 'HIDDEN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_invite_token_hash_unique` ON `group_invite` (`token_hash`);--> statement-breakpoint
CREATE INDEX `group_invite_group_idx` ON `group_invite` (`group_id`,`created_at`);