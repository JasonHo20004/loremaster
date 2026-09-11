# S3 acceptance record

Date: 2026-09-11. Scope: least-privilege CI for untrusted pull requests. This record does not claim application features, database integration, deployment credentials or cloud access.

## Exit checks

| Check                          | Evidence                                                                                                      | Result  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------- |
| Untrusted changes are verified | `pull_request` runs a frozen install and the complete `pnpm verify` command                                   | Pass    |
| Token permissions are minimal  | Workflow-level permissions grant only read access to repository contents                                     | Pass    |
| Privileged PR trigger is absent | No workflow uses `pull_request_target`                                                                        | Pass    |
| Cloud credentials are absent   | CI contains no AWS identity, deployment step or repository secret reference                                  | Pass    |
| Actions are immutable          | Every third-party action is pinned to a full commit SHA with its release recorded in a comment                | Pass    |
| Dependencies are reviewed      | Pull requests fail when they introduce a dependency vulnerability of moderate severity or higher             | Pending |
| Secrets are detected           | Gitleaks scans full Git history without PR comments, artifact uploads or write permissions                    | Pending |
| Merge protection is enforced   | The `Quality`, `Dependency review` and `Secret scan` checks are required for `main`                            | Pending |

The pending checks require a GitHub pull-request run and repository ruleset configuration. They must not be marked as passed from local evidence alone. The workflow deliberately has no `pull_request_target` trigger, write permission, cloud identity, deployment secret, cache restore or artifact upload. A pull request may execute arbitrary package lifecycle and test code only inside an ephemeral GitHub-hosted runner with a read-only token.
