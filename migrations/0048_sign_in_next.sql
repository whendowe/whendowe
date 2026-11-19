-- rc51 (DESIGN §10 *Mail that stops*), slice M3: sign-in comes back to the page that asked for
-- it. The path is kept with the login token, never in the emailed link. Additive and nullable:
-- a link issued before it lands on home, as every link did.
ALTER TABLE `login_token` ADD `next_path` text;