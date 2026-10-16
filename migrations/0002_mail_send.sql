CREATE TABLE `mail_send` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`month` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_send_day_idx` ON `mail_send` (`day`);--> statement-breakpoint
CREATE INDEX `mail_send_month_idx` ON `mail_send` (`month`);