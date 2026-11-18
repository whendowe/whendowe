-- rc40 (DESIGN §10 *Google Calendar, one way*), MVP-4 G3: deleting your account asks what
-- happens to the WhenDoWe events in your Google calendar on the day — remove (the default),
-- keep, or delete the calendar WhenDoWe made. Additive, with a default: a deletion already
-- waiting removes them, which is what the page would have chosen.
ALTER TABLE `account_deletion` ADD `calendar_copies` text DEFAULT 'remove' NOT NULL;
