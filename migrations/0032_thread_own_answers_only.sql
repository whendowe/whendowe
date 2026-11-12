-- rc42 (DESIGN §10 *Who really answered*), slice 3b: "only my own email answers for me" in a
-- plan thread. Off for everyone, as before: a person turns it on for themselves.
ALTER TABLE `plan_thread_member` ADD `own_answers_only` integer DEFAULT 0 NOT NULL;