import type { ApiClient, ApiClientResponse } from '../api/client.js'
import { ApiClientError } from '../api/errors.js'
import { LatestRead } from '../state/latest-read.js'

export type Profile = ApiClientResponse<'getProfile'>['data']
export type LeaderboardEntry =
  ApiClientResponse<'getLeaderboard'>['data']['items'][number]

export type ReadStatus = 'IDLE' | 'LOADING' | 'READY' | 'ERROR'
export type LeaderboardStatus = ReadStatus | 'APPENDING'

export interface ReportingState {
  readonly profile?: Profile
  readonly profileError?: ApiClientError
  readonly profileStatus: ReadStatus
  readonly leaderboardEntries: readonly LeaderboardEntry[]
  readonly leaderboardError?: ApiClientError
  readonly leaderboardNextCursor?: string | null
  readonly leaderboardSlotId?: string
  readonly leaderboardStatus: LeaderboardStatus
}

type Listener = (state: ReportingState) => void

function safeReadError(error: unknown): ApiClientError {
  return error instanceof ApiClientError
    ? error
    : new ApiClientError('NETWORK_ERROR')
}

export class ReportingController {
  readonly #client: ApiClient
  readonly #listeners = new Set<Listener>()
  readonly #profileRead: LatestRead<ApiClientResponse<'getProfile'>>
  #leaderboardAbort?: AbortController
  #leaderboardGeneration = 0
  #leaderboardRequestKey?: string
  #leaderboardRequest?: Promise<void>
  #state: ReportingState = {
    profileStatus: 'IDLE',
    leaderboardEntries: [],
    leaderboardStatus: 'IDLE',
  }

  constructor(client: ApiClient) {
    this.#client = client
    this.#profileRead = new LatestRead((signal) =>
      client.requestReadWithRetry('getProfile', { signal }),
    )
  }

  get state(): ReportingState {
    return this.#state
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    this.#profileRead.cancel()
    this.#cancelLeaderboard()
    this.#listeners.clear()
  }

  reset(): void {
    this.#profileRead.cancel()
    this.#cancelLeaderboard()
    this.#setState({
      profile: undefined,
      profileError: undefined,
      profileStatus: 'IDLE',
      leaderboardEntries: [],
      leaderboardError: undefined,
      leaderboardNextCursor: undefined,
      leaderboardSlotId: undefined,
      leaderboardStatus: 'IDLE',
    })
  }

  async refreshProfile(replace = false): Promise<void> {
    if (!replace && this.#state.profileStatus === 'READY') return
    this.#setState({ profileStatus: 'LOADING', profileError: undefined })
    try {
      const result = await this.#profileRead.run(replace)
      if (!result.accepted) return
      this.#setState({
        profile: result.value.data,
        profileStatus: 'READY',
        profileError: undefined,
      })
    } catch (error) {
      this.#setState({
        profileStatus: 'ERROR',
        profileError: safeReadError(error),
      })
    }
  }

  selectLeaderboardSlot(slotId: string): Promise<void> {
    if (
      this.#state.leaderboardSlotId === slotId &&
      this.#state.leaderboardStatus !== 'IDLE'
    ) {
      return Promise.resolve()
    }
    return this.#loadLeaderboard(slotId, undefined, true)
  }

  refreshLeaderboard(): Promise<void> {
    const slotId = this.#state.leaderboardSlotId
    if (slotId === undefined) return Promise.resolve()
    return this.#loadLeaderboard(slotId, undefined, true)
  }

  loadMoreLeaderboard(): Promise<void> {
    const { leaderboardNextCursor: cursor, leaderboardSlotId: slotId } =
      this.#state
    if (slotId === undefined || cursor == null) return Promise.resolve()
    return this.#loadLeaderboard(slotId, cursor, false)
  }

  refreshAfterTerminal(slotId: string): void {
    void this.refreshProfile(true)
    void this.#loadLeaderboard(slotId, undefined, true)
  }

  #loadLeaderboard(
    slotId: string,
    cursor: string | undefined,
    replace: boolean,
  ): Promise<void> {
    const requestKey = `${slotId}\n${cursor ?? ''}`
    if (
      this.#leaderboardRequestKey === requestKey &&
      this.#leaderboardRequest !== undefined
    ) {
      return this.#leaderboardRequest
    }

    if (replace) this.#leaderboardAbort?.abort()
    const generation = replace
      ? ++this.#leaderboardGeneration
      : this.#leaderboardGeneration
    const abort = new AbortController()
    this.#leaderboardAbort = abort
    this.#leaderboardRequestKey = requestKey
    this.#setState({
      leaderboardSlotId: slotId,
      leaderboardStatus: cursor === undefined ? 'LOADING' : 'APPENDING',
      leaderboardError: undefined,
      ...(replace
        ? { leaderboardEntries: [], leaderboardNextCursor: undefined }
        : {}),
    })

    const request = this.#client
      .requestReadWithRetry('getLeaderboard', {
        path: { slotId },
        query: { limit: '25', ...(cursor === undefined ? {} : { cursor }) },
        signal: abort.signal,
      })
      .then((response) => {
        if (abort.signal.aborted || generation !== this.#leaderboardGeneration)
          return
        this.#setState({
          leaderboardEntries:
            cursor === undefined
              ? response.data.items
              : [...this.#state.leaderboardEntries, ...response.data.items],
          leaderboardNextCursor: response.data.nextCursor,
          leaderboardStatus: 'READY',
          leaderboardError: undefined,
        })
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || generation !== this.#leaderboardGeneration)
          return
        this.#setState({
          leaderboardStatus: 'ERROR',
          leaderboardError: safeReadError(error),
        })
      })
      .finally(() => {
        if (this.#leaderboardRequest === request) {
          this.#leaderboardRequest = undefined
          this.#leaderboardRequestKey = undefined
        }
      })
    this.#leaderboardRequest = request
    return request
  }

  #cancelLeaderboard(): void {
    this.#leaderboardGeneration += 1
    this.#leaderboardAbort?.abort()
    this.#leaderboardAbort = undefined
    this.#leaderboardRequest = undefined
    this.#leaderboardRequestKey = undefined
  }

  #setState(patch: Partial<ReportingState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener(this.#state)
  }
}
