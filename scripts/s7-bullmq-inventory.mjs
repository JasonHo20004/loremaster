import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { URL } from 'node:url'
import process from 'node:process'
import { collectScriptCommands } from './s7-bullmq-policy.mjs'

const require = createRequire(
  new URL('../packages/queue/package.json', import.meta.url),
)
const scripts = require('bullmq/dist/cjs/scripts/index.js')
const packageVersion = require('bullmq/package.json').version
if (packageVersion !== '5.81.5') throw new Error('Unexpected BullMQ version')

const inventoryPath = new URL(
  '../ops/redis/bullmq-script-inventory.json',
  import.meta.url,
)
const reviewedInventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
if (reviewedInventory.bullmqVersion !== packageVersion)
  throw new Error('Script source review required')
const dynamicPushes = {
  addStandardJob: ['lpush', 'rpush'],
  removeJob: ['rpush'],
  moveToFinished: ['lpush', 'rpush'],
  moveStalledJobsToWait: ['rpush'],
  retryJob: ['lpush', 'rpush'],
  // Expanded unused parent helpers contain a dynamic call, never invoked here.
  moveToActive: [],
  moveToDelayed: [],
}

const names = {
  producer: ['addStandardJob', 'getStateV2', 'removeJob'],
  worker: [
    'moveToActive',
    'moveToFinished',
    'moveStalledJobsToWait',
    'moveToDelayed',
    'retryJob',
    'extendLocks',
  ],
}
const inventory = { version: 1, bullmqVersion: packageVersion, scripts: {} }
for (const [role, allowedNames] of Object.entries(names)) {
  for (const name of allowedNames) {
    const script = Object.values(scripts).find(
      (candidate) => candidate.name === name,
    )
    if (!script) throw new Error(`Missing reviewed script: ${name}`)
    const sha256 = createHash('sha256').update(script.content).digest('hex')
    if (reviewedInventory.scripts[name]?.sha256 !== sha256)
      throw new Error(`Script source review required: ${name}`)
    const hasDynamicPush = Object.hasOwn(dynamicPushes, name)
    const commands = collectScriptCommands(
      script.content,
      dynamicPushes[name] ?? [],
      hasDynamicPush ? 1 : 0,
    )
    inventory.scripts[name] = {
      roles: [role],
      numberOfKeys: script.keys,
      sha256,
      dynamicPushCommands: dynamicPushes[name] ?? [],
      commands,
    }
  }
}
if (process.argv[2] === '--check') {
  if (JSON.stringify(reviewedInventory) !== JSON.stringify(inventory))
    throw new Error('BullMQ inventory differs from reviewed contract')
} else if (process.argv.length === 2) {
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
} else {
  throw new Error('Unexpected inventory command argument')
}
