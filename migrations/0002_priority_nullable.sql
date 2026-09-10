-- 0002_priority_nullable.sql — 允许 priority 为 NULL(「未设档位」)
--
-- 背景:0001 建表为 `priority TEXT NOT NULL DEFAULT 'maybe'`,前端新加入场次时
-- 硬编码落 'maybe',导致用户「没标备选却被显示为备选」。前端改为 NULL = 未设后,
-- 必须让 NULL 能穿透 D1,否则 syncFromCloud(云端为准)会把 NULL 覆盖回 'maybe'。
--
-- SQLite 不支持 `ALTER COLUMN ... DROP NOT NULL`(只支持 RENAME / ADD COLUMN / DROP COLUMN),
-- 故按官方推荐的「建新表 → 拷数据 → 换名」三步重建。
-- 历史 'maybe' 数据原样保留、不回填成 NULL —— 无法区分「用户主动选备选」与「旧默认值」,保守不动。

DROP TABLE IF EXISTS user_plan_new;

CREATE TABLE user_plan_new (
  user_id    TEXT NOT NULL DEFAULT 'me',   -- 预留多人
  code       TEXT NOT NULL,                -- 排片单场次 code(3位)
  group_tag  TEXT NOT NULL DEFAULT 'A',    -- 'A'|'B' 双方案
  priority   TEXT,                         -- must|maybe|wild(必看/备选/随缘);NULL = 未设档位
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, code)
);

INSERT INTO user_plan_new (user_id, code, group_tag, priority, note, created_at, updated_at)
  SELECT user_id, code, group_tag, priority, note, created_at, updated_at FROM user_plan;

DROP TABLE user_plan;

ALTER TABLE user_plan_new RENAME TO user_plan;

CREATE INDEX IF NOT EXISTS idx_user_plan_group ON user_plan (user_id, group_tag);
