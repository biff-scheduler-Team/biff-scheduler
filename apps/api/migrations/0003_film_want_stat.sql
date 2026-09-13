CREATE TABLE `film_want_contribution` (
	`edition` text NOT NULL,
	`film_key` text NOT NULL,
	`contributor` text NOT NULL,
	`weight` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `film_key`, `contributor`)
);
--> statement-breakpoint
CREATE INDEX `film_want_contribution_contributor` ON `film_want_contribution` (`edition`,`contributor`);
--> statement-breakpoint
CREATE TABLE `film_want_stat` (
	`edition` text NOT NULL,
	`film_key` text NOT NULL,
	`weight_sum` text DEFAULT '0' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `film_key`)
);
