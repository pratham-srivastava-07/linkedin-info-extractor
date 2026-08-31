import { rateLimited } from "./AppError"

/**
 * Serializes extractions: one outbound request against the single authenticated
 * session at a time (docs/api.md § Rate limits). This is what BullMQ was there for
 * in the original design — with one process and one session, an in-process queue
 * does the same job without a second piece of infrastructure.
 *
 * The depth cap matters: without it, a burst of callers would all sit waiting and
 * time out with no signal. Past the cap we say `rate_limited` immediately.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private depth = 0

  constructor(private readonly maxDepth = 20) {}

  get pending(): number {
    return this.depth
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.depth >= this.maxDepth) return Promise.reject(rateLimited())
    this.depth += 1
    const result = this.tail.then(task, task)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result.finally(() => {
      this.depth -= 1
    })
  }
}
