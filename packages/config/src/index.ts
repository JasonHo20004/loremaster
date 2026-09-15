import { isIP } from 'node:net'

export type ServerMode = 'local' | 'production'

export interface TrustedProxy {
  readonly address: string
  readonly prefixLength: number
  readonly version: 4 | 6
}

export interface CookieConfiguration {
  readonly domain?: undefined
  readonly httpOnly: boolean
  readonly name: string
  readonly path: '/'
  readonly sameSite: 'lax'
  readonly secure: boolean
}

export interface CursorHmacKey {
  readonly version: string
  readonly key: Uint8Array
}

export interface ServerConfiguration {
  readonly mode: ServerMode
  readonly databaseUrl: string
  readonly origin: string
  readonly port: number
  readonly trustedProxies: readonly TrustedProxy[]
  readonly cookies: {
    readonly session: CookieConfiguration
    readonly csrf: CookieConfiguration
  }
  readonly timeouts: {
    readonly commandMs: 5_000
    readonly lockMs: 1_000
    readonly statementMs: 3_000
  }
  readonly cursor: {
    readonly active: CursorHmacKey
    readonly previous?: CursorHmacKey
    readonly previousGraceSeconds: 86_400
  }
  readonly limiter: {
    readonly windowMs: 60_000
    readonly mutationsPerGuest: 30
    readonly mutationsPerIp: 120
    readonly autocompletePerGuest: 120
    readonly autocompletePerIp: 300
    readonly sessionCreationsPerIp: 10
    readonly guestCapacity: number
    readonly ipCapacity: number
  }
  readonly sessionAbsoluteTtlDays: 30
}

const ENVIRONMENT_KEYS = [
  'LOREMASTER_API_MODE',
  'DATABASE_URL',
  'LOREMASTER_API_ORIGIN',
  'LOREMASTER_API_TRUSTED_PROXIES',
  'PORT',
  'LOREMASTER_API_SESSION_COOKIE_NAME',
  'LOREMASTER_API_CSRF_COOKIE_NAME',
  'LOREMASTER_API_COMMAND_TIMEOUT_MS',
  'LOREMASTER_API_LOCK_TIMEOUT_MS',
  'LOREMASTER_API_STATEMENT_TIMEOUT_MS',
  'LOREMASTER_API_CURSOR_ACTIVE_VERSION',
  'LOREMASTER_API_CURSOR_ACTIVE_KEY',
  'LOREMASTER_API_CURSOR_PREVIOUS_VERSION',
  'LOREMASTER_API_CURSOR_PREVIOUS_KEY',
  'LOREMASTER_API_CURSOR_PREVIOUS_GRACE_SECONDS',
  'LOREMASTER_API_LIMITER_GUEST_CAPACITY',
  'LOREMASTER_API_LIMITER_IP_CAPACITY',
] as const

type EnvironmentKey = (typeof ENVIRONMENT_KEYS)[number]
type Environment = Readonly<Record<string, string | undefined>>

const allowedKeys = new Set<string>(ENVIRONMENT_KEYS)
const cursorVersionPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u
const cookieNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u

export class ConfigurationError extends Error {
  readonly code = 'INVALID_CONFIGURATION'
  readonly fields: readonly string[]

  constructor(fields: readonly string[]) {
    const uniqueFields = [...new Set(fields)].sort()
    super(`Invalid server configuration: ${uniqueFields.join(', ')}`)
    this.name = 'ConfigurationError'
    this.fields = uniqueFields
  }
}

function required(
  environment: Environment,
  key: EnvironmentKey,
  errors: string[],
): string {
  const value = environment[key]
  if (value === undefined || value.length === 0) {
    errors.push(key)
    return ''
  }
  if (value.trim() !== value) errors.push(key)
  return value
}

function exactInteger(
  environment: Environment,
  key: EnvironmentKey,
  fallback: number,
  minimum: number,
  maximum: number,
  errors: string[],
): number {
  const raw = environment[key]
  if (raw === undefined) return fallback
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    errors.push(key)
    return fallback
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    errors.push(key)
    return fallback
  }
  return value
}

function fixedInteger(
  environment: Environment,
  key: EnvironmentKey,
  expected: number,
  errors: string[],
): number {
  return exactInteger(environment, key, expected, expected, expected, errors)
}

