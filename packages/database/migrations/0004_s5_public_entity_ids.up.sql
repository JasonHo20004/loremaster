ALTER TABLE loremaster.case_entities
  ADD COLUMN public_id text;

ALTER TABLE loremaster.case_entities
  DISABLE TRIGGER freeze_case_entities;

UPDATE loremaster.case_entities
SET public_id = 'entity_' || replace(entity_id::text, '-', '');

ALTER TABLE loremaster.case_entities
  ENABLE TRIGGER freeze_case_entities;

ALTER TABLE loremaster.case_entities
  ALTER COLUMN public_id SET NOT NULL,
  ADD CONSTRAINT case_entity_public_id_format
    CHECK (public_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT case_entity_public_id_per_revision
    UNIQUE (revision_id, public_id);
