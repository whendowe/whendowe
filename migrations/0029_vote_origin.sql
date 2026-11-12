-- rc42 (DESIGN §10 *Who really answered*), slice 1b: how each vote on a plan arrived, and
-- whether a vote link was mailed or copied. NULL = before rc42, not recorded. As in 0028,
-- ON DELETE SET NULL is added by hand (drizzle-kit leaves it out of ALTER … ADD).
ALTER TABLE `plan_vote` ADD `answered_via` text;--> statement-breakpoint
ALTER TABLE `plan_vote` ADD `answered_via_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `plan_vote_token` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `plan_vote_token` ADD `issued_by` text REFERENCES person(id) ON DELETE SET NULL;