function parseOrigin(raw: string, mode: ServerMode, errors: string[]): string {
  try {
    const url = new URL(raw)
    const isHttp = url.protocol === 'http:' || url.protocol === 'https:'
    const isExactOrigin =
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      raw === url.origin
    if (
      !isHttp ||
      !isExactOrigin ||
      (mode === 'production' && url.protocol !== 'https:')
    ) {
      errors.push('LOREMASTER_API_ORIGIN')
    }
    return url.origin
  } catch {
    errors.push('LOREMASTER_API_ORIGIN')
    return raw
  }
}

function validateDatabaseUrl(raw: string, errors: string[]): string {
  try {
    const url = new URL(raw)
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname.length === 0 ||
      url.username.length === 0 ||
      url.password.length === 0 ||
      url.pathname === '' ||
      url.pathname === '/'
    ) {
      errors.push('DATABASE_URL')
    }
  } catch {
    errors.push('DATABASE_URL')
  }
  return raw
}

function parseTrustedProxies(
  raw: string | undefined,
  errors: string[],
): TrustedProxy[] {
  if (raw === undefined || raw === '') return []
  const proxies: TrustedProxy[] = []
  const seen = new Set<string>()
  for (const entry of raw.split(',')) {
    if (entry.length === 0 || entry.trim() !== entry) {
      errors.push('LOREMASTER_API_TRUSTED_PROXIES')
      continue
    }
    const pieces = entry.split('/')
    if (pieces.length > 2) {
      errors.push('LOREMASTER_API_TRUSTED_PROXIES')
      continue
    }
    const address = pieces[0] ?? ''
    const detected = isIP(address)
    if (detected !== 4 && detected !== 6) {
      errors.push('LOREMASTER_API_TRUSTED_PROXIES')
      continue
    }
    const maximum = detected === 4 ? 32 : 128
    const prefixRaw = pieces[1]
    const prefixLength = prefixRaw === undefined ? maximum : Number(prefixRaw)
    if (
      prefixRaw !== undefined &&
      (!/^(0|[1-9][0-9]*)$/u.test(prefixRaw) ||
        !Number.isInteger(prefixLength) ||
        prefixLength < 0 ||
        prefixLength > maximum)
    ) {
      errors.push('LOREMASTER_API_TRUSTED_PROXIES')
      continue
    }
    const normalized = `${address}/${prefixLength}`
    if (seen.has(normalized)) {
      errors.push('LOREMASTER_API_TRUSTED_PROXIES')
      continue
    }
    seen.add(normalized)
    proxies.push({ address, prefixLength, version: detected })
  }
  return proxies
}

function parseCursorKey(
  environment: Environment,
  versionKey: EnvironmentKey,
  materialKey: EnvironmentKey,
  requiredKey: boolean,
  errors: string[],
): CursorHmacKey | undefined {
  const version = environment[versionKey]
  const material = environment[materialKey]
  if (version === undefined && material === undefined && !requiredKey)
    return undefined
  if (version === undefined || !cursorVersionPattern.test(version))
    errors.push(versionKey)
  if (material === undefined || !/^[A-Za-z0-9_-]+$/u.test(material)) {
    errors.push(materialKey)
    return undefined
  }
  const decoded = Buffer.from(material, 'base64url')
  if (decoded.byteLength < 32 || decoded.toString('base64url') !== material) {
    errors.push(materialKey)
  }
  if (version === undefined) return undefined
  return { version, key: new Uint8Array(decoded) }
}

function cookie(
  name: string,
  secure: boolean,
  httpOnly: boolean,
): CookieConfiguration {
  return { name, secure, httpOnly, sameSite: 'lax', path: '/' }
}

