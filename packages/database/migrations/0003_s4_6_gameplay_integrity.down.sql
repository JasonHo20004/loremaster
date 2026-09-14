GRANT UPDATE, DELETE ON
  loremaster.guesses, loremaster.command_receipts,
  loremaster.attempt_finalizations, loremaster.participation_days,
  loremaster.knowledge_contributions, loremaster.leaderboard_entries
TO loremaster_runtime;

GRANT DELETE ON
  loremaster.attempts, loremaster.regional_knowledge,
  loremaster.guest_sessions
TO loremaster_runtime;

DROP TRIGGER serialize_guest_session_write ON loremaster.guest_sessions;
DROP FUNCTION loremaster.serialize_guest_session_write();

ALTER TABLE loremaster.guest_sessions
  DROP CONSTRAINT guest_sessions_one_identity_per_guest;

CREATE OR REPLACE FUNCTION loremaster.validate_receipt_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'command receipts are immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM loremaster.guest_sessions
    WHERE id = NEW.session_id AND guest_id = NEW.guest_id
      AND expires_at > clock_timestamp()
    FOR KEY SHARE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'receipt requires a live guest session';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION loremaster.retain_live_session_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM loremaster.guest_sessions
    WHERE id = OLD.session_id AND expires_at > clock_timestamp()
    FOR KEY SHARE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'receipt must be retained until its session expires';
  END IF;
  RETURN OLD;
END
$$;

ALTER TABLE loremaster.command_receipts
  DROP CONSTRAINT command_receipt_success_is_complete;

ALTER TABLE loremaster.command_receipts
  DROP CONSTRAINT command_receipt_attempt_belongs_to_guest;

ALTER TABLE loremaster.attempts
  DROP CONSTRAINT attempts_id_guest_id_key;
