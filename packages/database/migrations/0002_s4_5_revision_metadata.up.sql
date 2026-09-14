ALTER TABLE loremaster.case_revisions
  ADD COLUMN case_key text,
  ADD COLUMN title text,
  ADD COLUMN author text,
  ADD COLUMN provenance text,
  ADD COLUMN content_version text,
  ADD CONSTRAINT case_revision_case_key_format
    CHECK (case_key IS NULL OR case_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT case_revision_title_bounds
    CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
  ADD CONSTRAINT case_revision_author_bounds
    CHECK (author IS NULL OR char_length(author) BETWEEN 1 AND 120),
  ADD CONSTRAINT case_revision_known_provenance
    CHECK (provenance IS NULL OR provenance = 'ORIGINAL_AUTHORED'),
  ADD CONSTRAINT case_revision_content_version_format
    CHECK (content_version IS NULL OR (
      char_length(content_version) BETWEEN 1 AND 32
      AND content_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$'
    ));

ALTER TABLE loremaster.case_revisions
  ADD CONSTRAINT published_revision_metadata_is_complete
  CHECK (
    status <> 'PUBLISHED'
    OR (
      case_key IS NOT NULL
      AND title IS NOT NULL
      AND author IS NOT NULL
      AND provenance IS NOT NULL
      AND content_version IS NOT NULL
    )
  ) NOT VALID;
