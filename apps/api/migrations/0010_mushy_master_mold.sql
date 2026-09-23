CREATE TABLE `stat_daily` (
	`edition` text NOT NULL,
	`day` text NOT NULL,
	`metric` text NOT NULL,
	`target` text NOT NULL,
	`weight_sum` text NOT NULL,
	`hits_sum` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `day`, `metric`, `target`)
);
