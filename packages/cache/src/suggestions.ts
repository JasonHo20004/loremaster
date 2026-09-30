import { Buffer } from 'node:buffer'

export const SUGGESTION_CACHE_TTL_SECONDS = 172_800
export const SUGGESTION_CACHE_MAX_BYTES = 524_288
export const SUGGESTION_CACHE_MAX_ENTITIES = 1_000
export const SUGGESTION_CACHE_MAX_ALIASES = 32

export interface SuggestionIndexEntity {
  readonly entityId: string
  readonly canonicalName: string
  readonly publicRole: string
  readonly aliases: readonly string[]
  readonly searchName: string
  readonly searchRole: string
  readonly searchAliases: readonly string[]
  readonly sortRank: number
}
export interface SuggestionIndex {
  readonly version: 1
  readonly revisionId: string
  readonly entities: readonly SuggestionIndexEntity[]
}
/** Implementations must fail open and may never execute within a DB transaction. */
export interface SuggestionCacheReader {
  get(
    revisionId: string,
    signal?: AbortSignal,
  ): Promise<SuggestionIndex | undefined>
}
/** Worker-only port. Atomic replacement with the mandatory fixed TTL. */
export interface SuggestionCacheWriter {
  set(index: SuggestionIndex, signal?: AbortSignal): Promise<void>
}
export type CacheFailureCode =
  | 'miss'
  | 'corrupt'
  | 'timeout'
  | 'unavailable'
  | 'acl_denied'
  | 'capacity'
  | 'cancelled'
export interface CacheAdapterPolicy {
  readonly assertOutsideTransaction: () => void
  readonly onEvent?: (code: CacheFailureCode) => void
}

export class InvalidSuggestionIndexError extends Error {
  readonly code = 'INVALID_SUGGESTION_INDEX'
  constructor() {
    super('Invalid suggestion index')
    this.name = 'InvalidSuggestionIndexError'
  }
}
function invalid(): never {
  throw new InvalidSuggestionIndexError()
}
export function suggestionCacheKey(revisionId: string): string {
  if (
    typeof revisionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      revisionId,
    )
  )
    invalid()
  return `loremaster:v1:revision:${revisionId}:suggestions`
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid()
  const item = value as Record<string, unknown>
  const prototype: unknown = Object.getPrototypeOf(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(item).length !== keys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      return (
        descriptor === undefined ||
        !('value' in descriptor) ||
        !descriptor.enumerable
      )
    })
  )
    invalid()
  return item
}
function string(value: unknown, max = 512): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
    invalid()
  return value
}
function denseArray(value: unknown, maximumLength: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength
  )
    invalid()
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid()
  const result: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    )
      invalid()
    result.push(descriptor.value)
  }
  return result
}
function aliases(value: unknown): readonly string[] {
  return Object.freeze(
    denseArray(value, SUGGESTION_CACHE_MAX_ALIASES).map((item) => string(item)),
  )
}
function validate(value: unknown): SuggestionIndex {
  const envelope = record(value, ['version', 'revisionId', 'entities'])
  if (envelope.version !== 1) invalid()
  const revisionId = string(envelope.revisionId, 36)
  suggestionCacheKey(revisionId)
  const entityValues = denseArray(
    envelope.entities,
    SUGGESTION_CACHE_MAX_ENTITIES,
  )
  const ids = new Set<string>()
  const ranks = new Set<number>()
  const entities = entityValues.map((value) => {
    const entity = record(value, [
      'entityId',
      'canonicalName',
      'publicRole',
      'aliases',
      'searchName',
      'searchRole',
      'searchAliases',
      'sortRank',
    ])
    const entityId = string(entity.entityId, 128)
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(entityId) || ids.has(entityId))
      invalid()
    ids.add(entityId)
    const sortRank = entity.sortRank
    if (
      typeof sortRank !== 'number' ||
      !Number.isInteger(sortRank) ||
      sortRank < 0 ||
      sortRank >= SUGGESTION_CACHE_MAX_ENTITIES ||
      ranks.has(sortRank)
    )
      invalid()
    ranks.add(sortRank)
    const names = aliases(entity.aliases)
    const searchAliases = aliases(entity.searchAliases)
    if (names.length !== searchAliases.length) invalid()
    return Object.freeze({
      entityId,
      canonicalName: string(entity.canonicalName),
      publicRole: string(entity.publicRole),
      aliases: names,
      searchName: string(entity.searchName),
      searchRole: string(entity.searchRole),
      searchAliases,
      sortRank,
    })
  })
  entities.sort((a, b) => a.sortRank - b.sortRank)
  return Object.freeze({
    version: 1,
    revisionId,
    entities: Object.freeze(entities),
  })
}
export function parseSuggestionIndex(raw: unknown): SuggestionIndex {
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') > SUGGESTION_CACHE_MAX_BYTES
  )
    invalid()
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    invalid()
  }
  return validate(value)
}
export function serializeSuggestionIndex(index: SuggestionIndex): string {
  const raw = JSON.stringify(validate(index))
  if (Buffer.byteLength(raw, 'utf8') > SUGGESTION_CACHE_MAX_BYTES) invalid()
  return raw
}
