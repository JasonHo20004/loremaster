# Original-content policy

Accepted S1 baseline, 2026-09-11. All implementation fixtures, seeds, screenshots, public demo assets and AWS content must use original fiction. Engine modules and browser contracts contain no narrative answer fixtures.

Riot's [General Policies](https://developer.riotgames.com/policies/general), checked 2026-09-11, prohibit games using its IP. This project therefore blocks such a pack unless sufficient authorization for this specific use is recorded and the decision superseded. A disclaimer, registration, private deployment or non-commercial use does not satisfy this project's gate.

The existing `docs/DailyRuneterraCase_Description.md` remains a labeled historical requirements source. It is not an approved fixture. Build contexts, seeds and public web assets must use explicit allowlists and exclude this document and private pack sources. Merely scanning for a few franchise names is not proof of original authorship.

## Planned original pack: The Aster Quay ledger

S4 will implement this small text-only pack. Authorship basis: new fictional material drafted for this project during S1; no external narrative, images or quotations. Source identifiers are internal pack references, not URLs to fetch.

| Entity ID | Canonical name | Public role |
| --- | --- | --- |
| mira-vale | Mira Vale | Tide archivist; devised the reversed-hour notation |
| oren-pell | Oren Pell | Bell keeper; records hours as ordinary numerals |
| tessa-reed | Tessa Reed | Glassmaker; marks work with a three-dot stamp |
| ivo-senn | Ivo Senn | Courier; records deliveries using numbered knots |

Region: Aster Quay. WHO case: “The Missing Ninth Bell.” Briefing: A replacement tide ledger appeared in the quay archive overnight. Its hours are written backwards, a notation invented by the tide archivist to distinguish forecasts from observations. Who prepared the replacement? Answer: Mira Vale.

Evidence 1: The unusual hour marks indicate authorship, not a damaged clock.

Evidence 2: The bell keeper uses ordinary numerals, while the courier uses knots.

Evidence 3: The replacement follows the tide archivist's forecast notation.

Evidence 4: The archive's staff register identifies its tide archivist as Mira Vale.

Explanation: The public role catalog and briefing identify Mira's unique notation. Evidence 1 focuses on that clue; evidence 2 excludes two alternatives; evidence 3 identifies the role; evidence 4 connects it to the name. Internal source: `aster-quay/staff-and-notation-v1`. Public catalog roles must be available before guessing so the briefing is solvable without hidden lore. The full solution in this design document belongs only in server-side content, never a browser build context.

## Import and release gate

Each pack records author/provenance, content version, entity IDs and unique aliases, regions, one answer ID, briefing, exactly four ordered evidence entries, explanations and internal sources. Review text for third-party copying and unsafe markup; unknown provenance blocks import. Use plain text rendering. No external images or links are needed for this MVP. A future remote asset or link validator needs a new SSRF design before fetching anything.

S4 must validate schema, source provenance and immutable publication in one transactional import; dry-run lists errors without publishing. Reject unknown answer/region IDs, ambiguous aliases, missing explanations, duplicate evidence order and overlapping slots. Fixtures for tests use this original pack or abstract IDs. S6/S8 verify server content is absent from browser bundles and public deployment assets.
