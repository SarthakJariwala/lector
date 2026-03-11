CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  name TEXT,
  platform TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  feed_url TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_changed_at INTEGER NOT NULL,
  name_changed_by TEXT NOT NULL,
  subscribed INTEGER NOT NULL,
  subscription_changed_at INTEGER NOT NULL,
  subscription_changed_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS article_state (
  article_id TEXT PRIMARY KEY,
  feed_url TEXT NOT NULL,
  read_value INTEGER NOT NULL DEFAULT 0,
  read_changed_at INTEGER NOT NULL DEFAULT 0,
  read_changed_by TEXT NOT NULL DEFAULT '',
  starred_value INTEGER NOT NULL DEFAULT 0,
  starred_changed_at INTEGER NOT NULL DEFAULT 0,
  starred_changed_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS applied_mutations (
  device_id TEXT NOT NULL,
  mutation_id INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  source_device_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_article_state_feed_url ON article_state(feed_url);
CREATE INDEX IF NOT EXISTS idx_change_log_seq ON change_log(seq);
