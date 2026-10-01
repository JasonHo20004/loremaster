export const QUEUE_METRIC_NAMES = Object.freeze({
  waiting: 'loremaster_queue_waiting',
  active: 'loremaster_queue_active',
  delayed: 'loremaster_queue_delayed',
  completed: 'loremaster_queue_completed',
  failed: 'loremaster_queue_failed',
  oldestRetainedAgeSeconds: 'loremaster_queue_oldest_retained_age_seconds',
  workerConnected: 'loremaster_queue_worker_connected',
  degraded: 'loremaster_queue_degraded',
})
export interface QueueSnapshot {
  waiting: number
  active: number
  delayed: number
  completed: number
  failed: number
  oldestRetainedAgeSeconds: number
  workerConnected: number
  degraded: number
}
export function renderQueueMetrics(value: QueueSnapshot): string {
  const limits: QueueSnapshot = {
    waiting: 128,
    active: 128,
    delayed: 128,
    completed: 128,
    failed: 128,
    oldestRetainedAgeSeconds: 172800,
    workerConnected: 1,
    degraded: 1,
  }
  if (Object.keys(value).length !== Object.keys(limits).length)
    throw new Error('Invalid queue snapshot')
  return (Object.keys(limits) as (keyof QueueSnapshot)[])
    .map((key) => {
      const count = value[key]
      if (!Number.isSafeInteger(count) || count < 0 || count > limits[key])
        throw new Error('Invalid queue snapshot')
      const name = QUEUE_METRIC_NAMES[key]
      return `# TYPE ${name} gauge\n${name}{queue="loremaster-warm-v1",version="1"} ${count}\n`
    })
    .join('')
}
