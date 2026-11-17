-- rc40 (DESIGN §10 *Google Calendar, one way*), MVP-4 G3: "Don't put this in my calendar".
-- 0 takes the event out of this person's feeds and synced calendar, for them only. Additive:
-- a default of 1, so every existing participation stays in its calendar; no backfill.
ALTER TABLE `event_participation` ADD `in_calendar` integer DEFAULT 1 NOT NULL;
