ALTER TABLE ai_call_reservations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

UPDATE ai_call_reservations SET attempt_count=1 WHERE status='consumed';

DROP TRIGGER ai_call_reservation_consume;

CREATE TRIGGER ai_call_reservation_attempt
AFTER UPDATE OF attempt_count ON ai_call_reservations
WHEN NEW.attempt_count=OLD.attempt_count+1
BEGIN
  UPDATE usage_daily
  SET ai_calls=ai_calls+CASE WHEN OLD.attempt_count=0 THEN 0 ELSE 1 END,
      ai_input_tokens=ai_input_tokens+NEW.estimated_input_tokens,
      updated_at=NEW.consumed_at
  WHERE day=NEW.day;
END;
