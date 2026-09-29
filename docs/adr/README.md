# Architecture decision records

ADRs 0001-0004 were accepted on 2026-09-11 for the S1 baseline; ADR 0005 was accepted on 2026-09-29 for S7.1. Accepted means selected for construction. Verification belongs to the relevant slice evidence. The repository owner may supersede a decision through a new numbered ADR describing invalidating evidence, alternatives, consequences, affected rules/tests, and migration/rollback impact. Preserve the old decision and link its successor; never silently replace its substance.

| ADR | Decision |
| --- | --- |
| [0001](0001-scope-and-platform.md) | Original-content MVP and modular delivery platform |
| [0002](0002-game-integrity.md) | Immutable daily slots and deterministic gameplay |
| [0003](0003-identity-and-transactions.md) | Guest identity, synchronous transactions and disclosure |
| [0004](0004-cloud-admission.md) | Default-deny AWS admission and independent cleanup |
| [0005](0005-server-cache-boundary.md) | Server-only cache/limiter package; supersedes ADR 0001's package boundary |

Changes to IP, identity, integrity, admission/cleanup or migration/recovery need an adversarial review record before implementation. S1 verification is recorded in the [acceptance report](../architecture/s1-acceptance.md).
