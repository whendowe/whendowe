-- rc53 (DESIGN §10 *Google Calendar, both ways*), slice T3: each connection's calendar has a
-- push channel. Its secret is kept hashed; Google's resource id is what stopping it needs. With
-- no channel, watch_expires_at is when to try making one again after a failure, so a calendar
-- Google won't watch is asked once an hour, not every minute. Additive and nullable.
ALTER TABLE `calendar_connection` ADD `watch_token_hash` text;--> statement-breakpoint
ALTER TABLE `calendar_connection` ADD `watch_resource_id` text;--> statement-breakpoint
ALTER TABLE `calendar_connection` ADD `watch_expires_at` text;