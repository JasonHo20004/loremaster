# ADR 0002: Immutable daily slots and deterministic gameplay

Status: Accepted | Date: 2026-09-11

Context: The inspiration specifies score/progression but leaves final exhaustion, expiry and exact ties open. Client time and mutable published answers would undermine fairness.

Decision: Adopt the complete [game rules](../architecture/game-rules.md): UTC non-overlapping daily slots; immutable published revisions; five evidence levels with three guesses each; four terminal outcomes; server time sampled after locking; explicit start; competition ties independent of score. PostgreSQL must enforce global window exclusion and guest/slot uniqueness. Expiry is effective at close and reconciled without a worker.

Alternatives: Midnight publishing jobs make availability depend on scheduling. Editing an open revision makes players solve different puzzles. Score sorting contradicts evidence-first ranking. Resetting on refresh rewards retries. Unlimited guesses after evidence #4 permits trivial brute force.

Consequences: Final wrong guess exhausts the attempt; failed terminal outcomes unseal the file. Network delay counts toward time. Starting and abandoning a case becomes a failed outcome at close. Calendar days with no case can break streaks; this deliberately simple calendar definition is documented to players. Published mistakes require future correction, not silent replacement. Leaderboard ties share rank; pagination needs a stable independent ID.

Verification: Every transition and timing edge has a documentation example in the S1 acceptance record; S4/S5 implement property, transaction and constraint tests. Any gameplay change supersedes this decision and updates those examples together.
