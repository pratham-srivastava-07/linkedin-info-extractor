import { AddressInfo } from "node:net"
import { Server } from "node:http"
import express from "express"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ProfileController } from "../src/controllers/profile"
import { ExtractionResult, ProfileService } from "../src/services/profile"
import { requireApiKey } from "../src/middlewares/apiKey"
import { globalErrorHandler, notFoundHandler } from "../src/utils/error"
import {
  invalidUrl,
  rateLimited,
  SchemaMismatchError,
  sessionUnavailable,
} from "../src/utils/AppError"
import { Profile } from "../src/interfaces/profile"

/**
 * Exercises the HTTP layer over a real Express 5 server with the service stubbed
 * out, so the request/response contract in docs/api.md is asserted end to end
 * without a database or an upstream call. The wiring mirrors src/index.ts.
 */

const API_KEY = "test-api-key"

const profile: Profile = {
  profileUrl: "https://www.linkedin.com/in/jane-doe/",
  name: "Jane Doe",
  headline: "Senior Software Engineer at Example Co.",
  location: "Bengaluru, Karnataka, India",
  about: null,
  experience: [],
  education: [],
  skills: ["TypeScript"],
  certifications: [],
  languages: [],
  profileImageUrl: null,
  fetchedAt: "2026-08-30T10:00:00.000Z",
}

const extract = vi.fn<(url: string) => Promise<ExtractionResult>>()
const service = { extract } as unknown as ProfileService

const app = express()
app.disable("x-powered-by")
app.use(express.json({ limit: "16kb" }))
app.post("/profile", requireApiKey, new ProfileController(service).extract)
app.use(notFoundHandler)
app.use(globalErrorHandler)

let server: Server
let base: string

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => extract.mockReset())

const post = (body?: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/profile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      ...headers,
    },
    body,
  })

describe("POST /profile — success", () => {
  it("returns the bare Profile object with X-Cache: MISS", async () => {
    extract.mockResolvedValueOnce({ profile, cacheHit: false })
    const res = await post(JSON.stringify({ url: profile.profileUrl }))

    expect(res.status).toBe(200)
    // The header is only on the wire if it was set before the body was flushed,
    // so this is the assertion that res.status(200).setHeader(...) chaining works
    // under Express 5.
    expect(res.headers.get("x-cache")).toBe("MISS")
    // api.md publishes the Profile as the whole body — no envelope, no extra keys.
    expect(await res.json()).toEqual(profile)
  })

  it("flags a cache hit with X-Cache: HIT", async () => {
    extract.mockResolvedValueOnce({ profile, cacheHit: true })
    const res = await post(JSON.stringify({ url: profile.profileUrl }))

    expect(res.status).toBe(200)
    expect(res.headers.get("x-cache")).toBe("HIT")
  })
})

describe("POST /profile — auth", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong key", { authorization: "Bearer nope" }],
    ["the right key under the wrong scheme", { authorization: `Basic ${API_KEY}` }],
  ])("rejects %s with 401 unauthorized", async (_label, headers) => {
    const res = await fetch(`${base}/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ url: profile.profileUrl }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
    // Auth is checked before anything reaches the service.
    expect(extract).not.toHaveBeenCalled()
  })
})

describe("POST /profile — bad input", () => {
  it("maps a malformed JSON body to 400 invalid_url, not a 500", async () => {
    const res = await post('{"url":')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "invalid_url",
      message: "request body must be valid JSON",
    })
  })

  it("maps an oversized body to 400 invalid_url", async () => {
    const res = await post(JSON.stringify({ url: "x".repeat(20_000) }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "invalid_url",
      message: "request body is too large",
    })
  })

  it.each([
    ["a missing url field", "{}"],
    ["an absent body", undefined],
  ])("reports %s as invalid_url with a contract message", async (_label, body) => {
    const res = await post(body)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid_url", message: "url is required" })
  })

  it("passes the validator's own message through for a non-profile URL", async () => {
    extract.mockRejectedValueOnce(invalidUrl())
    const res = await post(JSON.stringify({ url: "https://example.com/in/jane-doe" }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "invalid_url",
      message: "url must be a valid LinkedIn profile URL",
    })
  })
})

describe("POST /profile — failures reach the caller as documented codes", () => {
  it("sets Retry-After alongside retryAfterSeconds on a 429", async () => {
    extract.mockRejectedValueOnce(rateLimited(45))
    const res = await post(JSON.stringify({ url: profile.profileUrl }))

    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("45")
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 45 })
  })

  it("returns 502 upstream_schema_mismatch without putting the raw payload on the wire", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    extract.mockRejectedValueOnce(new SchemaMismatchError("profile object gone", { drift: 1 }))
    const res = await post(JSON.stringify({ url: profile.profileUrl }))

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "upstream_schema_mismatch" })
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it("returns a bare 503 session_unavailable, with no cause detail in the body", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    extract.mockRejectedValueOnce(sessionUnavailable(new Error("li_at=AQEDAsecret was rejected")))
    const res = await post(JSON.stringify({ url: profile.profileUrl }))

    expect(res.status).toBe(503)
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ error: "session_unavailable" })
    // The cookie value must never ride out on an error body.
    expect(body).not.toContain("AQEDAsecret")
    logged.mockRestore()
  })

  it("scrubs an unexpected error down to internal_error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    extract.mockRejectedValueOnce(new Error("connection string postgres://u:hunter2@db/x"))
    const res = await post(JSON.stringify({ url: profile.profileUrl }))

    expect(res.status).toBe(500)
    const body = await res.text()
    expect(JSON.parse(body)).toMatchObject({ error: "internal_error" })
    expect(body).not.toContain("hunter2")
    logged.mockRestore()
  })
})

describe("unknown endpoints", () => {
  it.each(["/nope", "/profile/extra"])("answers %s with a documented 404", async (path) => {
    const res = await fetch(`${base}${path}`)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: "profile_not_found",
      message: "Unknown endpoint",
    })
  })
})
