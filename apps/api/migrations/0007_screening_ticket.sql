-- 抢票结果（抢票分析模块，2026-09-20）。
--
-- 形状照抄 0005 的 `screening_attendance_*`：贡献表记「谁每场最后怎样了」，聚合表记「每场四项各多少」。
-- ⚠ 与 0005 不同处：聚合表**没有** `weight_sum` —— 四项互斥、求和即总量（多一个冗余列只会漂移）。
-- ⚠ 本次 `drizzle-kit generate` 只生成了这两张新表（未重复创建旧表），故**未做手工裁剪**；
--   `meta/0007_snapshot.json` 是 drizzle 原样产出，作为后续 `db:generate` 的基线保留。
--   下次改 schema 仍要照 0005 文件头的办法检查一遍。

CREATE TABLE `screening_ticket_contribution` (
	`edition` text NOT NULL,
	`code` text NOT NULL,
	`contributor` text NOT NULL,
	`outcome` text NOT NULL,
	`weight` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `code`, `contributor`)
);
--> statement-breakpoint
CREATE INDEX `screening_ticket_contribution_contributor` ON `screening_ticket_contribution` (`edition`,`contributor`);--> statement-breakpoint
CREATE TABLE `screening_ticket_stat` (
	`edition` text NOT NULL,
	`code` text NOT NULL,
	`got_sum` text DEFAULT '0' NOT NULL,
	`transfer_sum` text DEFAULT '0' NOT NULL,
	`missed_sum` text DEFAULT '0' NOT NULL,
	`dropped_sum` text DEFAULT '0' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`edition`, `code`)
);
