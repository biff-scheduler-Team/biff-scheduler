-- 只新增公共库存快照，不触碰账号片单；失败也保留，不覆盖、不清理历史。
CREATE TABLE ticket_snapshot (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('GUEST', 'WEB')),
  date TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  scheduled_at INTEGER,
  source TEXT NOT NULL CHECK(source IN ('scheduled', 'manual')),
  status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
  payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
  error TEXT
);
CREATE INDEX ticket_snapshot_lookup ON ticket_snapshot(channel, date, captured_at, id);
CREATE UNIQUE INDEX ticket_snapshot_scheduled ON ticket_snapshot(channel, date, scheduled_at);

-- 同一调度分钟仅一个执行者；仅运行状态可在租约超时后重试。
CREATE TABLE ticket_collection_run (
  scheduled_at INTEGER PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
