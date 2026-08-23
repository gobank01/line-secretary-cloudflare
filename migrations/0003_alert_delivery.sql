ALTER TABLE alerts ADD COLUMN notified_at INTEGER;

CREATE INDEX alerts_notification ON alerts(notified_at, created_at);
