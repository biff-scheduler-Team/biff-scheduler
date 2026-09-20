-- 事件流水（页面浏览 / 点击），2026-09-20 第 3 轮（PLAN-20260920203010 修订 2）。
-- 形状照抄既有贡献 / 聚合两张表，但**语义是计数而不是状态**（见 schema.ts 的说明）：
-- 同一人的同一 target 只一行，`hits` 累积次数；聚合表同时存「多少人用过」与「总共用了多少次」。
-- ⚠ 用户明确：**默认直接上报、不加提示、不加不追踪开关**，且**搜索完全不进统计** ——
--   故本表没有 kind = "search"，`kind` 白名单只有 page / click（收口在 telemetry-stats.ts）。
-- ⚠ 本次 `drizzle-kit generate` 只生成了这两张新表（未重复创建旧表），故未做手工裁剪。

CREATE TABLE `telemetry_contribution` (
	`edition` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`contributor` text NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`weight` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `kind`, `target`, `contributor`)
);
--> statement-breakpoint
CREATE INDEX `telemetry_contribution_contributor` ON `telemetry_contribution` (`edition`,`contributor`);--> statement-breakpoint
CREATE TABLE `telemetry_stat` (
	`edition` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`viewer_weight_sum` text DEFAULT '0' NOT NULL,
	`hits_weight_sum` text DEFAULT '0' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `kind`, `target`)
);
