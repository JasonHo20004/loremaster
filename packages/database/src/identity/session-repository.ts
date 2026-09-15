import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'

import type { PoolClient } from 'pg'

import type { Database } from '../migrate.js'

const secretPattern = /^[A-Za-z0-9_-]{43}$/u
const maximumCreateAttempts = 3

export interface TrustedIdentity {
  readonly guestId: string
  readonly sessionId: string
}

export interface AuthenticatedSession extends TrustedIdentity {
  readonly csrfHash: Uint8Array
  readonly expiresAt: Date
  readonly pseudonym: string
}

export interface CreatedGuestSession extends AuthenticatedSession {
  readonly authenticationToken: string
  readonly csrfToken: string
}

interface SessionRow {
  readonly csrf_hash: Buffer
  readonly expires_at: Date
  readonly guest_id: string
  readonly pseudonym: string
  readonly session_id: string
}

interface PostgreSqlError {
  readonly code?: unknown
}

export class SessionPersistenceError extends Error {
  readonly code = 'SESSION_PERSISTENCE_FAILED'

  constructor() {
    super('Session persistence failed')
    this.name = 'SessionPersistenceError'
  }
}

function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

function generatePseudonym(): string {
  return `Guest-${randomBytes(8).toString('base64url')}`
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as PostgreSqlError).code === '23505'
  )
}

async function createOnce(db: Database): Promise<CreatedGuestSession> {
  const guestId = randomUUID()
  const sessionId = randomUUID()
  const authenticationToken = generateSecret()
  const csrfToken = generateSecret()
  const pseudonym = generatePseudonym()
  const authenticationHash = hashSecret(authenticationToken)
  const csrfHash = hashSecret(csrfToken)

  let client: PoolClient | undefined
  try {
    client = await db.connect()
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE loremaster_runtime')
    const result = await client.query<SessionRow>(
      `WITH instant AS (SELECT clock_timestamp() AS now),
       inserted_guest AS (
         INSERT INTO loremaster.guests (id, pseudonym, created_at)
         SELECT $1::uuid, $2::text, now FROM instant
         RETURNING id, pseudonym
       )
       INSERT INTO loremaster.guest_sessions
         (id, guest_id, token_hash, csrf_hash, created_at, expires_at)
       SELECT $3::uuid, inserted_guest.id, $4::bytea, $5::bytea,
              instant.now, instant.now + interval '30 days'
       FROM inserted_guest CROSS JOIN instant
       RETURNING guest_id::text, id::text AS session_id, csrf_hash,
                 expires_at,
                 (SELECT pseudonym FROM inserted_guest) AS pseudonym`,
      [guestId, pseudonym, sessionId, authenticationHash, csrfHash],
    )
    const row = result.rows[0]
    if (row === undefined) throw new SessionPersistenceError()
    await client.query('COMMIT')
    return {
      guestId: row.guest_id,
      sessionId: row.session_id,
      pseudonym: row.pseudonym,
      expiresAt: row.expires_at,
      csrfHash: new Uint8Array(row.csrf_hash),
      authenticationToken,
      csrfToken,
    }
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client?.release()
  }
}

export async function createGuestSession(
  db: Database,
): Promise<CreatedGuestSession> {
  for (let attempt = 1; attempt <= maximumCreateAttempts; attempt += 1) {
    try {
      return await createOnce(db)
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === maximumCreateAttempts) {
        throw new SessionPersistenceError()
      }
    }
  }
  throw new SessionPersistenceError()
}

export async function authenticateSession(
  db: Database,
  authenticationToken: string,
): Promise<AuthenticatedSession | null> {
  if (!secretPattern.test(authenticationToken)) return null
  const authenticationHash = hashSecret(authenticationToken)
  let client: PoolClient | undefined
  try {
    client = await db.connect()
    await client.query('BEGIN READ ONLY')
    await client.query('SET LOCAL ROLE loremaster_runtime')
    const result = await client.query<SessionRow>(
      `SELECT session.guest_id::text, session.id::text AS session_id,
              session.csrf_hash, session.expires_at, guest.pseudonym
       FROM loremaster.guest_sessions session
       JOIN loremaster.guests guest ON guest.id = session.guest_id
       WHERE session.token_hash = $1::bytea
         AND session.expires_at > clock_timestamp()`,
      [authenticationHash],
    )
    await client.query('COMMIT')
    const row = result.rows[0]
    if (row === undefined) return null
    return {
      guestId: row.guest_id,
      sessionId: row.session_id,
      pseudonym: row.pseudonym,
      expiresAt: row.expires_at,
      csrfHash: new Uint8Array(row.csrf_hash),
    }
  } catch {
    await client?.query('ROLLBACK').catch(() => undefined)
    throw new SessionPersistenceError()
  } finally {
    client?.release()
  }
}

export function verifySessionCsrfToken(
  session: Pick<AuthenticatedSession, 'csrfHash'>,
  csrfToken: string,
): boolean {
  if (!secretPattern.test(csrfToken)) return false
  const actual = hashSecret(csrfToken)
  const expected = Buffer.from(session.csrfHash)
  return (
    expected.byteLength === actual.byteLength &&
    timingSafeEqual(expected, actual)
  )
}
