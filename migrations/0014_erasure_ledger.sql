CREATE TABLE `erasure_ledger` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`erased_at` text NOT NULL,
	PRIMARY KEY(`kind`, `id`),
	CONSTRAINT "erasure_ledger_kind_chk" CHECK("erasure_ledger"."kind" IN ('person', 'event', 'group', 'thread'))
);
