-- rc59 (DESIGN §10 *Following calendars*), slice F3a: Going. An event you went to from a
-- followed calendar remembers where it came from and the revision its source last wrote; one
-- such event per person per followed event. Additive: two nullable columns and an index.
ALTER TABLE `canonical_event` ADD `followed_from` text;--> statement-breakpoint
ALTER TABLE `canonical_event` ADD `followed_until` text;--> statement-breakpoint
CREATE UNIQUE INDEX `canonical_event_followed_uq` ON `canonical_event` (`owner_id`,`followed_from`) WHERE "canonical_event"."followed_from" IS NOT NULL;
