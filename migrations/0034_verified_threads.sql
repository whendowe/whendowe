-- rc42 (DESIGN §10 *Who really answered*), slice 4c: a verified plan thread — votes only
-- from a mailed link or signed in, and no shared link. Null: not verified.
ALTER TABLE `plan_thread` ADD `verified_at` text;