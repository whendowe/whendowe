-- rc42 (DESIGN §10 *Who really answered*), slice 1: how each answer on an event arrived, and
-- whether an answer link was mailed or copied. NULL = before rc42, not recorded. drizzle-kit
-- leaves ON DELETE SET NULL out of ALTER … ADD (as in 0020, 0025, 0026); added by hand, so
-- erasing whoever copied a link leaves the answer "by a link someone copied".
ALTER TABLE `event_feedback` ADD `answered_via` text;--> statement-breakpoint
ALTER TABLE `event_feedback` ADD `answered_via_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `event_participation` ADD `attendance_via` text;--> statement-breakpoint
ALTER TABLE `event_participation` ADD `attendance_via_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `event_participation` ADD `response_state_via` text;--> statement-breakpoint
ALTER TABLE `event_participation` ADD `response_state_via_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `response_token` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `response_token` ADD `issued_by` text REFERENCES person(id) ON DELETE SET NULL;