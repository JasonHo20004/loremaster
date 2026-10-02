import { inspect } from 'node:util'

import {
  requireFilesInProduction,
  resolveFileSecrets,
  SecretFileError,
} from './secret-file.js'

type Environment = Readonly<Record<string, string | undefined>>
export class RedisConfigurationError extends Error {
  readonly code = 'INVALID_REDIS_CONFIGURATION'
  constructor(readonly field: string) {
    super(`Invalid Redis configuration: ${field}`)
    this.name = 'RedisConfigurationError'
  }
}
function invalid(field: string): never {
  throw new RedisConfigurationError(field)
}
function containsControl(value: string, includeSpace = false): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= (includeSpace ? 32 : 31) || code === 127
  })
}
const common = ['LOREMASTER_REDIS_MODE']
const api = [
  'LOREMASTER_REDIS_ENABLED',
  'LOREMASTER_REDIS_CACHE_URL',
  'LOREMASTER_REDIS_LIMITER_URL',
  'LOREMASTER_REDIS_PRODUCER_URL',
  'LOREMASTER_REDIS_PRODUCER_DATABASE_URL',
  'LOREMASTER_REDIS_LIMITER_HMAC_KEY',
  'LOREMASTER_REDIS_LIMITER_HMAC_VERSION',
]
const worker = [
  'LOREMASTER_WORKER_REDIS_URL',
  'LOREMASTER_WORKER_CACHE_REDIS_URL',
  'LOREMASTER_WORKER_DATABASE_URL',
  'LOREMASTER_WORKER_CONCURRENCY',
]
const observer = ['LOREMASTER_OBSERVER_REDIS_URL']
const apiSecrets = [
  'LOREMASTER_REDIS_CACHE_URL',
  'LOREMASTER_REDIS_LIMITER_URL',
  'LOREMASTER_REDIS_PRODUCER_URL',
  'LOREMASTER_REDIS_PRODUCER_DATABASE_URL',
  'LOREMASTER_REDIS_LIMITER_HMAC_KEY',
]
const workerSecrets = [
  'LOREMASTER_WORKER_REDIS_URL',
  'LOREMASTER_WORKER_CACHE_REDIS_URL',
  'LOREMASTER_WORKER_DATABASE_URL',
]
const observerSecrets = ['LOREMASTER_OBSERVER_REDIS_URL']
function validateKeys(
  env: Environment,
  keys: readonly string[],
  secretKeys: readonly string[],
): void {
  const allowed = new Set([
    ...common,
    ...keys,
    ...secretKeys.map((key) => `${key}_FILE`),
  ])
  for (const key of Object.keys(env))
    if (
      (key.startsWith('LOREMASTER_REDIS_') ||
        key.startsWith('LOREMASTER_WORKER_') ||
        key.startsWith('LOREMASTER_OBSERVER_')) &&
      !allowed.has(key)
    )
      invalid(key)
}
function fileSecrets(env: Environment, keys: readonly string[]): Environment {
  try {
    const resolved = resolveFileSecrets(env, keys)
    requireFilesInProduction(env, mode(env), keys)
    return resolved
  } catch (error) {
    if (error instanceof SecretFileError) invalid(error.field)
    throw error
  }
}
function redact<T extends object>(
  configuration: T,
  fields: readonly string[],
): T {
  const safe = () => ({
    ...Object.fromEntries(
      Object.entries(configuration).map(([key, value]) => [
        key,
        fields.includes(key) ? '[REDACTED]' : value,
      ]),
    ),
    ...Object.fromEntries(fields.map((field) => [field, '[REDACTED]'])),
  })
  Object.defineProperty(configuration, 'toJSON', { value: safe })
  Object.defineProperty(configuration, inspect.custom, { value: safe })
  for (const field of fields) {
    Object.defineProperty(configuration, field, { enumerable: false })
  }
  return configuration
}
function mode(env: Environment): 'local' | 'production' {
  const value = env.LOREMASTER_REDIS_MODE ?? env.LOREMASTER_API_MODE ?? 'local'
  if (value !== 'local' && value !== 'production')
    invalid('LOREMASTER_REDIS_MODE')
  if (
    env.LOREMASTER_API_MODE !== undefined &&
    value !== env.LOREMASTER_API_MODE
  )
    invalid('LOREMASTER_REDIS_MODE')
  return value
}
function redisUrl(env: Environment, field: string): string {
  const raw = env[field]
  if (
    !raw ||
    raw.length > 2048 ||
    raw.trim() !== raw ||
    containsControl(raw, true)
  )
    invalid(field)
  try {
    const url = new URL(raw)
    const username = decodeURIComponent(url.username),
      password = decodeURIComponent(url.password)
    if (
      !['redis:', 'rediss:'].includes(url.protocol) ||
      !url.hostname ||
      url.search ||
      url.hash ||
      !['', '/', '/0'].includes(url.pathname) ||
      url.port === '0' ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(username) ||
      !password ||
      containsControl(password)
    )
      invalid(field)
    if (
      mode(env) === 'production' &&
      (url.protocol !== 'rediss:' || !url.username || !url.password)
    )
      invalid(field)
  } catch {
    invalid(field)
  }
  return raw
}
function roleRedisUrl(
  env: Environment,
  field: string,
  expectedUser: string,
): string {
  const url = redisUrl(env, field)
  if (decodeURIComponent(new URL(url).username) !== expectedUser) invalid(field)
  return url
}
function producerDatabaseUrl(env: Environment): string {
  const field = 'LOREMASTER_REDIS_PRODUCER_DATABASE_URL'
  const raw = env[field]
  if (
    !raw ||
    raw.length > 2048 ||
    raw.trim() !== raw ||
    containsControl(raw, true)
  )
    invalid(field)
  try {
    const url = new URL(raw)
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2
    )
      invalid(field)
  } catch {
    invalid(field)
  }
  return raw
}
export type ApiRedisConfiguration =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly cacheUrl: string
      readonly limiterUrl: string
      readonly producerUrl: string
      readonly producerDatabaseUrl: string
      readonly limiterHmacKey: Uint8Array
      readonly limiterHmacVersion: string
    }
