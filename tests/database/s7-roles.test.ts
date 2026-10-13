import { readFile } from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  database,
  type Database,
} from '../../packages/database/dist/migrate.js'

const connectionString = process.env.LOREMASTER_TEST_DATABASE_URL
if (connectionString === undefined)
  throw new Error('Run with pnpm test:database')
let db: Database
beforeAll(() => {
  db = database(connectionString)
})
afterAll(async () => db.end())

describe('S7.1 worker database role contract', () => {
  it('exposes eligible published suggestions but excludes ineligible entities and aliases', async () => {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "INSERT INTO loremaster.content_packs (id, stable_key) VALUES ('55555555-5555-4555-8555-555555555555', 's7-eligible-pack')",
      )
      await client.query(`INSERT INTO loremaster.case_revisions
        (id, pack_id, revision_number, slot_id, opens_at, closes_at, briefing, case_key, title, author, provenance, content_version)
        VALUES ('66666666-6666-4666-8666-666666666666','55555555-5555-4555-8555-555555555555',1,'2098-01-03','2098-01-03T00:00:00Z','2098-01-04T00:00:00Z','briefing','s7-eligible','Test','Test','ORIGINAL_AUTHORED','1.0.0')`)
      await client.query(`INSERT INTO loremaster.case_entities (revision_id,entity_id,public_id,canonical_name,role,is_eligible)
        VALUES ('66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777','eligible-person','Visible','Test',true),
        ('66666666-6666-4666-8666-666666666666','88888888-8888-4888-8888-888888888888','ineligible-person','Hidden','Test',false)`)
      await client.query(`INSERT INTO loremaster.entity_aliases (revision_id,entity_id,alias)
        VALUES ('66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777','Visible Alias'),
        ('66666666-6666-4666-8666-666666666666','88888888-8888-4888-8888-888888888888','Hidden Alias')`)
      await client.query(
        "INSERT INTO loremaster.region_catalog(id) VALUES ('s7-role-region')",
      )
      await client.query(
        "INSERT INTO loremaster.revision_regions(revision_id,region_id,display_name) VALUES ('66666666-6666-4666-8666-666666666666','s7-role-region','Test Region')",
      )
      for (let order = 1; order <= 4; order++) {
        await client.query(
          "INSERT INTO loremaster.case_evidence(revision_id,evidence_order,evidence_text,explanation) VALUES ('66666666-6666-4666-8666-666666666666',$1,'evidence','explanation')",
          [order],
        )
      }
      await client.query(
        "UPDATE loremaster.case_revisions SET answer_entity_id='77777777-7777-4777-8777-777777777777',status='PUBLISHED',published_at=clock_timestamp() WHERE id='66666666-6666-4666-8666-666666666666'",
      )
      await client.query('SET LOCAL ROLE loremaster_cache_worker')
      const entities = await client.query(
        "SELECT public_id FROM loremaster.cache_published_entities WHERE revision_id='66666666-6666-4666-8666-666666666666'",
      )
      const aliases = await client.query(
        "SELECT alias FROM loremaster.cache_published_aliases WHERE revision_id='66666666-6666-4666-8666-666666666666'",
      )
      expect(entities.rows).toEqual([{ public_id: 'eligible-person' }])
      expect(aliases.rows).toEqual([{ alias: 'Visible Alias' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it.each(['loremaster_cache_worker', 'loremaster_cache_producer'])(
    'keeps %s privileges and memberships bounded',
    async (role) => {
      const result = await db.query(
        'SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls FROM pg_roles WHERE rolname=$1',
        [role],
      )
      expect(result.rows).toEqual([
        {
          rolcanlogin: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolbypassrls: false,
        },
      ])
      const memberships = await db.query(
        'SELECT 1 FROM pg_auth_members WHERE member=$1::regrole',
        [role],
      )
      expect(memberships.rowCount).toBe(0)
    },
  )

  it.each([
    'SELECT * FROM loremaster.case_revisions',
    'SELECT * FROM loremaster.case_entities',
    'SELECT * FROM loremaster.guests',
    'SELECT * FROM loremaster.attempts',
    'UPDATE loremaster.case_revisions SET title=title WHERE false',
    'CREATE TABLE loremaster.producer_forbidden (id integer)',
    'SET LOCAL ROLE loremaster_runtime',
    'SET LOCAL ROLE loremaster_importer',
    'SET LOCAL ROLE loremaster_cache_worker',
  ])('denies producer %s', async (sql) => {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'SET LOCAL SESSION AUTHORIZATION loremaster_cache_producer',
      )
      await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  it('gives the producer published revision metadata only', async () => {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'SET LOCAL SESSION AUTHORIZATION loremaster_cache_producer',
      )
      await expect(
        client.query(
          'SELECT id, opens_at, closes_at FROM loremaster.cache_published_revisions WHERE opens_at<=clock_timestamp() LIMIT 0',
        ),
      ).resolves.toBeDefined()
      await expect(
        client.query('SELECT * FROM loremaster.cache_published_entities'),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('does not expose draft revisions, entities or aliases', async () => {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // A draft needs no completed publication data; all writes roll back.
      await client.query(
        "INSERT INTO loremaster.content_packs (id,stable_key) VALUES ('22222222-2222-4222-8222-222222222222','s7-role-draft')",
      )
      await client.query(`INSERT INTO loremaster.case_revisions
        (id,pack_id,revision_number,slot_id,opens_at,closes_at,briefing,case_key,title,author,provenance,content_version)
        VALUES ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222',1,'2098-01-01','2098-01-01T00:00:00Z','2098-01-02T00:00:00Z','draft','s7-draft','Draft','Test','ORIGINAL_AUTHORED','1.0.0')`)
      await client.query(`INSERT INTO loremaster.case_entities (revision_id,entity_id,public_id,canonical_name,role)
        VALUES ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','draft-person','Draft Person','Hidden')`)
      await client.query(`INSERT INTO loremaster.entity_aliases (revision_id,entity_id,alias)
        VALUES ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','Hidden Alias')`)
      await client.query('SET LOCAL ROLE loremaster_cache_worker')
      for (const [view, column] of [
        ['cache_published_revisions', 'id'],
        ['cache_published_entities', 'revision_id'],
        ['cache_published_aliases', 'revision_id'],
      ] as const) {
        const result = await client.query(
          `SELECT * FROM loremaster.${view} WHERE ${column}=$1`,
          ['33333333-3333-4333-8333-333333333333'],
        )
        expect(result.rows).toEqual([])
      }
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('rolls down its views and roles without modifying existing runtime privileges', async () => {
    const sql = await readFile(
      new URL(
        '../../packages/database/migrations/0005_s7_cache_roles.down.sql',
        import.meta.url,
      ),
      'utf8',
    )
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      const roles = await client.query(
        "SELECT rolname FROM pg_roles WHERE rolname IN ('loremaster_cache_worker','loremaster_cache_producer')",
      )
      expect(roles.rows).toEqual([])
      const runtime = await client.query(
        "SELECT has_table_privilege('loremaster_runtime','loremaster.attempts','SELECT') AS allowed",
      )
      expect(runtime.rows).toEqual([{ allowed: true }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  it('provides a non-login role without elevated privileges or inherited membership', async () => {
    const result = await db.query(
      "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls FROM pg_roles WHERE rolname='loremaster_cache_worker'",
    )
    expect(result.rows).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolbypassrls: false,
      },
    ])
    const memberships = await db.query(
      "SELECT 1 FROM pg_auth_members WHERE member='loremaster_cache_worker'::regrole",
    )
    expect(memberships.rowCount).toBe(0)
  })

  it('allows only the suggestion and revision-selection columns', async () => {
    const client = await db.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query('SET LOCAL ROLE loremaster_cache_worker')
      await expect(
        client.query(`SELECT revision.id, revision.status, revision.slot_id, revision.opens_at, revision.closes_at,
        entity.entity_id, entity.public_id, entity.canonical_name, entity.role, entity.is_eligible, alias.alias
        FROM loremaster.cache_published_revisions revision
        JOIN loremaster.cache_published_entities entity ON entity.revision_id=revision.id
        JOIN loremaster.cache_published_aliases alias ON alias.revision_id=entity.revision_id AND alias.entity_id=entity.entity_id
        WHERE revision.status='PUBLISHED' AND entity.is_eligible AND revision.opens_at<=clock_timestamp() LIMIT 0`),
      ).resolves.toBeDefined()
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it.each([
    'SELECT briefing FROM loremaster.case_revisions',
    'SELECT canonical_name FROM loremaster.case_entities',
    'SELECT alias FROM loremaster.entity_aliases',
    'SELECT answer_entity_id FROM loremaster.case_revisions',
    'SELECT * FROM loremaster.guests',
    'SELECT * FROM loremaster.guest_sessions',
    'SELECT * FROM loremaster.attempts',
    'SELECT * FROM loremaster.case_evidence',
    'SELECT * FROM loremaster.case_sources',
    'SELECT * FROM loremaster.content_packs',
    'UPDATE loremaster.case_entities SET canonical_name=canonical_name WHERE false',
    'DELETE FROM loremaster.entity_aliases WHERE false',
    'CREATE TABLE loremaster.worker_forbidden (id integer)',
    'SET LOCAL ROLE loremaster_runtime',
    'SET LOCAL ROLE loremaster_importer',
  ])('denies %s', async (sql) => {
    // SET SESSION AUTHORIZATION removes the test superuser ability to switch roles.
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'SET LOCAL SESSION AUTHORIZATION loremaster_cache_worker',
      )
      await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
