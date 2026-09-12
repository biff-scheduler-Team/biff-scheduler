CREATE TABLE `account_import` (
	`subject` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`imported_at` integer NOT NULL
);
