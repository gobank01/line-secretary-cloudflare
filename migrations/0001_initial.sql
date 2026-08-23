PRAGMA foreign_keys = ON;

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE groups (
  source_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  data_mode TEXT NOT NULL CHECK (data_mode IN ('real', 'demo')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  category_id INTEGER REFERENCES categories(id),
  category_source TEXT CHECK (category_source IN ('ai', 'manual')),
  category_locked INTEGER NOT NULL DEFAULT 0 CHECK (category_locked IN (0, 1)),
  category_confidence REAL,
  needs_category_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_category_review IN (0, 1)),
  priority_score INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  last_summary_at INTEGER,
  disclosure_sent_at INTEGER,
  joined_at INTEGER,
  left_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX groups_mode_active_priority ON groups(data_mode, active, priority_score DESC);
CREATE INDEX groups_category_priority ON groups(category_id, priority_score DESC);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_message_id TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL REFERENCES groups(source_id),
  user_id TEXT,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  sent_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  processed_at INTEGER,
  retention_expires_at INTEGER NOT NULL
);

CREATE INDEX messages_processing ON messages(group_id, processed_at, sent_at);
CREATE INDEX messages_retention ON messages(retention_expires_at);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(source_id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  summary TEXT NOT NULL,
  action_items_json TEXT NOT NULL DEFAULT '[]',
  unresolved_json TEXT NOT NULL DEFAULT '[]',
  priority_score INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  notified_at INTEGER
);

CREATE INDEX reports_group_created ON reports(group_id, created_at DESC);
CREATE INDEX reports_notification ON reports(notified_at, created_at);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(source_id),
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  excerpt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  UNIQUE(kind, message_id)
);

CREATE INDEX alerts_status_created ON alerts(status, created_at DESC);
CREATE INDEX alerts_group_created ON alerts(group_id, created_at DESC);

CREATE TABLE digest_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key TEXT NOT NULL UNIQUE,
  retry_key TEXT NOT NULL UNIQUE,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  message_count INTEGER NOT NULL DEFAULT 0,
  line_request_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_for INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL,
  groups_selected INTEGER NOT NULL DEFAULT 0,
  groups_completed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_attempts (
  ip_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  blocked_until INTEGER
);

CREATE TABLE usage_daily (
  day TEXT PRIMARY KEY,
  ai_calls INTEGER NOT NULL DEFAULT 0,
  ai_input_tokens INTEGER NOT NULL DEFAULT 0,
  ai_output_tokens INTEGER NOT NULL DEFAULT 0,
  line_pushes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'ai', 'system')),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX audit_entity_created ON audit_log(entity_type, entity_id, created_at DESC);

INSERT INTO categories(slug, name, color, sort_order) VALUES
  ('customer', 'ลูกค้า', '#0ea5e9', 1),
  ('team', 'ทีมงาน', '#8b5cf6', 2),
  ('order', 'ออเดอร์', '#10b981', 3),
  ('partner', 'คู่ค้า', '#f59e0b', 4),
  ('project', 'โปรเจกต์', '#ec4899', 5),
  ('other', 'อื่น ๆ', '#64748b', 6);

INSERT INTO settings(key, value_json, updated_at) VALUES
  ('alert_words', '["ยกเลิก","คืนเงิน","ไม่พอใจ","ด่วน","เคลม","แย่มาก"]', unixepoch()),
  ('workdays', '[1,2,3,4,5]', unixepoch()),
  ('digest_hours', '[8,9,10,11,12,13,14,15,16,17]', unixepoch()),
  ('retention_days', '30', unixepoch()),
  ('automated_monthly_push_cap', '280', unixepoch());
