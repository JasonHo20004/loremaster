import { randomBytes } from 'node:crypto'
import { URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { root } from './s9-common.mjs'

export const secretGroups = {
  postgres: ['postgres_password'],
  redis: ['redis_acl'],
  migration: ['migration_database_url'],
  importer: ['importer_database_url'],
  api: [
    'api_database_url',
    'producer_database_url',
    'cursor_key',
    'limiter_hmac_key',
    'redis_api_cache_url',
    'redis_api_limiter_url',
    'redis_producer_url',
  ],
  worker: ['worker_database_url', 'redis_worker_url', 'redis_worker_cache_url'],
  observer: ['redis_observer_url'],
}
export function generateSecrets() {
  const password = () => randomBytes(32).toString('base64url')
  const postgresPassword = password()
  const db = (login, credential = password()) =>
    `postgresql://${login}:${credential}@postgres:5432/loremaster`
  const { roles } = JSON.parse(
    readFileSync(resolve(root, 'ops/redis/acl-policy.json'), 'utf8'),
  )
  const { scripts } = JSON.parse(
    readFileSync(
      resolve(root, 'ops/redis/bullmq-script-inventory.json'),
      'utf8',
    ),
  )
  const acl = [
    `user default off >${password()} -@all`,
    'user loremaster_health on nopass -@all +ping',
  ]
  const urls = {}
  for (const [role, rule] of Object.entries(roles)) {
    const credential = password()
    const commands = new Set([
      'auth',
      'hello',
      'ping',
      'quit',
      'client|setname',
      'client|setinfo',
      ...rule.commands,
    ])
    for (const script of Object.values(scripts))
      if (script.roles.includes(rule.bullmqRole))
        for (const command of script.commands) commands.add(command)
    acl.push(
      [
        'user',
        role,
        'reset',
        'on',
        `>${credential}`,
        ...rule.patterns,
        ...[...commands].map((command) => '+' + command),
      ].join(' '),
    )
    urls[role] = `redis://${role}:${credential}@redis:6379`
  }
  return {
    postgres_password: postgresPassword,
    redis_acl: acl.join('\n') + '\n',
    migration_database_url: db('migration', postgresPassword),
    importer_database_url: db('importer'),
    api_database_url: db('api'),
    producer_database_url: db('producer'),
    worker_database_url: db('worker'),
    cursor_key: password(),
    limiter_hmac_key: password(),
    redis_api_cache_url: urls.loremaster_api_cache,
    redis_api_limiter_url: urls.loremaster_api_limiter,
    redis_producer_url: urls.loremaster_producer,
    redis_worker_url: urls.loremaster_worker,
    redis_worker_cache_url: urls.loremaster_worker_cache,
    redis_observer_url: urls.loremaster_observer,
  }
}
export function roleSql(secrets) {
  return [
    ['api', 'loremaster_runtime'],
    ['producer', 'loremaster_cache_producer'],
    ['worker', 'loremaster_cache_worker'],
    ['importer', 'loremaster_importer'],
  ]
    .map(([login, group]) => {
      const credential = new URL(secrets[`${login}_database_url`]).password
      if (!/^[A-Za-z0-9_-]{43}$/u.test(credential))
        throw Error('Invalid generated role credential')
      return `DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login}') THEN CREATE ROLE ${login} LOGIN PASSWORD '${credential}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $role$;\nGRANT ${group} TO ${login};`
    })
    .join('\n')
}
