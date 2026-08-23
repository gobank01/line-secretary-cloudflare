ALTER TABLE digest_deliveries ADD COLUMN quota_day TEXT;
ALTER TABLE digest_deliveries ADD COLUMN quota_month TEXT;
ALTER TABLE digest_deliveries ADD COLUMN attempted_at INTEGER;

UPDATE digest_deliveries
SET quota_day=substr(slot_key,1,10),
    quota_month=substr(slot_key,1,7),
    attempted_at=created_at
WHERE status IN ('pending','sent');

CREATE INDEX digest_quota_day ON digest_deliveries(quota_day, status);
CREATE INDEX digest_quota_month ON digest_deliveries(quota_month, status);
CREATE INDEX digest_retry_attempt ON digest_deliveries(status, attempted_at, created_at);
