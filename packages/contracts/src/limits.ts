export const API_CONTRACT_LIMITS = Object.freeze({
  aliasCharacters: 80,
  aliasesPerEntity: 8,
  autocompleteQueryCharacters: 80,
  autocompleteResults: 20,
  briefingCharacters: 2_000,
  cursorCharacters: 600,
  entityIdCharacters: 64,
  evidenceTextCharacters: 1_000,
  explanationCharacters: 1_500,
  idempotencyKeyCharacters: 128,
  jsonBodyBytes: 16 * 1024,
  leaderboardPageSize: 100,
  publicNameCharacters: 80,
  publicRoleCharacters: 160,
  sourceReferenceCharacters: 128,
  sourceReferencesPerEvidence: 16,
})

export const API_TIMEOUTS_MILLISECONDS = Object.freeze({
  request: 5_000,
  databaseLock: 1_000,
  databaseStatement: 3_000,
})
