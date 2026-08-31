import { AddressInfo } from "node:net"
import { Server } from "node:http"
import cors from "cors"
import express from "express"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildCorsOptions, EXPOSED_HEADERS, parseOrigins } from "../src/config/cors"

/**
 * The frontend is a browser app on another origin, so these options are part of
 * its contract: get `exposedHeaders` wrong and `X-Cache` is invisible to it no
 * matter what the server sends.
 */

describe("parseOrigins", () => {
  it("splits a comma-separated list and trims each entry", () => {
    expect(parseOrigins("http://localhost:3000, https://app.example.com")).toEqual([
      "http://localhost:3000",
      "https://app.example.com",
    ])
  })

  it("drops blank entries from a trailing comma or a doubled separator", () => {
    expect(parseOrigins("http://a.test,,http://b.test, ")).toEqual([
      "http://a.test",
      "http://b.test",
    ])
  })
})

describe("buildCorsOptions", () => {
  it.each(["*", "", "   ", "http://a.test,*"])("allows any origin for %o", (raw) => {
    expect(buildCorsOptions(raw).origin).toBe(true)
  })

  it("restricts to exactly the configured origins", () => {
    expect(buildCorsOptions("https://app.example.com,http://localhost:3000").origin).toEqual([
      "https://app.example.com",
      "http://localhost:3000",
    ])
  })

  it("exposes X-Cache, so browser JS can actually read the cache flag", () => {
    expect(buildCorsOptions("*").exposedHeaders).toContain("X-Cache")
  })

  it("exposes Retry-After and X-Request-Id alongside it", () => {
    const exposed = buildCorsOptions("*").exposedHeaders
    expect(exposed).toContain("Retry-After")
    expect(exposed).toContain("X-Request-Id")
    expect(exposed).toEqual([...EXPOSED_HEADERS])
  })

  it("allows the Authorization header through a preflight", () => {
    expect(buildCorsOptions("*").allowedHeaders).toContain("Authorization")
  })

  it("keeps credentialed CORS off — the API key is an explicit header, not a cookie", () => {
    expect(buildCorsOptions("*").credentials).toBe(false)
  })
})

/**
 * The options object being right is not the same as the headers being right, and
 * only the headers are what the frontend sees. This mounts the middleware the way
 * src/index.ts does and reads what actually comes back off the wire.
 */
describe("on the wire, with an allowlist configured", () => {
  const ALLOWED = "http://localhost:3000"
  let server: Server
  let base: string

  beforeAll(async () => {
    const app = express()
    app.use(cors(buildCorsOptions(`${ALLOWED},https://app.example.com`)))
    app.post("/profile", (_req, res) => {
      res.setHeader("X-Cache", "HIT")
      res.json({ name: "Jane Doe" })
    })
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const preflight = (origin: string) =>
    fetch(`${base}/profile`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    })

  it("answers a preflight from an allowed origin and permits Authorization", async () => {
    const res = await preflight(ALLOWED)

    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED)
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization")
    expect(res.headers.get("access-control-allow-methods")).toContain("POST")
  })

  it("advertises X-Cache as readable, which is the whole reason the header exists", async () => {
    const res = await preflight(ALLOWED)

    expect(res.headers.get("access-control-expose-headers")).toContain("X-Cache")
  })

  it("sends the expose list on the real response too, not just the preflight", async () => {
    const res = await fetch(`${base}/profile`, { method: "POST", headers: { origin: ALLOWED } })

    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED)
    expect(res.headers.get("access-control-expose-headers")).toContain("X-Cache")
    expect(res.headers.get("x-cache")).toBe("HIT")
  })

  it("withholds the allow-origin header from an origin that is not on the list", async () => {
    const res = await fetch(`${base}/profile`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })

    // No header is what makes a browser refuse the response; the server does not
    // pretend the request was malformed.
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("on the wire, with the permissive default", () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    const app = express()
    app.use(cors(buildCorsOptions("*")))
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" })
    })
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it("reflects whatever origin asked", async () => {
    const res = await fetch(`${base}/health`, { headers: { origin: "http://localhost:5173" } })

    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
  })
})
