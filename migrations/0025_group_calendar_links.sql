DROP INDEX `feed_token_group_uq`;--> statement-breakpoint
DROP INDEX `feed_token_own_uq`;--> statement-breakpoint
ALTER TABLE `feed_token` ADD `kind` text DEFAULT 'feed' NOT NULL;--> statement-breakpoint
ALTER TABLE `feed_token` ADD `label` text;--> statement-breakpoint
ALTER TABLE `feed_token` ADD `tier` text;--> statement-breakpoint
ALTER TABLE `feed_token` ADD `made_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `feed_token_shared_idx` ON `feed_token` (`group_id`) WHERE "feed_token"."kind" = 'shared';--> statement-breakpoint
CREATE UNIQUE INDEX `feed_token_group_uq` ON `feed_token` (`person_id`,`group_id`) WHERE "feed_token"."kind" = 'feed' AND "feed_token"."group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `feed_token_own_uq` ON `feed_token` (`person_id`) WHERE "feed_token"."kind" = 'feed' AND "feed_token"."group_id" IS NULL;