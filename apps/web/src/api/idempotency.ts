import { idempotencyKeySchema } from '@loremaster/contracts'

export type RandomUuid = () => string

function browserRandomUuid(): string {
  return globalThis.crypto.randomUUID()
}

export function createIdempotencyKey(
  randomUuid: RandomUuid = browserRandomUuid,
): string {
  const result = idempotencyKeySchema.safeParse(randomUuid())
  if (!result.success) {
    throw new TypeError('A secure idempotency key could not be created')
  }
  return result.data
}
