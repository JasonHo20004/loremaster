import { COOKIE_POLICIES, csrfTokenSchema } from '@loremaster/contracts'

import { ApiClientError } from './errors.js'

export type CookieSource = () => string

export function csrfCookieName(apiBaseUrl: URL): string {
  return apiBaseUrl.protocol === 'https:'
    ? COOKIE_POLICIES.production.csrf.name
    : COOKIE_POLICIES.local.csrf.name
}

export function readCsrfToken(
  apiBaseUrl: URL,
  cookieSource: CookieSource,
): string {
  const expectedName = csrfCookieName(apiBaseUrl)
  const matchingValues = cookieSource()
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${expectedName}=`))
    .map((part) => part.slice(expectedName.length + 1))

  if (matchingValues.length !== 1) {
    throw new ApiClientError('SESSION_SECURITY')
  }
  const parsed = csrfTokenSchema.safeParse(matchingValues[0])
  if (!parsed.success) throw new ApiClientError('SESSION_SECURITY')
  return parsed.data
}
