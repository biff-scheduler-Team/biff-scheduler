
-- 2026-10-05 增量上报的**幂等水位**（PLAN-20261005182415 §C）。
--
-- 为什么需要它：上报从「整份替换」改成「带 seq 的增量 ops」之后，服务端要能回答
-- 「这一批是不是已经落过了」。⚠ 不是因为重放不幂等（每个 op 都是「把这部片设成某状态」，
-- 重放只会得到空差分），而是因为 **keepalive 那一发与正常那一发会乱序到** ——
-- 旧批次若在新批次之后再落，就会把新值改回去。
--
-- ⚠ 主键带 `client_id`：`seq` 是**每台设备各数各的**（各自 1..N）。少了这一维，两台设备会用
--    同一个 `contributor` 把对方的 seq 当成「已落过的重放」跳过 —— 表现是「我这台贴的票上不去」。
-- ⚠ 只存水位，不含任何票的内容；也没有额外索引（查询形状只有一处：按主键读写）。
--> statement-breakpoint

CREATE TABLE `film_vote_sync` (
  `edition` text NOT NULL,
  `contributor` text NOT NULL,
  `client_id` text NOT NULL,
  `last_seq` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`edition`, `contributor`, `client_id`)
);
