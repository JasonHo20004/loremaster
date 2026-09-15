import { spawn, spawnSync } from 'node:child_process'
import { watch } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'

const pnpm = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const watchedDirectories = [
  'apps/api/src',
  'packages/config/src',
  'packages/contracts/src',
  'packages/database/src',
  'packages/observability/src',
]
let child
let rebuilding = false
let queued = false
let timer

function build() {
  const result = spawnSync(
    pnpm,
    ['pnpm', '--filter', '@loremaster/api...', 'build'],
    { cwd: repositoryRoot, stdio: 'inherit' },
  )
  return result.status === 0
}

function start() {
  child = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  })
}

async function stopChild() {
  const running = child
  if (running === undefined || running.exitCode !== null) return
  const exited = new Promise((resolve) => running.once('exit', resolve))
  running.kill('SIGTERM')
  await exited
}

async function rebuild() {
  if (rebuilding) {
    queued = true
    return
  }
  rebuilding = true
  await stopChild()
  if (build()) start()
  rebuilding = false
  if (queued) {
    queued = false
    await rebuild()
  }
}

const watchers = watchedDirectories.map((directory) =>
  watch(resolve(repositoryRoot, directory), { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => void rebuild(), 100)
  }),
)

async function shutdown() {
  for (const watcher of watchers) watcher.close()
  clearTimeout(timer)
  await stopChild()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

await rebuild()
