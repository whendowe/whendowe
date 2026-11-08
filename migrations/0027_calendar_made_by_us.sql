-- rc40 (DESIGN §10 *Google Calendar, one way*): whether WhenDoWe made the connected calendar,
-- so disconnecting can offer to delete it. Existing connections were their owners' own.
ALTER TABLE `calendar_connection` ADD `made_by_us` integer DEFAULT 0 NOT NULL;
