-- Login identities are provisioned separately and receive exactly one role.
-- Never grant these roles base-table access: views enforce published/eligible rows.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loremaster_cache_worker') THEN
    CREATE ROLE loremaster_cache_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loremaster_cache_producer') THEN
    CREATE ROLE loremaster_cache_producer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

CREATE VIEW loremaster.cache_published_revisions WITH (security_barrier = true) AS
SELECT id, status, slot_id, opens_at, closes_at
FROM loremaster.case_revisions
WHERE status = 'PUBLISHED';

CREATE VIEW loremaster.cache_published_entities WITH (security_barrier = true) AS
SELECT entity.revision_id, entity.entity_id, entity.public_id,
       entity.canonical_name, entity.role, entity.is_eligible
FROM loremaster.case_entities entity
JOIN loremaster.case_revisions revision ON revision.id = entity.revision_id
WHERE revision.status = 'PUBLISHED' AND entity.is_eligible;

CREATE VIEW loremaster.cache_published_aliases WITH (security_barrier = true) AS
SELECT alias.revision_id, alias.entity_id, alias.alias
FROM loremaster.entity_aliases alias
JOIN loremaster.case_entities entity
  ON entity.revision_id = alias.revision_id AND entity.entity_id = alias.entity_id
JOIN loremaster.case_revisions revision ON revision.id = entity.revision_id
WHERE revision.status = 'PUBLISHED' AND entity.is_eligible;

REVOKE ALL ON loremaster.cache_published_revisions,
  loremaster.cache_published_entities, loremaster.cache_published_aliases FROM PUBLIC;
GRANT USAGE ON SCHEMA loremaster TO loremaster_cache_worker, loremaster_cache_producer;
GRANT SELECT ON loremaster.cache_published_revisions TO loremaster_cache_worker, loremaster_cache_producer;
GRANT SELECT ON loremaster.cache_published_entities, loremaster.cache_published_aliases TO loremaster_cache_worker;

-- The observer is Redis-only and receives no database role or credentials.
