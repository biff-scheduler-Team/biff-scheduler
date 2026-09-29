ALTER TABLE `film_vote_contribution` ADD `comment` text;--> statement-breakpoint
ALTER TABLE `film_vote_contribution` ADD `display_name` text;--> statement-breakpoint
CREATE INDEX `film_vote_contribution_recent` ON `film_vote_contribution` (`edition`,`updated_at`);