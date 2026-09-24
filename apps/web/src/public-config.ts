export interface PublicConfiguration {
  readonly apiBaseUrl: URL
}

const API_PATH = '/api/v1'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function parseApiBaseUrl(raw: string, browserOrigin: string): URL {
  if (raw.length === 0 || raw.trim() !== raw || raw.includes('\\')) {
    throw new Error('VITE_API_BASE_URL is invalid')
  }

  let origin: URL
  let parsed: URL
  try {
    origin = new URL(browserOrigin)
    parsed = new URL(raw, origin)
  } catch {
    throw new Error('VITE_API_BASE_URL is invalid')
  }

  const isRelative = raw.startsWith('/')
  const exactValue = isRelative ? raw === API_PATH : raw === parsed.href
  const safeTransport =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))

  if (
    !exactValue ||
    !safeTransport ||
    parsed.pathname !== API_PATH ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('VITE_API_BASE_URL is invalid')
  }

  return parsed
}

export function readPublicConfiguration(
  environment: ImportMetaEnv = import.meta.env,
  browserOrigin = window.location.origin,
): PublicConfiguration {
  return {
    apiBaseUrl: parseApiBaseUrl(
      environment.VITE_API_BASE_URL ?? API_PATH,
      browserOrigin,
    ),
  }
}
