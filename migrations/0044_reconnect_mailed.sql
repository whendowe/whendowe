-- rc40 (DESIGN §10 *Google Calendar, one way*), MVP-4 G3: when Google stops answering, "one
-- email says so". This records when it went, so the minute's pass sends it once per loss;
-- reconnecting clears it. Additive and nullable, no backfill: NULL is "not mailed", so a
-- connection already in auth_error gets its one email after this deploys.
ALTER TABLE `calendar_connection` ADD `reconnect_mailed_at` text;
