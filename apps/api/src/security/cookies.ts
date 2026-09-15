import type { CookieConfiguration } from '@loremaster/config'
import type { Request, Response } from 'express'

export interface IssuedSessionCookies {
  readonly authenticationToken: string
  readonly csrfToken: string
  readonly expiresAt: Date
}

const EXPIRED_COOKIE_DATE = new Date(0)
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

function serializeCookie(
  cookie: CookieConfiguration,
  value: string,
  expiresAt: Date,
  clear: boolean,
): string {
  const attributes = [
    `${cookie.name}=${value}`,
    `Path=${cookie.path}`,
    `Expires=${expiresAt.toUTCString()}`,
  ]
  if (clear) attributes.push('Max-Age=0')
  if (cookie.httpOnly) attributes.push('HttpOnly')
  if (cookie.secure) attributes.push('Secure')
  attributes.push('SameSite=Lax')
  return attributes.join('; ')
}

/** `null` means the named cookie was repeated and must be rejected. */
export function readUniqueCookie(
  request: Request,
  name: string,
): string | undefined | null {
  const header = request.headers.cookie
  if (header === undefined) return undefined

  let value: string | undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    if (value !== undefined) return null
    value = part.slice(separator + 1).trim()
  }
  return value
}

export function issueSessionCookies(
  response: Response,
  cookies: {
    readonly csrf: CookieConfiguration
    readonly session: CookieConfiguration
  },
  values: IssuedSessionCookies,
): void {
  if (
    !TOKEN_PATTERN.test(values.authenticationToken) ||
    !TOKEN_PATTERN.test(values.csrfToken) ||
    !Number.isFinite(values.expiresAt.getTime())
  ) {
    throw new TypeError('Invalid session cookie values')
  }
  response.append(
    'Set-Cookie',
    serializeCookie(
      cookies.session,
      values.authenticationToken,
      values.expiresAt,
      false,
    ),
  )
  response.append(
    'Set-Cookie',
    serializeCookie(cookies.csrf, values.csrfToken, values.expiresAt, false),
  )
}

export function clearSessionCookies(
  response: Response,
  cookies: {
    readonly csrf: CookieConfiguration
    readonly session: CookieConfiguration
  },
): void {
  response.append(
    'Set-Cookie',
    serializeCookie(cookies.session, '', EXPIRED_COOKIE_DATE, true),
  )
  response.append(
    'Set-Cookie',
    serializeCookie(cookies.csrf, '', EXPIRED_COOKIE_DATE, true),
  )
}
