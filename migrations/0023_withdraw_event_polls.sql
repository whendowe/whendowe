-- rc35 (DESIGN §10 *Polls are one-event plans*): withdraw every event-poll still open, as its
-- creator would (withdrawProposal): the revision bumped and a change_log row attributed to
-- the creator. An event-poll is `proposed` WITH candidate times; an event waiting for
-- agreement (rc13) is `proposed` with none, and is left alone.
INSERT INTO `change_log` (`canonical_event_id`, `revision`, `actor`, `source`, `diff`, `created_at`)
SELECT e.`id`, e.`revision` + 1, e.`owner_id`, 'ui',
       '{"status":{"before":"proposed","after":"withdrawn"}}',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `canonical_event` e
WHERE e.`status` = 'proposed'
  AND EXISTS (SELECT 1 FROM `event_candidate` c WHERE c.`canonical_event_id` = e.`id`);
--> statement-breakpoint
UPDATE `canonical_event`
SET `status` = 'withdrawn', `revision` = `revision` + 1,
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` = 'proposed'
  AND EXISTS (SELECT 1 FROM `event_candidate` c WHERE c.`canonical_event_id` = `canonical_event`.`id`);
