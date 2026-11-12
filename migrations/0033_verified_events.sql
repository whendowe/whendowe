-- rc42 (DESIGN §10 *Who really answered*), slice 4a: a verified event (answers only from a
-- mailed link or signed in), and a group's default that makes its new events verified.
-- Null and 0: nothing is verified until someone says so.
ALTER TABLE `canonical_event` ADD `verified_at` text;--> statement-breakpoint
ALTER TABLE `person_group` ADD `default_verified` integer DEFAULT 0 NOT NULL;