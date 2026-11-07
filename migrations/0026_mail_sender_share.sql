-- rc37 (DESIGN §13): who caused a send, for each sender's share of the cap. drizzle-kit
-- leaves ON DELETE SET NULL out of ALTER … ADD (as in 0020, 0025); added by hand, so erasing
-- a person nulls it at once.
ALTER TABLE `mail_send` ADD `sender_id` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `mail_send_sender_day_idx` ON `mail_send` (`sender_id`,`day`);--> statement-breakpoint
CREATE INDEX `mail_send_sender_month_idx` ON `mail_send` (`sender_id`,`month`);