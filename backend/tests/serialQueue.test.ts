import { describe, expect, it } from "vitest"
import { SerialQueue } from "../src/utils/serialQueue"
import { AppError } from "../src/utils/AppError"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("SerialQueue", () => {
  it("runs tasks one at a time, in order", async () => {
    const queue = new SerialQueue()
    const order: string[] = []
    const running: number[] = []
    let concurrent = 0

    const task = (label: string) => async () => {
      concurrent += 1
      running.push(concurrent)
      await settle()
      order.push(label)
      concurrent -= 1
    }

    await Promise.all([queue.run(task("a")), queue.run(task("b")), queue.run(task("c"))])

    expect(order).toEqual(["a", "b", "c"])
    expect(Math.max(...running)).toBe(1)
  })

  it("releases its slot when a task succeeds", async () => {
    const queue = new SerialQueue()
    const gate = deferred<string>()
    const run = queue.run(() => gate.promise)

    expect(queue.pending).toBe(1)
    gate.resolve("done")
    await expect(run).resolves.toBe("done")
    expect(queue.pending).toBe(0)
  })

  it("releases its slot when a task throws — a rejection must not leak depth", async () => {
    const queue = new SerialQueue()
    const gate = deferred<string>()
    const run = queue.run(() => gate.promise)

    expect(queue.pending).toBe(1)
    gate.reject(new Error("upstream blew up"))
    await expect(run).rejects.toThrow("upstream blew up")
    expect(queue.pending).toBe(0)
  })

  it("keeps draining after a task rejects", async () => {
    const queue = new SerialQueue()
    const failing = queue.run(() => Promise.reject(new Error("first")))
    const following = queue.run(() => Promise.resolve("second"))

    await expect(failing).rejects.toThrow("first")
    await expect(following).resolves.toBe("second")
    expect(queue.pending).toBe(0)
  })

  it("rejects with rate_limited past the depth cap instead of queueing forever", async () => {
    const queue = new SerialQueue(2)
    const gate = deferred<void>()
    const held = [queue.run(() => gate.promise), queue.run(() => gate.promise)]

    expect(queue.pending).toBe(2)
    try {
      await queue.run(async () => undefined)
      expect.unreachable("should have been rejected at the cap")
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe("rate_limited")
      expect((err as AppError).statusCode).toBe(429)
      expect((err as AppError).meta).toEqual({ retryAfterSeconds: 30 })
    }

    // A caller turned away at the cap must not have consumed a slot.
    expect(queue.pending).toBe(2)
    gate.resolve()
    await Promise.all(held)
    expect(queue.pending).toBe(0)
  })

  it("accepts work again once the queue has drained", async () => {
    const queue = new SerialQueue(1)
    const gate = deferred<void>()
    const held = queue.run(() => gate.promise)

    await expect(queue.run(async () => "rejected at cap")).rejects.toBeInstanceOf(AppError)
    gate.resolve()
    await held

    await expect(queue.run(async () => "accepted")).resolves.toBe("accepted")
    expect(queue.pending).toBe(0)
  })
})
