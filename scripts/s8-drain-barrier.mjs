export async function waitForBlockedRead({
  blocked,
  armed,
  signal,
  now,
  sleep,
  timeoutMs,
}) {
  const deadline = now() + timeoutMs
  armed()
  while (now() < deadline) {
    const waiting = await blocked()
    if (now() >= deadline) break
    if (waiting) {
      const signaledAt = now()
      signal()
      return signaledAt
    }
    await sleep(25)
  }
  throw Error('Blocked read barrier timed out')
}

export function drainWatcherScript() {
  return `
    import { readFileSync } from 'node:fs';
    import { createRequire } from 'node:module';
    import { setTimeout as sleep } from 'node:timers/promises';
    const waitForBlockedRead = ${waitForBlockedRead.toString()};
    const watchdog = setTimeout(() => process.exit(2), 35000);
    let client;
    try {
      const workerRequire = createRequire('/app/dist/index.js');
      const databaseRequire = createRequire(workerRequire.resolve('@loremaster/database/runtime'));
      const { Client } = databaseRequire('pg');
      client = new Client({
        connectionString: readFileSync(process.env.LOREMASTER_WORKER_DATABASE_URL_FILE, 'utf8').trim(),
        connectionTimeoutMillis: 3000,
        query_timeout: 1000,
        statement_timeout: 1000,
      });
      client.on('error', () => { console.log('ERROR'); process.exit(2); });
      await client.connect();
      const signaledAt = await waitForBlockedRead({
        armed: () => console.log('ARMED'),
        blocked: async () => {
          const result = await client.query(
            "SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class r ON r.oid=l.relation JOIN pg_namespace n ON n.oid=r.relnamespace JOIN pg_stat_activity a ON a.pid=l.pid WHERE n.nspname='loremaster' AND r.relname='case_entities' AND l.mode='AccessShareLock' AND NOT l.granted AND l.pid<>pg_backend_pid() AND a.usename=current_user AND a.state='active') AS blocked"
          );
          return result.rows[0].blocked === true;
        },
        signal: () => process.kill(1, 'SIGTERM'),
        now: Date.now,
        sleep,
        timeoutMs: 30000,
      });
      console.log('SIGNALED ' + signaledAt);
      await client.end();
      clearTimeout(watchdog);
    } catch {
      console.log('ERROR');
      process.exit(2);
    }
  `
}
