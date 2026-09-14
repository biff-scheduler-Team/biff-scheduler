CREATE TABLE `feedback_post` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`display_name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_post_created` ON `feedback_post` (`created_at`);
--> statement-breakpoint
CREATE INDEX `feedback_post_subject` ON `feedback_post` (`subject`);
--> statement-breakpoint
CREATE TABLE `feedback_reaction` (
	`post_id` text NOT NULL,
	`subject` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`post_id`, `subject`, `emoji`)
);
--> statement-breakpoint
CREATE INDEX `feedback_reaction_post` ON `feedback_reaction` (`post_id`);
