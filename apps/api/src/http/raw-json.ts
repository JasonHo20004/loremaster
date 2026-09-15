import { TextDecoder } from 'node:util'

import type { Request } from 'express'

import { PublicHttpError } from './errors.js'

export const MAXIMUM_JSON_BODY_BYTES = 16 * 1_024

class JsonScanner {
  readonly #source: string
  #offset = 0

  constructor(source: string) {
    this.#source = source
  }

  scan(): void {
    this.#skipWhitespace()
    this.#value('$')
    this.#skipWhitespace()
    if (this.#offset !== this.#source.length) throw new SyntaxError()
  }

  #value(path: string): void {
    this.#skipWhitespace()
    const character = this.#source[this.#offset]
    if (character === '{') return this.#object(path)
    if (character === '[') return this.#array(path)
    if (character === '"') {
      this.#string()
      return
    }
    if (character === 't') return this.#literal('true')
    if (character === 'f') return this.#literal('false')
    if (character === 'n') return this.#literal('null')
    this.#number()
  }

  #object(path: string): void {
    this.#offset += 1
    this.#skipWhitespace()
    const keys = new Set<string>()
    if (this.#source[this.#offset] === '}') {
      this.#offset += 1
      return
    }
    while (true) {
      if (this.#source[this.#offset] !== '"') throw new SyntaxError()
      const key = this.#string()
      const keyPath = /^[A-Za-z][A-Za-z0-9]*$/u.test(key)
        ? `${path}.${key}`
        : path
      if (keys.has(key)) {
        throw new PublicHttpError('INVALID_REQUEST', [
          { path: keyPath, code: 'DUPLICATE_FIELD' },
        ])
      }
      keys.add(key)
      this.#skipWhitespace()
      if (this.#source[this.#offset] !== ':') throw new SyntaxError()
      this.#offset += 1
      this.#value(keyPath)
      this.#skipWhitespace()
      const delimiter = this.#source[this.#offset]
      this.#offset += 1
      if (delimiter === '}') return
      if (delimiter !== ',') throw new SyntaxError()
      this.#skipWhitespace()
    }
  }

  #array(path: string): void {
    this.#offset += 1
    this.#skipWhitespace()
    if (this.#source[this.#offset] === ']') {
      this.#offset += 1
      return
    }
    let index = 0
    while (true) {
      this.#value(`${path}[${index}]`)
      index += 1
      this.#skipWhitespace()
      const delimiter = this.#source[this.#offset]
      this.#offset += 1
      if (delimiter === ']') return
      if (delimiter !== ',') throw new SyntaxError()
      this.#skipWhitespace()
    }
  }

  #string(): string {
    const start = this.#offset
    this.#offset += 1
    while (this.#offset < this.#source.length) {
      const character = this.#source[this.#offset]
      if (character === '"') {
        this.#offset += 1
        return JSON.parse(this.#source.slice(start, this.#offset)) as string
      }
      if (character === '\\') {
        this.#offset += 2
      } else {
        this.#offset += 1
      }
    }
    throw new SyntaxError()
  }

  #literal(literal: string): void {
    if (
      this.#source.slice(this.#offset, this.#offset + literal.length) !==
      literal
    ) {
      throw new SyntaxError()
    }
    this.#offset += literal.length
  }

  #number(): void {
    const match = this.#source
      .slice(this.#offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)
    if (match === null) throw new SyntaxError()
    this.#offset += match[0].length
  }

  #skipWhitespace(): void {
    while (/^[\t\n\r ]$/u.test(this.#source[this.#offset] ?? '')) {
      this.#offset += 1
    }
  }
}

async function readBoundedBody(request: Request): Promise<Buffer> {
  const declaredLength = request.headers['content-length']
  if (
    declaredLength !== undefined &&
    /^(0|[1-9][0-9]*)$/u.test(declaredLength) &&
    Number(declaredLength) > MAXIMUM_JSON_BODY_BYTES
  ) {
    request.resume()
    throw new PublicHttpError('BODY_TOO_LARGE')
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let finished = false
    const fail = (error: unknown): void => {
      if (finished) return
      finished = true
      reject(error)
    }
    request.on('data', (chunk: Buffer | string) => {
      if (finished) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > MAXIMUM_JSON_BODY_BYTES) {
        request.resume()
        fail(new PublicHttpError('BODY_TOO_LARGE'))
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      if (finished) return
      finished = true
      resolve(Buffer.concat(chunks, total))
    })
    request.on('aborted', () => fail(new PublicHttpError('INVALID_REQUEST')))
    request.on('error', () => fail(new PublicHttpError('INVALID_REQUEST')))
  })
}

export async function parseBoundedJsonBody(request: Request): Promise<unknown> {
  const raw = await readBoundedBody(request)
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    new JsonScanner(source).scan()
    return JSON.parse(source) as unknown
  } catch (error) {
    if (error instanceof PublicHttpError) throw error
    throw new PublicHttpError('INVALID_REQUEST', [
      { path: '$', code: 'INVALID_FORMAT' },
    ])
  }
}
