export interface LatestReadResult<Value> {
  readonly accepted: boolean
  readonly value: Value
}

interface InFlightRead<Value> {
  readonly abortController: AbortController
  readonly generation: number
  readonly promise: Promise<LatestReadResult<Value>>
}

export class LatestRead<Value> {
  readonly #load: (signal: AbortSignal) => Promise<Value>
  #generation = 0
  #inFlight?: InFlightRead<Value>

  constructor(load: (signal: AbortSignal) => Promise<Value>) {
    this.#load = load
  }

  cancel(): void {
    this.#generation += 1
    this.#inFlight?.abortController.abort()
    this.#inFlight = undefined
  }

  run(replace = false): Promise<LatestReadResult<Value>> {
    if (!replace && this.#inFlight !== undefined) return this.#inFlight.promise
    if (replace) this.#inFlight?.abortController.abort()

    const generation = ++this.#generation
    const abortController = new AbortController()
    const promise = this.#load(abortController.signal)
      .then((value) => ({
        value,
        accepted:
          generation === this.#generation && !abortController.signal.aborted,
      }))
      .finally(() => {
        if (this.#inFlight?.generation === generation) {
          this.#inFlight = undefined
        }
      })
    this.#inFlight = { abortController, generation, promise }
    return promise
  }
}
