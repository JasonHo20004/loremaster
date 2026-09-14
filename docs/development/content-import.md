# Content import operations

S4.5 provides a local/operator-only content command. It is not an HTTP route
and must not be exposed by the API or web application.

Build the database package, provide a PostgreSQL login that is a member of only
the `loremaster_importer` group role, and validate a bounded JSON file first:

```powershell
$env:LOREMASTER_IMPORT_DATABASE_URL = 'postgresql://import_login:REDACTED@localhost/loremaster'
pnpm content:import -- --file C:\content\case.json --dry-run
```

Dry-run starts a read-only transaction, validates the whole pack, and checks
the authoritative database for the same pack revision and an overlapping
published window. It performs no writes. A successful dry-run does not reserve
the slot; the publication transaction and PostgreSQL exclusion constraint are
the final concurrency arbiter.

Publish only after dry-run succeeds:

```powershell
pnpm content:import -- --file C:\content\case.json
```

The command writes one JSON object to standard output and never includes pack
text, SQL parameters, credentials, or database error messages. Exit code `0`
means valid/published, `2` means the operator must correct input or select an
unused slot/revision, and `3` means credentials or database connectivity need
attention. Input is capped at 256 KiB before parsing.

The import login requires `CONNECT` on the database and membership in
`loremaster_importer`; it must not receive the migration or runtime role. The
import transaction explicitly assumes the importer role, which has DML access
only to content tables and cannot create schema objects or modify gameplay
state.

Published content is immutable. To correct it, preserve the historical row,
increment `revisionNumber`, choose a future unused UTC-day slot, run dry-run,
and publish the new revision. Never update or delete a published graph. Draft
cleanup is permitted only in a disposable/local database; production cleanup
or schema correction must use a forward migration.
