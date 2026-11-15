-- rc40 (DESIGN §10 *Google Calendar, one way*), MVP-4 G2: a copy deleted in Google is not
-- put back for that person. When it was found gone; null for a copy WhenDoWe removed itself,
-- which an event coming back recreates. Additive: a nullable column, no backfill.
ALTER TABLE `projection` ADD `unsubscribed_at` text;
