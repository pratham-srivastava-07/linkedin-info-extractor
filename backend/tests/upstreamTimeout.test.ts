import { createServer, Server } from "node:http"
import { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { env } from "../src/config/env"
import { VoyagerClient } from "../src/linkedin/voyagerClient"
import { UpstreamUnavailableError } from "../src/linkedin/errors"

/**
 * `UPSTREAM_TIMEOUT_MS` is the only thing standing between a hung LinkedIn
 * connection and a request that never answers, so "it is passed to fetch" is not
 * enough to know. Two things have to hold, and they are checked separately:
 *
 *  1. the client really does derive its abort signal from the configured value;
 *  2. that signal really does cut off a connection that has already sent its
 *     headers and then stalls mid-body — the failure mode a connect timeout
 *     alone would miss.
 *
 * (2) is a property of the runtime's fetch rather than of our code, which is
 * exactly why it is worth pinning: the whole guarantee rests on it.
 */

const cookies = { liAt: "AQEDATEST", jsessionId: '"ajax:9876543210"' }
const client = new VoyagerClient()

describe("the abort signal is built from UPSTREAM_TIMEOUT_MS", () => {
  const configured = env.UPSTREAM_TIMEOUT_MS

  afterEach(() => {
    vi.unstubAllGlobals()
    env.UPSTREAM_TIMEOUT_MS = configured
  })

  /**
   * Real timers on purpose: `AbortSignal.timeout` is scheduled by the runtime,
   * not by the `setTimeout` that fake timers replace, so faking the clock would
   * assert nothing. The configured value is shortened instead.
   */
  const captureSignal = async (): Promise<AbortSignal> => {
    let signal: AbortSignal | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        signal = init?.signal ?? undefined
        return new Response("{}", { status: 200 })
      }),
    )
    await client.profile("jane-doe", cookies)
    if (!signal) throw new Error("the client sent no abort signal")
    return signal
  }

  it("does not abort a request that is still inside the deadline", async () => {
    env.UPSTREAM_TIMEOUT_MS = 10_000
    const signal = await captureSignal()

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(signal.aborted).toBe(false)
  })

  it("aborts once the configured deadline passes", async () => {
    env.UPSTREAM_TIMEOUT_MS = 100
    const signal = await captureSignal()

    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))

    expect(signal.aborted).toBe(true)
    expect((signal.reason as Error).name).toBe("TimeoutError")
  }, 5_000)
})

describe("a connection that stalls after its headers is still bounded", () => {
  let server: Server
  let url: string

  beforeAll(async () => {
    // Sends a 200 and the opening brace of a JSON body, then never writes again
    // and never closes: a fetch without a live signal would wait forever here.
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.write("{")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )

  it("aborts the body read instead of hanging", async () => {
    const startedAt = Date.now()
    const response = await fetch(url, { signal: AbortSignal.timeout(300) })

    // Headers arrived, so the request "succeeded" — the hang is in the body.
    expect(response.status).toBe(200)
    await expect(response.json()).rejects.toThrow()
    // Comfortably inside the test timeout: the point is that it returned at all.
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  }, 10_000)

  it("surfaces as UpstreamUnavailableError, not as a stuck request", async () => {
    // The same stall, seen through the client: a body that cannot be read is
    // reported in the documented vocabulary rather than left dangling.
    const hung = await fetch(url, { signal: AbortSignal.timeout(300) })
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(hung))

    await expect(client.profile("jane-doe", cookies)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    )
    vi.unstubAllGlobals()
  }, 10_000)
})
