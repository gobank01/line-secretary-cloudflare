ALTER TABLE digest_deliveries ADD COLUMN message_text TEXT;
ALTER TABLE digest_deliveries ADD COLUMN alert_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE digest_deliveries ADD COLUMN report_ids_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX digest_retry_queue ON digest_deliveries(status, created_at);

ALTER TABLE alerts ADD COLUMN digest_finalized_at INTEGER;
ALTER TABLE reports ADD COLUMN digest_finalized_at INTEGER;

ALTER TABLE groups ADD COLUMN summary_inflight_for INTEGER;
ALTER TABLE groups ADD COLUMN summary_inflight_until INTEGER;

CREATE INDEX groups_summary_reservation ON groups(data_mode, active, summary_inflight_until);
