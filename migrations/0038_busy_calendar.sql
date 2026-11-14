-- rc41 (DESIGN §10 *Busy times while you pick*), MVP-4 B2: the Google calendars whose busy
-- times shade a person's picker. Only their ids; deleted with the connection. New table only.
CREATE TABLE `busy_calendar` (
	`connection_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	PRIMARY KEY(`connection_id`, `calendar_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `calendar_connection`(`id`) ON UPDATE no action ON DELETE cascade
);
