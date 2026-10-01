import { createServer } from 'node:http'

export const PRIVATE_HEALTH_POLICY = Object.freeze({
  host: '127.0.0.1' as const,
  workerPort: 3001,
  observerPort: 3002,
  deadlineMs: 1000,
  drainMs: 1000,
})

/** Process-only liveness; dependency probes are single-flight and cancellable. */
export function createPrivateHealthServer(options: {
  port: number
  ready(signal: AbortSignal): Promise<boolean>
  metrics?(signal: AbortSignal): Promise<string>
}) {
  let draining = false
  let stopping: Promise<void> | undefined
  let starting: Promise<number> | undefined
  let probing: Promise<boolean> | undefined
  const controllers = new Set<AbortController>()
  async function bounded<T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    controllers.add(controller)
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        work(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('Health deadline'))
          }, PRIVATE_HEALTH_POLICY.deadlineMs)
          timer.unref()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      controllers.delete(controller)
    }
  }
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json')
    const send = (status: number, state: string) => {
      response.writeHead(status).end(JSON.stringify({ status: state }))
    }
    if (request.method !== 'GET') return send(405, 'unavailable')
    if (request.url === '/health/live') return send(200, 'ok')
    if (
      request.url !== '/health/ready' &&
      !(options.metrics && request.url === '/metrics')
    )
      return send(404, 'unavailable')
    if (draining) return send(503, 'draining')
    if (request.url === '/metrics' && options.metrics) {
      void bounded(options.metrics).then(
        (metrics) => {
          response.setHeader(
            'Content-Type',
            'text/plain; version=0.0.4; charset=utf-8',
          )
          response.writeHead(200).end(metrics)
        },
        () => send(503, 'unavailable'),
      )
      return
    }
    probing ??= bounded(options.ready)
      .catch(() => false)
      .finally(() => {
        probing = undefined
      })
    void probing.then((ready) =>
      send(
        ready && !draining ? 200 : 503,
        draining ? 'draining' : ready ? 'ready' : 'unavailable',
      ),
    )
  })
  server.requestTimeout = PRIVATE_HEALTH_POLICY.deadlineMs
  server.headersTimeout = PRIVATE_HEALTH_POLICY.deadlineMs
  server.keepAliveTimeout = PRIVATE_HEALTH_POLICY.deadlineMs
  server.maxHeadersCount = 16
  return {
    server,
    async start(): Promise<number> {
      if (draining || starting)
        throw new Error('Health already started or stopped')
      starting = new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port, PRIVATE_HEALTH_POLICY.host, () => {
          server.off('error', reject)
          const address = server.address()
          if (!address || typeof address === 'string')
            return reject(new Error('Health bind failed'))
          resolve(address.port)
        })
      })
      return starting
    },
    drain() {
      draining = true
    },
    stop(): Promise<void> {
      stopping ??= (async () => {
        draining = true
        for (const controller of controllers) controller.abort()
        await starting?.catch(() => undefined)
        if (!server.listening) return
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => server.closeAllConnections(),
            PRIVATE_HEALTH_POLICY.drainMs,
          )
          timer.unref()
          server.close(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      })()
      return stopping
    },
  }
}
