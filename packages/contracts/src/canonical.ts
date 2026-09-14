import { gameplayCommandRequestSchema, uuidSchema } from './schemas.js'
import type { GameplayCommandRequest } from './schemas.js'

export function canonicalStartInput(): readonly ['v1', 'START'] {
  return ['v1', 'START']
}

export function canonicalGameplayCommandInput(
  attemptId: string,
  request: GameplayCommandRequest,
): readonly unknown[] {
  const parsedAttemptId = uuidSchema.parse(attemptId)
  const parsed = gameplayCommandRequestSchema.parse(request)
  switch (parsed.command.kind) {
    case 'GUESS':
      return [
        'v1',
        'GUESS',
        parsedAttemptId,
        parsed.expectedVersion,
        parsed.command.entityId,
      ]
    case 'REVEAL':
      return ['v1', 'REVEAL', parsedAttemptId, parsed.expectedVersion]
    case 'GIVE_UP':
      return ['v1', 'GIVE_UP', parsedAttemptId, parsed.expectedVersion]
  }
}
