DROP VIEW IF EXISTS loremaster.cache_published_aliases;
DROP VIEW IF EXISTS loremaster.cache_published_entities;
DROP VIEW IF EXISTS loremaster.cache_published_revisions;
REVOKE USAGE ON SCHEMA loremaster FROM loremaster_cache_worker, loremaster_cache_producer;
DROP ROLE IF EXISTS loremaster_cache_worker;
DROP ROLE IF EXISTS loremaster_cache_producer;
