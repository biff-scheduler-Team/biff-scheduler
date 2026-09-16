CREATE TABLE `film_vote_contribution` (
	`edition` text NOT NULL,
	`film_key` text NOT NULL,
	`contributor` text NOT NULL,
	`vote` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `film_key`, `contributor`)
);
--> statement-breakpoint
CREATE INDEX `film_vote_contribution_contributor` ON `film_vote_contribution` (`edition`,`contributor`);--> statement-breakpoint
CREATE TABLE `film_vote_stat` (
	`edition` text NOT NULL,
	`film_key` text NOT NULL,
	`red_count` integer DEFAULT 0 NOT NULL,
	`black_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `film_key`)
);
