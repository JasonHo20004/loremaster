import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'

import { pendingHttpClientScript } from '../../scripts/s8-pending-client.mjs'

it('holds a request acknowledged by the API until its server closes the connection', async () => {
  const server = createServer()
  let accepted = false
  let body = ''
  server.on('checkContinue', (request, response) => {
    accepted = true
    response.writeContinue()
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing port')
  const child = spawn(process.execPath, [
    '-e',
    pendingHttpClientScript('127.0.0.1', address.port),
  ])
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const exit = once(child, 'close')
  try {
    await expect.poll(() => output.includes('OPEN\n')).toBe(true)
    expect(accepted).toBe(true)
    await expect.poll(() => body).toBe('{')
    expect(output).not.toContain('CLOSED')
    server.closeAllConnections()
    expect((await exit)[0]).toBe(0)
    expect(output).toContain('CLOSED\n')
    expect(output).not.toContain('ERROR')
  } finally {
    if (child.exitCode === null) child.kill()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
