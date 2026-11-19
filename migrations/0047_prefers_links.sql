-- rc51 (DESIGN §10 *Mail that stops*), slice M2: an opt-out may say "{name} can send me the
-- link", which changes only what that person reads in a verified plan of two. Additive, with
-- a default: every opt-out made before it is a plain one.
ALTER TABLE `mail_suppression` ADD `prefers_links` integer DEFAULT 0 NOT NULL;