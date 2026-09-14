-- 同场观影人数 + 场次讨论。
--
-- ⚠ 本文件**不是** `drizzle-kit generate` 的原始输出:0003 / 0004 是手工写的迁移、
--   仓库里没留对应的 `meta/0003_snapshot.json` / `0004_snapshot.json`,所以 drizzle 只会
--   拿 `0002_snapshot.json` 做 diff,把 `feedback_*` / `film_want_*` 四张**已存在**的表
--   又生成了一遍 —— 直接 apply 会在「表已存在」上失败(生产库里 0003 / 0004 早就跑过了)。
--   故这里手工裁到只剩本次新增的四张表;`meta/0005_snapshot.json` 是 drizzle 原样产出的,
--   已包含全部 12 张表,保留它可让**后续** `db:generate` 拿到正确基线。
--   下次再改 schema 时,请照此办理:generate 后检查 SQL 是否重复创建旧表,是则手工裁剪。

CREATE TABLE `screening_attendance_contribution` (
	`edition` text NOT NULL,
	`code` text NOT NULL,
	`contributor` text NOT NULL,
	`weight` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `code`, `contributor`)
);
--> statement-breakpoint
CREATE INDEX `screening_attendance_contribution_contributor` ON `screening_attendance_contribution` (`edition`,`contributor`);--> statement-breakpoint
CREATE TABLE `screening_attendance_stat` (
	`edition` text NOT NULL,
	`code` text NOT NULL,
	`weight_sum` text DEFAULT '0' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `code`)
);
--> statement-breakpoint
CREATE TABLE `screening_post` (
	`id` text PRIMARY KEY NOT NULL,
	`edition` text NOT NULL,
	`code` text NOT NULL,
	`subject` text NOT NULL,
	`display_name` text NOT NULL,
	`category` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `screening_post_code_created` ON `screening_post` (`code`,`created_at`);--> statement-breakpoint
CREATE INDEX `screening_post_subject` ON `screening_post` (`subject`);--> statement-breakpoint
CREATE TABLE `screening_reaction` (
	`post_id` text NOT NULL,
	`subject` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`post_id`, `subject`, `emoji`)
);
--> statement-breakpoint
CREATE INDEX `screening_reaction_post` ON `screening_reaction` (`post_id`);
