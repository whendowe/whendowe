ALTER TABLE `event_participation` ADD `handle` text;--> statement-breakpoint
ALTER TABLE `event_participation` ADD `show_email` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `group_member` ADD `handle` text;--> statement-breakpoint
ALTER TABLE `group_member` ADD `show_email` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `plan_thread_member` ADD `handle` text;--> statement-breakpoint
ALTER TABLE `plan_thread_member` ADD `show_email` integer DEFAULT 0 NOT NULL;