const forbidden = new Set([
  'keys',
  'scan',
  'flushall',
  'flushdb',
  'config',
  'acl',
  'monitor',
  'eval',
  'evalsha',
  'script',
  'debug',
])

/** The expanded source hash is checked by the generator before this analysis. */
export function collectScriptCommands(
  source,
  reviewedPushCommands,
  expectedDynamicCount,
) {
  const commands = new Set()
  let dynamicCount = 0
  for (const match of source.matchAll(
    /(?:rcall|redis\.(?:call|pcall))\s*\(\s*([^,\n)]+)/gu,
  )) {
    const expression = match[1].trim()
    const literal = /^["']([A-Za-z]+)["']$/u.exec(expression)
    if (literal) {
      const command = literal[1].toLowerCase()
      if (forbidden.has(command))
        throw new Error('Forbidden Redis script command')
      commands.add(command)
    } else if (expression === 'pushCmd') {
      dynamicCount++
      for (const command of reviewedPushCommands) {
        if (command !== 'lpush' && command !== 'rpush')
          throw new Error('Unreviewed dynamic Redis command')
        commands.add(command)
      }
    } else {
      throw new Error('Unreviewed dynamic Redis command')
    }
  }
  if (dynamicCount !== expectedDynamicCount)
    throw new Error('Unexpected dynamic Redis call count')
  return [...commands].sort()
}
