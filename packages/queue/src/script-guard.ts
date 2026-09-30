import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Redis } from 'ioredis'

interface ReviewedScript {
  readonly roles: readonly string[]
  readonly numberOfKeys: number
  readonly sha256: string
}
interface Inventory {
  readonly bullmqVersion: string
  readonly scripts: Readonly<Record<string, ReviewedScript>>
}
const inventory = JSON.parse(
  readFileSync(
    new URL('../../../ops/redis/bullmq-script-inventory.json', import.meta.url),
    'utf8',
  ),
) as Inventory
const keyPattern = /^loremaster:v1:queue:loremaster-warm-v1:[A-Za-z0-9:_-]+$/u

/** Every BullMQ script invocation is admitted against the pinned source ledger. */
export function guardQueueClient(
  client: Redis,
  role: 'producer' | 'worker',
): Redis {
  const define = client.defineCommand.bind(client)
  client.defineCommand = ((
    name: string,
    options: { numberOfKeys?: number; lua: string },
  ) => {
    define(name, options)
    const [base, version] = name.split(':')
    const reviewed = base ? inventory.scripts[base] : undefined
    const valid =
      version === inventory.bullmqVersion &&
      reviewed?.roles.includes(role) === true &&
      reviewed.numberOfKeys === options.numberOfKeys &&
      reviewed.sha256 === createHash('sha256').update(options.lua).digest('hex')
    const raw = (
      client as unknown as Record<string, (...args: unknown[]) => unknown>
    )[name]
    if (typeof raw !== 'function')
      throw new Error('Missing BullMQ script command')
    ;(client as unknown as Record<string, unknown>)[name] = (args: unknown) => {
      if (
        !valid ||
        !Array.isArray(args) ||
        args.length < reviewed!.numberOfKeys ||
        args
          .slice(0, reviewed!.numberOfKeys)
          .some((key) => typeof key !== 'string' || !keyPattern.test(key))
      )
        throw new Error('Unreviewed queue script')
      return raw.call(client, args)
    }
  }) as typeof client.defineCommand
  const duplicate = client.duplicate.bind(client)
  client.duplicate = ((options?: Parameters<Redis['duplicate']>[0]) =>
    guardQueueClient(duplicate(options), role)) as typeof client.duplicate
  return client
}
