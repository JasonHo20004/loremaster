import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

export function writeSyntheticFixture(path, content) {
  // Synthetic bind mounts cross host/container UIDs; secrets use separate writers.
  writeFileSync(path, content, { mode: 0o644 })
  // Creation modes are filtered by umask and ignored when rewriting existing files.
  chmodSync(path, 0o644)
}

export function createTestStack(kind, options = {}) {
  const project = `loremaster-s8-${kind}-${randomUUID().slice(0, 8)}`
  const temporary = mkdtempSync(join(tmpdir(), `${project}-`))
  const manifest = resolve('deploy/compose/compose.yaml')
  const environment = {
    ...process.env,
    LOREMASTER_S8_PROJECT: project,
    LOREMASTER_S8_SECRET_DIR: join(temporary, 'secrets'),
    ...options.environment,
  }
  const files = [manifest, ...(options.files ?? [])]
  const prefix = [
    'compose',
    '-p',
    project,
    ...files.flatMap((file) => ['-f', file]),
  ]
  let touched = false

  function run(command, args, input, overrideEnvironment, timeoutMs = 180_000) {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: overrideEnvironment ?? environment,
      ...(input === undefined ? {} : { input }),
    })
    if (result.error || result.status !== 0)
      throw Error(
        `${command} ${args.slice(0, 4).join(' ')} failed: ${result.error?.code ?? result.stderr.slice(-1200)}${args.some((arg) => arg.includes('@playwright/test')) ? result.stdout.slice(-2500) : ''}`,
      )
    return result.stdout.trim()
  }
  function docker(...args) {
    return run('docker', args)
  }
  function compose(...args) {
    touched = true
    return docker(...prefix, ...args)
  }
  function wrapper(action, ...args) {
    touched = true
    return run(process.execPath, ['scripts/s8-compose.mjs', action, ...args])
  }
  function inspect(service) {
    const id = compose('ps', '-q', service)
    assert(id, `${service} has no container`)
    return JSON.parse(docker('inspect', id))[0]
  }
  async function until(label, predicate, timeoutMs = 60_000) {
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      try {
        if (await predicate()) return Math.round(performance.now() - start)
      } catch {
        // A dependency or its HTTP listener may still be transitioning.
      }
      await delay(500)
    }
    throw Error(`${label} did not settle within ${timeoutMs} ms`)
  }
  async function health(service, expected = 'healthy') {
    return until(
      `${service} ${expected}`,
      () => inspect(service).State.Health?.Status === expected,
    )
  }
  function serviceHttp(service, path) {
    const port = { api: 3000, worker: 3001, observer: 3002 }[service]
    assert(port, `No private HTTP port for ${service}`)
    const script = `fetch('http://127.0.0.1:${port}${path}',{signal:AbortSignal.timeout(1800)}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()}))).catch(()=>process.exit(2))`
    return JSON.parse(
      docker('exec', inspect(service).Id, '/usr/local/bin/node', '-e', script),
    )
  }
  async function gateway(path, init) {
    const response = await globalThis.fetch(`http://127.0.0.1:8080${path}`, {
      ...init,
      signal: globalThis.AbortSignal.timeout(5_000),
    })
    return {
      status: response.status,
      body: await response.text(),
      headers: response.headers,
    }
  }
  function sql(statement) {
    return run(
      'docker',
      [
        ...prefix,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'migration',
        '-d',
        'loremaster',
        '-At',
      ],
      statement,
    ).trim()
  }
  function resources(type) {
    return docker(
      type,
      'ls',
      ...(type === 'container' ? ['-a'] : []),
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.ID}}',
    ).trim()
  }
  function cleanup() {
    if (!touched) return rmSync(temporary, { recursive: true, force: true })
    docker(
      ...prefix,
      '--profile',
      'bootstrap',
      '--profile',
      'operator',
      'down',
      '--volumes',
      '--remove-orphans',
    )
    for (const type of ['container', 'network', 'volume'])
      assert.equal(resources(type), '', `Residual ${type} for ${project}`)
    rmSync(temporary, { recursive: true, force: true })
  }
  return {
    project,
    temporary,
    environment,
    files,
    run,
    docker,
    compose,
    wrapper,
    inspect,
    until,
    health,
    serviceHttp,
    gateway,
    sql,
    cleanup,
  }
}
