CREATE TABLE ai_call_reservations (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'consumed', 'released')),
  estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  released_at INTEGER
);

CREATE INDEX ai_call_reservations_day_status ON ai_call_reservations(day, status);
CREATE INDEX ai_call_reservations_workflow ON ai_call_reservations(workflow_id, created_at);

CREATE TRIGGER ai_call_reservation_count_insert
AFTER INSERT ON ai_call_reservations
BEGIN
  INSERT INTO usage_daily(day,ai_calls,ai_input_tokens,ai_output_tokens,line_pushes,updated_at)
  VALUES(NEW.day,1,0,0,0,NEW.created_at)
  ON CONFLICT(day) DO UPDATE SET
    ai_calls=usage_daily.ai_calls+1,
    updated_at=excluded.updated_at;
END;

CREATE TRIGGER ai_call_reservation_consume
AFTER UPDATE OF status ON ai_call_reservations
WHEN OLD.status='reserved' AND NEW.status='consumed'
BEGIN
  UPDATE usage_daily
  SET ai_input_tokens=ai_input_tokens+NEW.estimated_input_tokens,
      updated_at=NEW.consumed_at
  WHERE day=NEW.day;
END;

CREATE TRIGGER ai_call_reservation_release
AFTER UPDATE OF status ON ai_call_reservations
WHEN OLD.status='reserved' AND NEW.status='released'
BEGIN
  UPDATE usage_daily
  SET ai_calls=max(0,ai_calls-1),
      updated_at=NEW.released_at
  WHERE day=OLD.day;
END;