export function parseServerEnvironment(
  environment: Environment,
): ServerConfiguration {
  const errors: string[] = []
  for (const key of Object.keys(environment)) {
    if (key.startsWith('LOREMASTER_API_') && !allowedKeys.has(key))
      errors.push(key)
  }

  const modeRaw = required(environment, 'LOREMASTER_API_MODE', errors)
  const mode: ServerMode = modeRaw === 'production' ? 'production' : 'local'
  if (modeRaw !== 'local' && modeRaw !== 'production')
    errors.push('LOREMASTER_API_MODE')

  const databaseUrl = validateDatabaseUrl(
    required(environment, 'DATABASE_URL', errors),
    errors,
  )
  const origin = parseOrigin(
    required(environment, 'LOREMASTER_API_ORIGIN', errors),
    mode,
    errors,
  )
  const port = exactInteger(environment, 'PORT', 3000, 1, 65_535, errors)
  const trustedProxies = parseTrustedProxies(
    environment.LOREMASTER_API_TRUSTED_PROXIES,
    errors,
  )

  const expectedSessionName =
    mode === 'production'
      ? '__Host-loremaster_session'
      : 'loremaster_local_session'
  const expectedCsrfName =
    mode === 'production' ? '__Host-loremaster_csrf' : 'loremaster_local_csrf'
  const sessionName =
    environment.LOREMASTER_API_SESSION_COOKIE_NAME ?? expectedSessionName
  const csrfName =
    environment.LOREMASTER_API_CSRF_COOKIE_NAME ?? expectedCsrfName
  if (
    !cookieNamePattern.test(sessionName) ||
    sessionName !== expectedSessionName
  ) {
    errors.push('LOREMASTER_API_SESSION_COOKIE_NAME')
  }
  if (!cookieNamePattern.test(csrfName) || csrfName !== expectedCsrfName) {
    errors.push('LOREMASTER_API_CSRF_COOKIE_NAME')
  }
  if (sessionName === csrfName) {
    errors.push(
      'LOREMASTER_API_SESSION_COOKIE_NAME',
      'LOREMASTER_API_CSRF_COOKIE_NAME',
    )
  }

  const commandMs = fixedInteger(
    environment,
    'LOREMASTER_API_COMMAND_TIMEOUT_MS',
    5_000,
    errors,
  )
  const lockMs = fixedInteger(
    environment,
    'LOREMASTER_API_LOCK_TIMEOUT_MS',
    1_000,
    errors,
  )
  const statementMs = fixedInteger(
    environment,
    'LOREMASTER_API_STATEMENT_TIMEOUT_MS',
    3_000,
    errors,
  )
  if (!(lockMs < statementMs && statementMs < commandMs)) {
    errors.push(
      'LOREMASTER_API_LOCK_TIMEOUT_MS',
      'LOREMASTER_API_STATEMENT_TIMEOUT_MS',
      'LOREMASTER_API_COMMAND_TIMEOUT_MS',
    )
  }

  const active = parseCursorKey(
    environment,
    'LOREMASTER_API_CURSOR_ACTIVE_VERSION',
    'LOREMASTER_API_CURSOR_ACTIVE_KEY',
    true,
    errors,
  )
  const previous = parseCursorKey(
    environment,
    'LOREMASTER_API_CURSOR_PREVIOUS_VERSION',
    'LOREMASTER_API_CURSOR_PREVIOUS_KEY',
    false,
    errors,
  )
  const previousGraceSeconds = fixedInteger(
    environment,
    'LOREMASTER_API_CURSOR_PREVIOUS_GRACE_SECONDS',
    86_400,
    errors,
  )
  if (
    active !== undefined &&
    previous !== undefined &&
    (active.version === previous.version ||
      Buffer.from(active.key).equals(Buffer.from(previous.key)))
  ) {
    errors.push(
      'LOREMASTER_API_CURSOR_PREVIOUS_VERSION',
      'LOREMASTER_API_CURSOR_PREVIOUS_KEY',
    )
  }

  const guestCapacity = exactInteger(
    environment,
    'LOREMASTER_API_LIMITER_GUEST_CAPACITY',
    10_000,
    300,
    1_000_000,
    errors,
  )
  const ipCapacity = exactInteger(
    environment,
    'LOREMASTER_API_LIMITER_IP_CAPACITY',
    10_000,
    300,
    1_000_000,
    errors,
  )

  if (errors.length > 0 || active === undefined)
    throw new ConfigurationError(errors)

  return {
    mode,
    databaseUrl,
    origin,
    port,
    trustedProxies,
    cookies: {
      session: cookie(sessionName, mode === 'production', true),
      csrf: cookie(csrfName, mode === 'production', false),
    },
    timeouts: {
      commandMs: commandMs as 5_000,
      lockMs: lockMs as 1_000,
      statementMs: statementMs as 3_000,
    },
    cursor: {
      active,
      ...(previous === undefined ? {} : { previous }),
      previousGraceSeconds: previousGraceSeconds as 86_400,
    },
    limiter: {
      windowMs: 60_000,
      mutationsPerGuest: 30,
      mutationsPerIp: 120,
      autocompletePerGuest: 120,
      autocompletePerIp: 300,
      sessionCreationsPerIp: 10,
      guestCapacity,
      ipCapacity,
    },
    sessionAbsoluteTtlDays: 30,
  }
}
