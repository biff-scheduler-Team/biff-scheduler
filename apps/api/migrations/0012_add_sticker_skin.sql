CREATE TABLE `film_vote_skin_stat` (
	`edition` text NOT NULL,
	`film_key` text NOT NULL,
	`skin` text NOT NULL,
	`vote` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `film_key`, `skin`, `vote`)
);
--> statement-breakpoint
ALTER TABLE `film_vote_contribution` ADD `skin` text;