/** Server-only immutable contracts. Runtime composition is introduced in S7.4. */
export const WARM_QUEUE_NAME = 'loremaster-warm-v1'
export const WARM_QUEUE_PREFIX = 'loremaster:v1:queue'
export const WARM_JOB_NAME = 'warm-current-revision-v1'
export const WARM_CONTRACT_VERSION = 1

export const WARM_POLICY = Object.freeze({
  payloadMaxBytes: 128,
  resultMaxBytes: 64,
  cacheTtlSeconds: 172_800,
  attempts: 3,
  backoff: Object.freeze({
    type: 'exponential' as const,
    delay: 1_000,
    jitter: 0.5,
  }),
  maximumAgeMs: 172_800_000,
  runtimeMs: 5_000,
  drainMs: 10_000,
  defaultConcurrency: 2,
  maximumConcurrency: 4,
  reconcileIntervalMs: 60_000,
  producerDeadlineMs: 1_000,
  maximumOutstandingJobs: 128,
  maximumEvents: 1024,
  maximumStoredJobBytes: 16_384,
  maximumStalledCount: 1,
  stackTraceLimit: 0,
  removeOnComplete: Object.freeze({ age: 172_800, count: 128 }),
  removeOnFail: Object.freeze({ age: 172_800, count: 128 }),
})

export interface WarmPayload {
  readonly version: 1
  readonly revisionId: string
}

export interface WarmResult {
  readonly version: 1
  readonly status: 'warmed'
}

// Canonical lower-case UUIDs avoid multiple deduplication identities per revision.
const revisionPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return (
        descriptor !== undefined &&
        'value' in descriptor &&
        descriptor.enumerable
      )
    })
  )
}

export function parseWarmPayload(value: unknown): WarmPayload {
  if (
    !exactRecord(value, ['version', 'revisionId']) ||
    value.version !== 1 ||
    typeof value.revisionId !== 'string' ||
    !revisionPattern.test(value.revisionId)
  ) {
    throw new Error('Invalid warm payload')
  }
  // Only fixed-size ASCII fields survive; character and UTF-8 byte counts match.
  // No caller-provided serializer is invoked.
  const payload: WarmPayload = { version: 1, revisionId: value.revisionId }
  if (JSON.stringify(payload).length > WARM_POLICY.payloadMaxBytes) {
    throw new Error('Invalid warm payload')
  }
  return Object.freeze(payload)
}

export function parseWarmResult(value: unknown): WarmResult {
  if (
    !exactRecord(value, ['version', 'status']) ||
    value.version !== 1 ||
    value.status !== 'warmed'
  ) {
    throw new Error('Invalid warm result')
  }
  return Object.freeze({ version: 1, status: 'warmed' })
}

export function warmJobId(revisionId: string): string {
  return `warm-v1-${parseWarmPayload({ version: 1, revisionId }).revisionId}`
}
export {
  createWarmProducer,
  PRODUCER_ADMISSION_V1_LUA,
  PRODUCER_ADMISSION_V1_SHA256,
  type WarmProducer,
  type WarmProducerPorts,
} from './producer.js'
export {
  createWarmWorker,
  processWarmJob,
  type WarmWorkerRuntime,
  type WarmWorkerPorts,
} from './worker.js'
