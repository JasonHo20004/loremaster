import { createHash, randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  authenticateSession,
  createGuestSession,
  SessionPersistenceError,
  verifySessionCsrfToken,
} from '../../packages/database/dist/identity/index.js'
import {
  closeDatabase,
  database,
  migrateToLatest,
  type Database,
} from '../../packages/database/dist/migrate.js'

const migrationConnectionString = process.env.LOREMASTER_TEST_DATABASE_URL
const runtimeConnectionString = process.env.LOREMASTER_TEST_RUNTIME_DATABASE_URL
if (
  migrationConnectionString === undefined ||
  runtimeConnectionString === undefined
) {
  throw new Error(
    'Migration and runtime database URLs are required; run this suite with `pnpm test:database`',
  )
}

let migrationDb: Database
let runtimeDb: Database

beforeAll(() => {
  migrationDb = database(migrationConnectionString)
  runtimeDb = database(runtimeConnectionString)
})

afterAll(async () => {
  await Promise.all([closeDatabase(migrationDb), closeDatabase(runtimeDb)])
})

describe('S5.2 guest session repository', () => {
  it('atomically creates unique identities with hash-only secret persistence', async () => {
    const first = await createGuestSession(runtimeDb)
    const second = await createGuestSession(runtimeDb)

    expect(first.guestId).not.toBe(second.guestId)
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.authenticationToken).not.toBe(second.authenticationToken)
    expect(first.csrfToken).not.toBe(second.csrfToken)
    expect(first.authenticationToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(first.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(first.pseudonym.length).toBeGreaterThanOrEqual(1)
    expect(first.pseudonym.length).toBeLessThanOrEqual(48)

    const persisted = await migrationDb.query<{
      csrf_hash: Buffer
      duration: string
      pseudonym: string
      token_hash: Buffer
    }>(
      `SELECT session.token_hash, session.csrf_hash, guest.pseudonym,
              (session.expires_at - session.created_at)::text AS duration
       FROM loremaster.guest_sessions session
       JOIN loremaster.guests guest ON guest.id = session.guest_id
       WHERE session.id = $1`,
      [first.sessionId],
    )
    expect(persisted.rows[0]).toMatchObject({
      pseudonym: first.pseudonym,
      duration: '30 days',
      token_hash: createHash('sha256')
        .update(first.authenticationToken, 'utf8')
        .digest(),
      csrf_hash: createHash('sha256').update(first.csrfToken, 'utf8').digest(),
    })
    expect(JSON.stringify(persisted.rows[0])).not.toContain(
      first.authenticationToken,
    )
    expect(JSON.stringify(persisted.rows[0])).not.toContain(first.csrfToken)
  })

  it('authenticates the token hash, verifies bound CSRF, and isolates sessions', async () => {
    const first = await createGuestSession(runtimeDb)
    const second = await createGuestSession(runtimeDb)
    const authenticated = await authenticateSession(
      runtimeDb,
      first.authenticationToken,
    )

    expect(authenticated).toMatchObject({
      guestId: first.guestId,
      sessionId: first.sessionId,
      pseudonym: first.pseudonym,
    })
    expect(verifySessionCsrfToken(authenticated!, first.csrfToken)).toBe(true)
    expect(verifySessionCsrfToken(authenticated!, second.csrfToken)).toBe(false)
    expect(
      await authenticateSession(runtimeDb, second.authenticationToken),
    ).toMatchObject({
      guestId: second.guestId,
      sessionId: second.sessionId,
    })
    expect(await authenticateSession(runtimeDb, 'invalid')).toBeNull()
    expect(
      await authenticateSession(
        runtimeDb,
        randomBytes(32).toString('base64url'),
      ),
    ).toBeNull()
  })

  it('rejects absolute expiry without extending it on authentication reads', async () => {
    const created = await createGuestSession(runtimeDb)
    const before = await migrationDb.query<{ expires_at: Date }>(
      'SELECT expires_at FROM loremaster.guest_sessions WHERE id = $1',
      [created.sessionId],
    )
    await migrationDb.query(
      `UPDATE loremaster.guest_sessions
       SET expires_at = created_at + interval '1 microsecond'
       WHERE id = $1`,
      [created.sessionId],
    )

    expect(
      await authenticateSession(runtimeDb, created.authenticationToken),
    ).toBeNull()
    const after = await migrationDb.query<{ expires_at: Date }>(
      'SELECT expires_at FROM loremaster.guest_sessions WHERE id = $1',
      [created.sessionId],
    )
    expect(after.rows[0]!.expires_at.getTime()).toBeLessThan(
      before.rows[0]!.expires_at.getTime(),
    )
  })

  it('uses the runtime login and proves it cannot migrate, perform DDL, or mutate content', async () => {
    expect((await runtimeDb.query('SELECT 1 AS ready')).rows[0]).toEqual({
      ready: 1,
    })
    const principal = await runtimeDb.query<{ current_user: string }>(
      'SELECT current_user',
    )
    const memberships = await migrationDb.query<{ role_name: string }>(
      `SELECT role.rolname AS role_name
       FROM pg_auth_members membership
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles role ON role.oid = membership.roleid
       WHERE member.rolname = $1
       ORDER BY role.rolname`,
      [principal.rows[0]!.current_user],
    )
    expect(memberships.rows).toEqual([{ role_name: 'loremaster_runtime' }])
    await expect(
      runtimeDb.query('CREATE TABLE loremaster.runtime_forbidden (id integer)'),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      runtimeDb.query('SET ROLE loremaster_importer'),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      runtimeDb.query(
        `UPDATE loremaster.case_revisions SET briefing = 'forbidden'
         WHERE false`,
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(migrateToLatest(runtimeDb)).rejects.toMatchObject({
      code: '42501',
    })
  })

  it('does not include supplied secrets in repository errors', async () => {
    const secret = randomBytes(32).toString('base64url')
    const closed = database(runtimeConnectionString)
    await closeDatabase(closed)
    await expect(authenticateSession(closed, secret)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionPersistenceError &&
        !String(error).includes(secret),
    )
  })
})
