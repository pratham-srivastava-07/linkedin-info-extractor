import { AddressInfo } from "node:net"
import { Server } from "node:http"
import express from "express"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { requestLogger } from "../src/middlewares/requestLogger"

/**
 * Driven over a real server, because the interesting parts are timing and the
 * response lifecycle — the status is only known once the response has been sent,
 * which is after the middleware itself has returned.
 *
 * The load-bearing assertions are the negative ones: the API key and the upstream
 * cookies both arrive as headers, and no header may ever reach a log line.
 */

const lines: string[] = []

const app = express()
app.use(requestLogger({ log: (line) => lines.push(line) }))
app.use(express.json())
app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})
app.post("/profile", (_req, res) => {
  res.status(201).json({ ok: true })
})
app.get("/boom", (_req, res) => {
  res.status(503).json({ error: "session_unavailable" })
})

let server: Server
let base: string

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  lines.length = 0
})

describe("requestLogger", () => {
  it("logs one line with id, method, path, status and duration", async () => {
    await fetch(`${base}/health`)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[http] \S+ GET \/health 200 \d+ms$/)
  })

  it("logs one line per request, not one per middleware", async () => {
    await fetch(`${base}/health`)
    await fetch(`${base}/health`)

    expect(lines).toHaveLength(2)
  })

  it("reports the status the handler actually sent", async () => {
    await fetch(`${base}/boom`)

    expect(lines[0]).toContain(" 503 ")
  })

  it("never puts the Authorization header — or any header — in the line", async () => {
    await fetch(`${base}/profile`, {
      method: "POST",
      headers: {
        authorization: "Bearer super-secret-api-key",
        cookie: 'li_at=AQEDAsecretcookie; JSESSIONID="ajax:1234"',
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://www.linkedin.com/in/jane-doe/" }),
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("super-secret-api-key")
    expect(lines[0]).not.toContain("AQEDAsecretcookie")
    expect(lines[0]).not.toContain("Bearer")
    expect(lines[0]).not.toContain("ajax:")
  })

  it("strips the query string, so a key smuggled into one is not persisted", async () => {
    await fetch(`${base}/health?api_key=leaked-in-a-query-string&debug=1`)

    expect(lines[0]).toContain(" GET /health ")
    expect(lines[0]).not.toContain("leaked-in-a-query-string")
    expect(lines[0]).not.toContain("?")
  })

  it("echoes a request id back on X-Request-Id so a caller can quote it", async () => {
    const res = await fetch(`${base}/health`)
    const id = res.headers.get("x-request-id")

    expect(id).toBeTruthy()
    expect(lines[0]).toContain(id as string)
  })

  it("adopts a caller-supplied X-Request-Id for cross-service correlation", async () => {
    const res = await fetch(`${base}/health`, { headers: { "x-request-id": "trace-abc-123" } })

    expect(res.headers.get("x-request-id")).toBe("trace-abc-123")
    expect(lines[0]).toContain("trace-abc-123")
  })

  it("ignores a hostile X-Request-Id rather than echoing it into the log", async () => {
    const res = await fetch(`${base}/health`, {
      headers: { "x-request-id": "not a valid id with spaces" },
    })

    expect(res.headers.get("x-request-id")).not.toBe("not a valid id with spaces")
    expect(lines[0]).not.toContain("not a valid id")
  })

  it("gives each request a distinct id", async () => {
    await fetch(`${base}/health`)
    await fetch(`${base}/health`)

    expect(lines[0].split(" ")[1]).not.toBe(lines[1].split(" ")[1])
  })
})
