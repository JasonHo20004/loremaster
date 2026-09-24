import type { ApiClientResponse } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { ApiClientError } from '../api/errors.js'

export interface SessionBootstrapResult {
  readonly created: boolean
  readonly session: ApiClientResponse<'getSession'>
}

export class SessionBootstrap {
  readonly #client: ApiClient

  constructor(client: ApiClient) {
    this.#client = client
  }

  async initialize(signal?: AbortSignal): Promise<SessionBootstrapResult> {
    try {
      const session = await this.#client.requestReadWithRetry('getSession', {
        signal,
      })
      return { created: false, session }
    } catch (error) {
      if (
        !(error instanceof ApiClientError) ||
        error.kind !== 'API_ERROR' ||
        error.apiCode !== 'AUTHENTICATION_REQUIRED'
      ) {
        throw error
      }
      return this.createNewSession(signal)
    }
  }

  async createNewSession(
    signal?: AbortSignal,
  ): Promise<SessionBootstrapResult> {
    const session = await this.#client.request('createSession', {
      body: {},
      signal,
    })
    return { created: true, session }
  }
}
