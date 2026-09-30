export type RedisClientProfile =
  'api-cache' | 'api-limiter' | 'producer' | 'worker' | 'observer'
/** Contract only: S7.2+ adapters must implement deadlines and destructive cancellation. */
const request = {
  enableOfflineQueue: false,
  autoResendUnfulfilledCommands: false,
  maxRetriesPerRequest: 0,
  lazyConnect: true,
  connectTimeoutMs: 500,
  commandTimeoutMs: 100,
  destroyOnDeadline: true,
  reconnectMinimumMs: 100,
  reconnectMaximumMs: 2000,
  reconnectJitterRatio: 0.2,
  shutdownTimeoutMs: 1000,
} as const
export const REDIS_CLIENT_PROFILES = Object.freeze({
  'api-cache': Object.freeze({ ...request, maximumConnections: 1 }),
  'api-limiter': Object.freeze({ ...request, maximumConnections: 1 }),
  producer: Object.freeze({
    ...request,
    commandTimeoutMs: 1000,
    maximumConnections: 1,
  }),
  worker: Object.freeze({
    ...request,
    maxRetriesPerRequest: null,
    commandTimeoutMs: 5000,
    shutdownTimeoutMs: 10000,
    maximumConnections: 3,
  }),
  observer: Object.freeze({
    ...request,
    commandTimeoutMs: 1000,
    maximumConnections: 1,
  }),
})
/** Deployment admission bounds; runtime enforcement is an S7.2+ requirement. */
export const REDIS_NAMESPACE_BUDGETS = Object.freeze({
  cache: Object.freeze({
    maximumKeys: 16,
    maximumValueBytes: 524288,
    maximumBytes: 16 * 1024 * 1024,
  }),
  queue: Object.freeze({
    maximumJobs: 384,
    maximumOutstandingJobs: 128,
    maximumPayloadBytes: 128,
    maximumJobBytes: 16 * 1024,
    maximumKeys: 1024,
    maximumBytes: 32 * 1024 * 1024,
  }),
  limiter: Object.freeze({
    maximumKeys: 20000,
    maximumBytes: 16 * 1024 * 1024,
  }),
  instance: Object.freeze({
    maxmemoryBytes: 128 * 1024 * 1024,
    policy: 'noeviction',
    minimumHeadroomBytes: 64 * 1024 * 1024,
  }),
})
