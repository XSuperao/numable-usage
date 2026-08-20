-- numable-usage · 初始 schema
-- 刻意不存任何令牌（连 hash 都不存）：write/read token 由 HMAC(TOKEN_SECRET, kind:spaceId) 派生。
-- 唯一落库的凭证是短码的 hash，且带过期时间。

CREATE TABLE IF NOT EXISTS spaces (
  space_id     TEXT PRIMARY KEY,
  code_hash    TEXT,
  code_exp     INTEGER,
  created_at   INTEGER NOT NULL,
  last_push_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_spaces_code ON spaces(code_hash);
CREATE INDEX IF NOT EXISTS idx_spaces_seen ON spaces(last_push_at);

-- 每 (空间, 数据源, 设备) 一行，覆盖写。payload 只含 schema 白名单字段。
CREATE TABLE IF NOT EXISTS snapshots (
  space_id   TEXT NOT NULL,
  source     TEXT NOT NULL,
  device     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, source, device)
);

-- 限流计数窗口
CREATE TABLE IF NOT EXISTS rl (
  k   TEXT PRIMARY KEY,
  win INTEGER NOT NULL,
  n   INTEGER NOT NULL
);
