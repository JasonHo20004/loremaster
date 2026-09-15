import { BlockList, isIP } from 'node:net'

import type { TrustedProxy } from '@loremaster/config'
import type { Request } from 'express'

import { PublicHttpError } from '../http/errors.js'

const MAXIMUM_FORWARDING_HOPS = 32

function mappedIpv4(address: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)?.[1]
  if (dotted !== undefined && isIP(dotted) === 4) return dotted
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(address)
  if (hexadecimal === null) return undefined
  const high = Number.parseInt(hexadecimal[1]!, 16)
  const low = Number.parseInt(hexadecimal[2]!, 16)
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.')
}

export function canonicalIpAddress(address: string): string | undefined {
  if (address.includes('%')) return undefined
  const mapped = mappedIpv4(address)
  if (mapped !== undefined) return mapped
  const version = isIP(address)
  if (version === 4) return address.split('.').map(Number).join('.')
  if (version !== 6) return undefined
  try {
    const hostname = new URL(`http://[${address}]/`).hostname
    return hostname.slice(1, -1)
  } catch {
    return undefined
  }
}

function rawHeaderCount(request: Request, name: string): number {
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1
  }
  return count
}

export interface SourceIpResolver {
  sourceIpFor(request: Request): string
}

export function createSourceIpResolver(
  trustedProxies: readonly TrustedProxy[],
): SourceIpResolver {
  const blockList = new BlockList()
  for (const proxy of trustedProxies) {
    blockList.addSubnet(
      proxy.address,
      proxy.prefixLength,
      proxy.version === 4 ? 'ipv4' : 'ipv6',
    )
  }

  const isTrusted = (address: string) =>
    blockList.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6')

  return {
    sourceIpFor(request) {
      const peer = canonicalIpAddress(request.socket.remoteAddress ?? '')
      if (peer === undefined) throw new PublicHttpError('REQUEST_FORBIDDEN')

      const forwarded = request.headers['x-forwarded-for']
      if (forwarded === undefined) return peer
      if (
        !isTrusted(peer) ||
        typeof forwarded !== 'string' ||
        rawHeaderCount(request, 'x-forwarded-for') !== 1
      ) {
        throw new PublicHttpError('REQUEST_FORBIDDEN')
      }

      const chain = forwarded.split(',')
      if (chain.length < 1 || chain.length > MAXIMUM_FORWARDING_HOPS) {
        throw new PublicHttpError('REQUEST_FORBIDDEN')
      }
      const addresses = chain.map((item) => canonicalIpAddress(item.trim()))
      if (addresses.some((address) => address === undefined)) {
        throw new PublicHttpError('REQUEST_FORBIDDEN')
      }

      let current = peer
      for (let index = addresses.length - 1; index >= 0; index -= 1) {
        if (!isTrusted(current)) return current
        current = addresses[index]!
      }
      return current
    },
  }
}
