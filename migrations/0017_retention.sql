ALTER TABLE `canonical_event` ADD `retain_days` integer DEFAULT 365 NOT NULL;--> statement-breakpoint
ALTER TABLE `person_group` ADD `retain_days` integer DEFAULT 365 NOT NULL;