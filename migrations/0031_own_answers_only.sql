-- rc42 (DESIGN §10 *Who really answered*), slice 3a: "only my own email answers for me" on an
-- event, and each member's default for it on what is made from a group. Off for everyone, as
-- before: a person turns it on for themselves.
ALTER TABLE `event_participation` ADD `own_answers_only` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `group_member` ADD `default_own_answers_only` integer DEFAULT 0 NOT NULL;