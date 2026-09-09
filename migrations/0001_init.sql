-- 0001_init.sql — user_plan / douban_map 建表

CREATE TABLE IF NOT EXISTS user_plan (
  user_id    TEXT NOT NULL DEFAULT 'me',   -- 预留多人
  code       TEXT NOT NULL,                -- 排片单场次 code(3位)
  group_tag  TEXT NOT NULL DEFAULT 'A',    -- 'A'|'B' 双方案
  priority   TEXT NOT NULL DEFAULT 'maybe',-- must|maybe|wild(必看/备选/随缘)
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, code)
);

CREATE INDEX IF NOT EXISTS idx_user_plan_group ON user_plan (user_id, group_tag);

CREATE TABLE IF NOT EXISTS douban_map (
  code        TEXT NOT NULL PRIMARY KEY,
  subject_id  INTEGER,                     -- 豆瓣条目 id
  title_cn    TEXT,                        -- 用户/LLM 补的中文片名
  douban_url  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
