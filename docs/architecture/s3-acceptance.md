# S3 acceptance record

Date: 2026-09-11. Scope: least-privilege CI for untrusted pull requests. This record does not claim application features, database integration, deployment credentials or cloud access.

## Exit checks

| Check                           | Evidence                                                                                                                        | Result |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Untrusted changes are verified  | Corrected workflow uses `pnpm run verify`; hosted acceptance and the later PR #6 clean-checkout run passed all required jobs | Pass   |
| Token permissions are minimal   | Workflow permissions grant read access only to repository contents and pull-request metadata                                   | Pass   |
| Privileged PR trigger is absent | No workflow uses `pull_request_target`                                                                                          | Pass   |
| Cloud credentials are absent    | CI contains no AWS identity, deployment step or repository secret reference                                                    | Pass   |
| Actions are immutable           | Every third-party action is pinned to a full commit SHA with its release recorded in a comment                                  | Pass   |
| Dependencies are audited        | Hosted `Dependency audit` completed successfully and the moderate-severity gate found no known vulnerabilities                 | Pass   |
| Secrets are detected            | Hosted `Secret scan` completed successfully; Gitleaks scanned full Git history and reported no leaks                           | Pass   |
| Merge protection is enforced    | `main` requires a current pull request plus `Quality`, `Dependency audit` and `Secret scan`; bypass, deletion and force push are denied | Pass   |

Hosted acceptance is recorded by [GitHub Actions run 34612211333](https://github.com/JasonHo20004/loremaster/actions/runs/34612211333): all three jobs passed in 46 seconds, including 15 tests and a no-leaks Gitleaks result. The repository's enforced classic branch protection rule targets `main` and requires the same three checks.

The workflow deliberately has no `pull_request_target` trigger, write permission, cloud identity, deployment secret, cache restore or artifact upload. A pull request may execute arbitrary package lifecycle and test code only inside an ephemeral GitHub-hosted runner with a read-only token. The lockfile audit is used because GitHub Dependency Review was unavailable before the repository became public and did not justify enabling a broader licensed security feature solely for this gate.

Correction (2026-09-15, closed 2026-09-21): pnpm 11 resolves bare
`pnpm verify` to its own built-in command rather than the root package script.
CI now uses `pnpm run verify`, with a policy regression test that rejects the
bare form. The corrected hosted workflow passed, and PR #6 later repeated the
required Quality, Dependency audit, and Secret scan jobs successfully. S3 exit
is therefore **PASS**; the earlier pending wording is retained here only as the
reason for the correction.
