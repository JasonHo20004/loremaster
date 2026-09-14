ALTER TABLE loremaster.attempts
  ADD CONSTRAINT attempts_id_guest_id_key UNIQUE (id, guest_id);

ALTER TABLE loremaster.guest_sessions
  ADD CONSTRAINT guest_sessions_one_identity_per_guest UNIQUE (guest_id);

ALTER TABLE loremaster.command_receipts
  ADD CONSTRAINT command_receipt_attempt_belongs_to_guest
  FOREIGN KEY (attempt_id, guest_id)
  REFERENCES loremaster.attempts(id, guest_id) ON DELETE RESTRICT;

ALTER TABLE loremaster.command_receipts
  ADD CONSTRAINT command_receipt_success_is_complete
  CHECK (
    attempt_id IS NOT NULL
    AND committed_version IS NOT NULL
    AND (
      (command_kind = 'START' AND outcome_code = 'STARTED')
      OR (command_kind = 'GUESS' AND outcome_code IN ('CORRECT', 'WRONG'))
      OR (command_kind = 'REVEAL' AND outcome_code = 'REVEALED')
      OR (command_kind = 'GIVE_UP' AND outcome_code = 'GIVEN_UP')
    )
  ) NOT VALID;

ALTER TABLE loremaster.command_receipts
  VALIDATE CONSTRAINT command_receipt_success_is_complete;

CREATE OR REPLACE FUNCTION loremaster.retain_live_session_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM loremaster.guests WHERE id = OLD.guest_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM loremaster.guest_sessions
    WHERE guest_id = OLD.guest_id AND expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'receipt must be retained until every guest session expires';
  END IF;
  RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION loremaster.validate_receipt_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'command receipts are immutable';
  END IF;
  PERFORM 1 FROM loremaster.guests WHERE id = NEW.guest_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM loremaster.guest_sessions
    WHERE id = NEW.session_id AND guest_id = NEW.guest_id
      AND expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'receipt requires a live guest session';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION loremaster.serialize_guest_session_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_guest_id uuid;
BEGIN
  target_guest_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.guest_id ELSE NEW.guest_id END;
  PERFORM 1 FROM loremaster.guests WHERE id = target_guest_id FOR UPDATE;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'guest session identities cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.id <> OLD.id
    OR NEW.guest_id <> OLD.guest_id
    OR NEW.token_hash <> OLD.token_hash
    OR NEW.csrf_hash <> OLD.csrf_hash
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at > OLD.expires_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'guest session identity and absolute expiry are immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER serialize_guest_session_write
BEFORE INSERT OR UPDATE OR DELETE ON loremaster.guest_sessions
FOR EACH ROW EXECUTE FUNCTION loremaster.serialize_guest_session_write();

REVOKE UPDATE, DELETE ON
  loremaster.guesses, loremaster.command_receipts,
  loremaster.attempt_finalizations, loremaster.participation_days,
  loremaster.knowledge_contributions, loremaster.leaderboard_entries
FROM loremaster_runtime;

REVOKE DELETE ON
  loremaster.attempts, loremaster.regional_knowledge,
  loremaster.guest_sessions
FROM loremaster_runtime;
