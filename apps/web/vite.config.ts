import process from 'node:process'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export function parseProxyTarget(raw: string | undefined): string {
  const candidate = raw ?? 'http://127.0.0.1:3000'
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('LOREMASTER_API_PROXY_TARGET must be a valid origin')
  }

  const isLocalHttp =
    parsed.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  const isExactOrigin =
    candidate === parsed.origin &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === ''

  if (!isLocalHttp || !isExactOrigin) {
    throw new Error(
      'LOREMASTER_API_PROXY_TARGET must be an exact loopback HTTP origin',
    )
  }
  return parsed.origin
}

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: parseProxyTarget(process.env.LOREMASTER_API_PROXY_TARGET),
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
})
