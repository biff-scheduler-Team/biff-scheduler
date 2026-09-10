-- 0003_user_pick.sql — 「我的行程」与「我的选片」合并为单一数据源:user_plan(场次级) → user_pick(影片级)
--
-- 背景:旧模型有两套互不相干的数据 ——
--   ① user_plan(code, group_tag, priority, note):「我的行程」场次级,已上云;
--   ② 前端 localStorage biff.wish.v1(filmNodeKey → 档位):「我的选片」影片级,从未上云。
-- 两边**各存一份「档位」**,加入行程时继承一次后各自独立 → 改一处另一处不动,两个视图互相打架。
--
-- 现合并为「一部片一条记录」:档位只有一份且在影片级,已选场次挂在 picks(JSON 文本)里,
-- 组归属仍留在场次级(同一部片的两场可以分别放进 A / B 方案)。
--
-- 数据搬运不在 SQL 侧做:把场次 code 归到影片 key 需要前端影片目录(filmNodeKey 口径),
-- 故由前端首次启动时用本地 biff.plan.v1 + biff.wish.v1 合成新结构并回推云端。
--
-- user_plan 表**保留不删**:数据不丢(万一要回查旧口径),只是不再有 API 入口。

CREATE TABLE IF NOT EXISTS user_pick (
  user_id    TEXT NOT NULL DEFAULT 'me',   -- 预留多人
  film_key   TEXT NOT NULL,                -- 影片节点 key:cat:<目录 id> | sched:<片名小写>
  priority   TEXT,                         -- must|maybe|wild(必看/备选/随缘);NULL = 未设档位
  note       TEXT NOT NULL DEFAULT '',
  picks      TEXT NOT NULL DEFAULT '[]',   -- 已选场次 JSON:[{"code":"101","group":"A"}]
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, film_key)
);

CREATE INDEX IF NOT EXISTS idx_user_pick_priority ON user_pick (user_id, priority);