export function parseApiRedisConfiguration(
  env: Environment,
  cursorKeys: readonly Uint8Array[] = [],
): ApiRedisConfiguration {
  validateKeys(env, api, apiSecrets)
  mode(env)
  const enabled = env.LOREMASTER_REDIS_ENABLED ?? 'false'
  if (enabled !== 'false' && enabled !== 'true')
    invalid('LOREMASTER_REDIS_ENABLED')
  if (enabled === 'false') {
    for (const key of api.slice(1)) {
      if (env[key] !== undefined || env[`${key}_FILE`] !== undefined)
        invalid(key)
    }
    return { enabled: false }
  }
  env = fileSecrets(env, apiSecrets)
  const cacheUrl = roleRedisUrl(
      env,
      'LOREMASTER_REDIS_CACHE_URL',
      'loremaster_api_cache',
    ),
    limiterUrl = roleRedisUrl(
      env,
      'LOREMASTER_REDIS_LIMITER_URL',
      'loremaster_api_limiter',
    ),
    producerUrl = roleRedisUrl(
      env,
      'LOREMASTER_REDIS_PRODUCER_URL',
      'loremaster_producer',
    )
  const producerDbUrl = producerDatabaseUrl(env)
  const usernames = [cacheUrl, limiterUrl, producerUrl].map((raw) =>
    decodeURIComponent(new URL(raw).username),
  )
  if (new Set(usernames).size !== 3 || usernames.some((value) => !value))
    invalid('LOREMASTER_REDIS_CACHE_URL')
  const material = env.LOREMASTER_REDIS_LIMITER_HMAC_KEY
  if (!material || !/^[A-Za-z0-9_-]{43,86}$/u.test(material))
    invalid('LOREMASTER_REDIS_LIMITER_HMAC_KEY')
  const key = Buffer.from(material, 'base64url')
  if (
    key.length < 32 ||
    key.length > 64 ||
    key.toString('base64url') !== material ||
    material === env.LOREMASTER_API_CURSOR_ACTIVE_KEY ||
    material === env.LOREMASTER_API_CURSOR_PREVIOUS_KEY ||
    cursorKeys.some((cursorKey) => key.equals(Buffer.from(cursorKey)))
  )
    invalid('LOREMASTER_REDIS_LIMITER_HMAC_KEY')
  const version = env.LOREMASTER_REDIS_LIMITER_HMAC_VERSION
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/u.test(version))
    invalid('LOREMASTER_REDIS_LIMITER_HMAC_VERSION')
  return redact(
    {
      enabled: true,
      cacheUrl,
      limiterUrl,
      producerUrl,
      producerDatabaseUrl: producerDbUrl,
      limiterHmacKey: new Uint8Array(key),
      limiterHmacVersion: version,
    },
    [
      'cacheUrl',
      'limiterUrl',
      'producerUrl',
      'producerDatabaseUrl',
      'limiterHmacKey',
    ],
  )
}
export interface WorkerConfiguration {
  readonly redisUrl: string
  readonly cacheRedisUrl: string
  readonly databaseUrl: string
  readonly healthHost: '127.0.0.1'
  readonly healthPort: 3001
  readonly concurrency: number
}
export function parseWorkerConfiguration(
  env: Environment,
): WorkerConfiguration {
  validateKeys(env, worker, workerSecrets)
  mode(env)
  env = fileSecrets(env, workerSecrets)
  const redis = roleRedisUrl(
      env,
      'LOREMASTER_WORKER_REDIS_URL',
      'loremaster_worker',
    ),
    cacheRedis = roleRedisUrl(
      env,
      'LOREMASTER_WORKER_CACHE_REDIS_URL',
      'loremaster_worker_cache',
    )
  if (
    decodeURIComponent(new URL(redis).username) ===
    decodeURIComponent(new URL(cacheRedis).username)
  )
    invalid('LOREMASTER_WORKER_CACHE_REDIS_URL')
  const databaseUrl = env.LOREMASTER_WORKER_DATABASE_URL
  if (
    !databaseUrl ||
    databaseUrl.length > 2048 ||
    databaseUrl.trim() !== databaseUrl ||
    containsControl(databaseUrl, true)
  )
    invalid('LOREMASTER_WORKER_DATABASE_URL')
  try {
    const url = new URL(databaseUrl)
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2
    )
      invalid('LOREMASTER_WORKER_DATABASE_URL')
  } catch {
    invalid('LOREMASTER_WORKER_DATABASE_URL')
  }
  const raw = env.LOREMASTER_WORKER_CONCURRENCY ?? '2'
  if (!/^[1-4]$/u.test(raw)) invalid('LOREMASTER_WORKER_CONCURRENCY')
  return redact(
    {
      redisUrl: redis,
      cacheRedisUrl: cacheRedis,
      databaseUrl,
      healthHost: '127.0.0.1',
      healthPort: 3001,
      concurrency: Number(raw),
    },
    ['redisUrl', 'cacheRedisUrl', 'databaseUrl'],
  )
}
export interface ObserverConfiguration {
  readonly redisUrl: string
  readonly healthHost: '127.0.0.1'
  readonly healthPort: 3002
}
export function parseObserverConfiguration(
  env: Environment,
): ObserverConfiguration {
  validateKeys(env, observer, observerSecrets)
  mode(env)
  env = fileSecrets(env, observerSecrets)
  return redact(
    {
      redisUrl: roleRedisUrl(
        env,
        'LOREMASTER_OBSERVER_REDIS_URL',
        'loremaster_observer',
      ),
      healthHost: '127.0.0.1',
      healthPort: 3002,
    },
    ['redisUrl'],
  )
}
