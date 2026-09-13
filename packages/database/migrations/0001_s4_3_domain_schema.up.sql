CREATE EXTENSION IF NOT EXISTS btree_gist;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loremaster_importer') THEN
    CREATE ROLE loremaster_importer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loremaster_runtime') THEN
    CREATE ROLE loremaster_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$roles$;

CREATE SCHEMA loremaster;
REVOKE ALL ON SCHEMA loremaster FROM PUBLIC;
GRANT USAGE ON SCHEMA loremaster TO loremaster_importer, loremaster_runtime;

CREATE TABLE loremaster.content_packs (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL UNIQUE CHECK (stable_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE loremaster.region_catalog (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{0,63}$')
);

CREATE TABLE loremaster.case_revisions (
  id uuid PRIMARY KEY,
  pack_id uuid NOT NULL REFERENCES loremaster.content_packs(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  slot_id date NOT NULL,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  briefing text NOT NULL,
  answer_entity_id uuid,
  answer_is_eligible boolean GENERATED ALWAYS AS (true) STORED,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (pack_id, revision_number),
  UNIQUE (id, slot_id),
  UNIQUE (id, slot_id, status),
  CHECK (opens_at < closes_at),
  CHECK (closes_at = opens_at + interval '1 day'),
  CHECK (opens_at = slot_id::timestamp AT TIME ZONE 'UTC'),
  CHECK ((status = 'DRAFT' AND published_at IS NULL) OR
         (status = 'PUBLISHED' AND published_at IS NOT NULL AND answer_entity_id IS NOT NULL))
);

ALTER TABLE loremaster.case_revisions
  ADD CONSTRAINT published_case_windows_do_not_overlap
  EXCLUDE USING gist (tstzrange(opens_at, closes_at, '[)') WITH &&)
  WHERE (status = 'PUBLISHED');

CREATE TABLE loremaster.case_entities (
  revision_id uuid NOT NULL REFERENCES loremaster.case_revisions(id) ON DELETE RESTRICT,
  entity_id uuid NOT NULL,
  canonical_name text NOT NULL,
  role text NOT NULL,
  is_eligible boolean NOT NULL DEFAULT true,
  PRIMARY KEY (revision_id, entity_id),
  UNIQUE (revision_id, entity_id, is_eligible),
  UNIQUE (revision_id, canonical_name)
);

ALTER TABLE loremaster.case_revisions
  ADD CONSTRAINT answer_must_be_an_eligible_revision_entity
  FOREIGN KEY (id, answer_entity_id, answer_is_eligible)
  REFERENCES loremaster.case_entities(revision_id, entity_id, is_eligible)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE loremaster.entity_aliases (
  revision_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  alias text NOT NULL,
  PRIMARY KEY (revision_id, alias),
  FOREIGN KEY (revision_id, entity_id)
    REFERENCES loremaster.case_entities(revision_id, entity_id) ON DELETE RESTRICT
);

CREATE TABLE loremaster.revision_regions (
  revision_id uuid NOT NULL REFERENCES loremaster.case_revisions(id) ON DELETE RESTRICT,
  region_id text NOT NULL REFERENCES loremaster.region_catalog(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  PRIMARY KEY (revision_id, region_id)
);

CREATE TABLE loremaster.case_evidence (
  revision_id uuid NOT NULL REFERENCES loremaster.case_revisions(id) ON DELETE RESTRICT,
  evidence_order smallint NOT NULL CHECK (evidence_order BETWEEN 1 AND 4),
  evidence_text text NOT NULL,
  explanation text NOT NULL,
  PRIMARY KEY (revision_id, evidence_order)
);

CREATE TABLE loremaster.case_sources (
  revision_id uuid NOT NULL REFERENCES loremaster.case_revisions(id) ON DELETE RESTRICT,
  source_order smallint NOT NULL CHECK (source_order > 0),
  source_id text NOT NULL,
  citation text NOT NULL,
  PRIMARY KEY (revision_id, source_order),
  UNIQUE (revision_id, source_id)
);

CREATE FUNCTION loremaster.reject_catalog_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'immutable catalog rows cannot be changed';
END
$$;

CREATE TRIGGER region_catalog_is_immutable
BEFORE UPDATE OR DELETE ON loremaster.region_catalog
FOR EACH ROW EXECUTE FUNCTION loremaster.reject_catalog_mutation();

CREATE FUNCTION loremaster.lock_and_reject_frozen_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO STRICT revision_status
    FROM loremaster.case_revisions WHERE id = OLD.revision_id FOR SHARE;
    IF revision_status = 'PUBLISHED' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published revision content is immutable';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO STRICT revision_status
    FROM loremaster.case_revisions WHERE id = NEW.revision_id FOR SHARE;
    IF revision_status = 'PUBLISHED' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published revision content is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION loremaster.protect_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published revisions cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published revisions cannot be changed';
  END IF;
  IF NEW.status = 'PUBLISHED' THEN
    IF NEW.answer_entity_id IS NULL OR
       (SELECT count(*) FROM loremaster.case_evidence WHERE revision_id = NEW.id) <> 4 OR
       EXISTS (
         SELECT 1 FROM generate_series(1, 4) AS required(evidence_order)
         WHERE NOT EXISTS (
           SELECT 1 FROM loremaster.case_evidence e
           WHERE e.revision_id = NEW.id AND e.evidence_order = required.evidence_order
         )
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'published revision graph is incomplete';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER protect_case_revision
BEFORE UPDATE OR DELETE ON loremaster.case_revisions
FOR EACH ROW EXECUTE FUNCTION loremaster.protect_revision();

CREATE TRIGGER validate_case_revision_insert
BEFORE INSERT ON loremaster.case_revisions
FOR EACH ROW WHEN (NEW.status = 'PUBLISHED')
EXECUTE FUNCTION loremaster.protect_revision();

DO $triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['case_entities', 'entity_aliases', 'revision_regions', 'case_evidence', 'case_sources']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER freeze_%1$I BEFORE INSERT OR UPDATE OR DELETE ON loremaster.%1$I FOR EACH ROW EXECUTE FUNCTION loremaster.lock_and_reject_frozen_child()',
      table_name
    );
  END LOOP;
END
$triggers$;

CREATE TABLE loremaster.guests (
  id uuid PRIMARY KEY,
  pseudonym text NOT NULL CHECK (char_length(pseudonym) BETWEEN 1 AND 48),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE loremaster.guest_sessions (
  id uuid PRIMARY KEY,
  guest_id uuid NOT NULL REFERENCES loremaster.guests(id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  UNIQUE (id, guest_id)
);

CREATE TABLE loremaster.attempts (
  id uuid PRIMARY KEY,
  guest_id uuid NOT NULL REFERENCES loremaster.guests(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL,
  slot_id date NOT NULL,
  revision_status text GENERATED ALWAYS AS ('PUBLISHED') STORED,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'SOLVED', 'GIVEN_UP', 'EXHAUSTED', 'EXPIRED')),
  evidence_level smallint NOT NULL DEFAULT 0 CHECK (evidence_level BETWEEN 0 AND 4),
  wrong_guesses_at_level smallint NOT NULL DEFAULT 0 CHECK (wrong_guesses_at_level BETWEEN 0 AND 2),
  total_wrong_guesses smallint NOT NULL DEFAULT 0 CHECK (total_wrong_guesses BETWEEN 0 AND 15),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  terminal_at timestamptz,
  UNIQUE (guest_id, slot_id),
  UNIQUE (id, revision_id),
  UNIQUE (id, guest_id, slot_id),
  UNIQUE (id, guest_id, slot_id, state),
  UNIQUE (id, guest_id, slot_id, state, evidence_level, total_wrong_guesses),
  FOREIGN KEY (revision_id, slot_id, revision_status)
    REFERENCES loremaster.case_revisions(id, slot_id, status) ON DELETE RESTRICT,
  CHECK (updated_at >= started_at),
  CHECK (terminal_at IS NULL OR terminal_at >= started_at),
  CHECK ((state = 'ACTIVE' AND terminal_at IS NULL) OR (state <> 'ACTIVE' AND terminal_at IS NOT NULL)),
  CHECK (
    (state = 'EXHAUSTED' AND evidence_level = 4 AND wrong_guesses_at_level = 2 AND total_wrong_guesses = 15)
    OR
    (state <> 'EXHAUSTED' AND total_wrong_guesses >= wrong_guesses_at_level
      AND total_wrong_guesses <= evidence_level * 3 + wrong_guesses_at_level)
  )
);

CREATE INDEX attempts_guest_slot_order_idx ON loremaster.attempts (guest_id, slot_id, id);
CREATE INDEX attempts_active_expiry_idx ON loremaster.attempts (slot_id, id) WHERE state = 'ACTIVE';

CREATE TABLE loremaster.guesses (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  guess_number smallint NOT NULL CHECK (guess_number BETWEEN 1 AND 15),
  entity_id uuid NOT NULL,
  entity_is_eligible boolean GENERATED ALWAYS AS (true) STORED,
  was_correct boolean NOT NULL,
  evidence_level smallint NOT NULL CHECK (evidence_level BETWEEN 0 AND 4),
  guessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attempt_id, guess_number),
  FOREIGN KEY (attempt_id, revision_id) REFERENCES loremaster.attempts(id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, entity_id, entity_is_eligible)
    REFERENCES loremaster.case_entities(revision_id, entity_id, is_eligible) ON DELETE RESTRICT
);

CREATE TABLE loremaster.command_receipts (
  id uuid PRIMARY KEY,
  guest_id uuid NOT NULL REFERENCES loremaster.guests(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  command_fingerprint bytea NOT NULL CHECK (octet_length(command_fingerprint) = 32),
  command_kind text NOT NULL CHECK (command_kind IN ('START', 'GUESS', 'REVEAL', 'GIVE_UP')),
  outcome_code text NOT NULL CHECK (char_length(outcome_code) BETWEEN 1 AND 64),
  attempt_id uuid REFERENCES loremaster.attempts(id) ON DELETE RESTRICT,
  committed_version integer CHECK (committed_version IS NULL OR committed_version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (guest_id, idempotency_key),
  FOREIGN KEY (session_id, guest_id) REFERENCES loremaster.guest_sessions(id, guest_id) ON DELETE RESTRICT
);

CREATE INDEX command_receipts_session_idx ON loremaster.command_receipts (session_id, created_at);

CREATE FUNCTION loremaster.validate_receipt_write() RETURNS trigger
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

CREATE TRIGGER validate_command_receipt_write
BEFORE INSERT OR UPDATE ON loremaster.command_receipts
FOR EACH ROW EXECUTE FUNCTION loremaster.validate_receipt_write();

CREATE FUNCTION loremaster.retain_live_session_receipt() RETURNS trigger
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

CREATE TRIGGER retain_command_receipt
BEFORE DELETE ON loremaster.command_receipts
FOR EACH ROW EXECUTE FUNCTION loremaster.retain_live_session_receipt();

CREATE TABLE loremaster.attempt_finalizations (
  attempt_id uuid PRIMARY KEY,
  guest_id uuid NOT NULL,
  slot_id date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SOLVED', 'GIVEN_UP', 'EXHAUSTED', 'EXPIRED')),
  score integer NOT NULL CHECK (score >= 0),
  finalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attempt_id, guest_id, slot_id, outcome),
  UNIQUE (attempt_id, guest_id, slot_id, outcome, score),
  FOREIGN KEY (attempt_id, guest_id, slot_id, outcome)
    REFERENCES loremaster.attempts(id, guest_id, slot_id, state) ON DELETE RESTRICT,
  CHECK ((outcome = 'SOLVED') OR score = 0)
);

CREATE TABLE loremaster.participation_days (
  guest_id uuid NOT NULL REFERENCES loremaster.guests(id) ON DELETE RESTRICT,
  utc_day date NOT NULL,
  first_guess_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (guest_id, utc_day)
);

CREATE TABLE loremaster.knowledge_contributions (
  attempt_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  slot_id date NOT NULL,
  outcome text NOT NULL,
  region_id text NOT NULL,
  alpha_delta numeric(4,2) NOT NULL,
  beta_delta numeric(4,2) NOT NULL,
  PRIMARY KEY (attempt_id, region_id),
  FOREIGN KEY (attempt_id, guest_id, slot_id, outcome)
    REFERENCES loremaster.attempt_finalizations(attempt_id, guest_id, slot_id, outcome) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, revision_id) REFERENCES loremaster.attempts(id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, region_id) REFERENCES loremaster.revision_regions(revision_id, region_id) ON DELETE RESTRICT,
  CHECK (alpha_delta >= 0 AND beta_delta >= 0 AND alpha_delta + beta_delta = 1.00),
  CHECK ((outcome = 'SOLVED') OR alpha_delta = 0)
);

CREATE TABLE loremaster.regional_knowledge (
  guest_id uuid NOT NULL REFERENCES loremaster.guests(id) ON DELETE RESTRICT,
  region_id text NOT NULL REFERENCES loremaster.region_catalog(id) ON DELETE RESTRICT,
  alpha numeric(12,2) NOT NULL DEFAULT 2.00 CHECK (alpha >= 2.00),
  beta numeric(12,2) NOT NULL DEFAULT 2.00 CHECK (beta >= 2.00),
  sample_count integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  PRIMARY KEY (guest_id, region_id)
);

CREATE TABLE loremaster.leaderboard_entries (
  attempt_id uuid PRIMARY KEY,
  guest_id uuid NOT NULL,
  slot_id date NOT NULL,
  outcome text NOT NULL DEFAULT 'SOLVED' CHECK (outcome = 'SOLVED'),
  pseudonym text NOT NULL CHECK (char_length(pseudonym) BETWEEN 1 AND 48),
  evidence_level smallint NOT NULL CHECK (evidence_level BETWEEN 0 AND 4),
  total_wrong_guesses smallint NOT NULL CHECK (total_wrong_guesses BETWEEN 0 AND 15),
  elapsed_ms bigint NOT NULL CHECK (elapsed_ms >= 0),
  score integer NOT NULL CHECK (score >= 0),
  UNIQUE (guest_id, slot_id),
  FOREIGN KEY (attempt_id, guest_id, slot_id, outcome, score)
    REFERENCES loremaster.attempt_finalizations(attempt_id, guest_id, slot_id, outcome, score) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, guest_id, slot_id, outcome, evidence_level, total_wrong_guesses)
    REFERENCES loremaster.attempts(id, guest_id, slot_id, state, evidence_level, total_wrong_guesses) ON DELETE RESTRICT
);

CREATE INDEX leaderboard_daily_order_idx
ON loremaster.leaderboard_entries (slot_id, evidence_level, total_wrong_guesses, elapsed_ms, attempt_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  loremaster.content_packs, loremaster.region_catalog, loremaster.case_revisions,
  loremaster.case_entities, loremaster.entity_aliases, loremaster.revision_regions,
  loremaster.case_evidence, loremaster.case_sources
TO loremaster_importer;

GRANT SELECT ON
  loremaster.content_packs, loremaster.region_catalog, loremaster.case_revisions,
  loremaster.case_entities, loremaster.entity_aliases, loremaster.revision_regions,
  loremaster.case_evidence, loremaster.case_sources
TO loremaster_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  loremaster.guests, loremaster.guest_sessions, loremaster.attempts, loremaster.guesses,
  loremaster.command_receipts, loremaster.attempt_finalizations,
  loremaster.participation_days, loremaster.knowledge_contributions,
  loremaster.regional_knowledge, loremaster.leaderboard_entries
TO loremaster_runtime;

REVOKE CREATE ON SCHEMA loremaster FROM loremaster_importer, loremaster_runtime;
