-- rc43 (DESIGN §10 *Capabilities*), slice 1: which account may use which capability where the
-- instance limits it, and the operator page's log of grants and revokes. New tables only.
CREATE TABLE `account_capability` (
	`person_id` text NOT NULL,
	`capability` text NOT NULL,
	`granted_at` text NOT NULL,
	`granted_by` text,
	PRIMARY KEY(`person_id`, `capability`),
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "account_capability_chk" CHECK("account_capability"."capability" IN ('verify', 'calendar_sync', 'long_history'))
);
--> statement-breakpoint
CREATE TABLE `capability_change` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text,
	`capability` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "capability_change_action_chk" CHECK("capability_change"."action" IN ('granted', 'revoked'))
);
