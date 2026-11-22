# ADR 0006: Local PostgreSQL backup and restore

Status: Proposed for S10 | Date: 2026-11-05

Requires the repository owner's acceptance and an adversarial review record
before implementation (recovery change, per the [ADR index](README.md)).

## Context

PostgreSQL is the only source of truth for revisions, attempts, guesses,
sessions, score, streaks, knowledge and leaderboard. The S9 lab keeps data in
retained PVCs, but [the S9 guide](../development/s9-local-gitops.md) states
that kind local volumes are node-bound and that node loss needs
backup/restore. The S9 evidence records node-loss backup as out of scope. The
only existing dump is a manual pre-upgrade file in `.cache/s9/backups`. No
scripted backup, restore or drill exists, so no recovery point (RPO) or
recovery time (RTO) is known.

## Decision

1. **Logical backups with `pg_dump -Fc`** from the PostgreSQL 17.11 image
   already pinned by digest. A dump is consistent at one snapshot and
   restores across node loss. Physical backups (basebackup and WAL archiving)
   are rejected for the lab: they need an archive target and add PITR
   machinery that the data size (megabytes) does not justify.
2. **A dedicated read-only backup role.** Forward-only migration
   `0006_s10_backup_role` adds a `NOLOGIN` group `loremaster_backup` granted
   `pg_read_all_data`. The S9 bootstrap provisions a login user in that group
   with a file-backed password, using the per-role secret pattern. The
   runtime, importer and cache roles do not change. The backup role cannot
   write.
3. **Schedule and storage.** A `CronJob` in the `loremaster` namespace runs
   every 6 hours (RPO 6 h for the lab) and keeps the last 8 dumps on a
   dedicated `backups` PVC. `pnpm s9 backup export` copies the newest dump
   and its SHA-256 manifest to `.cache/s9/backups/` on the host, outside the
   cluster, which is the off-node copy. The CronJob is platform-owned and
   applied by an explicit operator command, like the migration Job; the Argo
   AppProject continues to deny Jobs.
4. **Restore is an explicit operator action into an empty database.** `pnpm
s9 restore <dump>` verifies the manifest hash, then:
   1. stops the API, worker and observer by scaling them to 0;
   2. bootstraps roles into a fresh PostgreSQL volume;
   3. runs `pg_restore --single-transaction --exit-on-error` as the migration
      owner;
   4. checks the migration version and per-table row counts against the
      manifest;
   5. scales the applications back up.

   Restore never runs automatically and never targets a non-empty database.
5. **Drill gate.** `pnpm test:s10:restore` writes known attempts, guesses and
   a leaderboard entry through the API, then:
   1. takes a backup;
   2. deletes the PostgreSQL StatefulSet and its PVC in a disposable lab;
   3. restores the backup;
   4. confirms through the public API that the leaderboard, profile streak
      and attempt state match.

   The gate records the measured RTO. A missing Docker or cluster fails the
   gate instead of skipping it.

## Invariants

- Dumps contain answers and narrative for the published revisions. They are
  secret data: never in Git, CI artifacts, logs or the monitoring stack.
  `.cache/` stays gitignored, and the drill evidence records hashes and
  counts only.
- Backups never block gameplay. `pg_dump` takes only `ACCESS SHARE` locks.
- The existing role separation holds: restore uses the migration owner, and
  the API runtime login still has only `loremaster_runtime`.
- Published revisions stay immutable. A restore brings back the exact
  revisions and never edits content.

## Alternatives considered

- **Volume snapshots:** the kind `standard` storage class has no snapshot
  support, and a snapshot is still node-bound.
- **Dumping as the migration owner:** this is simpler but gives a scheduled
  job ownership rights. Rejected for least privilege.
- **Redis backups:** Redis is disposable by ADR 0005. Not backed up.

## Consequences and rollback

- One new forward-only migration and one new role. Rolling back the feature
  means deleting the CronJob and PVC. The role stays as a harmless `NOLOGIN`
  group; a later forward migration may drop it.
- `tests/database` gains role-privilege tests: the backup role can `SELECT`
  but cannot `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE`. `tests/s9` gains
  CronJob policy checks (non-root, resources, read-only root filesystem).
- S12 AWS would use RDS automated backups instead. This ADR covers only the
  local lab.

## Open questions for review

- Is a 6 h RPO acceptable for the lab, or should the drill cover a tighter
  schedule?
- Should the host export be encrypted at rest (for example with `age`), given
  that dumps contain answers?
- The `local-budget` ResourceQuota is already at `requests.storage` 2Gi/2Gi
  (PostgreSQL and Redis PVCs; S10 `KubeQuotaFullyUsed`, 2026-11-05). A
  `backups` PVC needs a reviewed quota increase in
  `platform/local/runtime.yaml`, or a separate namespace.
