ALTER TABLE loremaster.case_entities
  DROP CONSTRAINT case_entity_public_id_per_revision,
  DROP CONSTRAINT case_entity_public_id_format,
  DROP COLUMN public_id;
