/**
 * Answers one question: will LinkedIn accept these cookies right now?
 *
 *   npm run check:session
 *   npm run check:session -- --li-at=AQEDA... --jsessionid="ajax:123..."
 *
 * With no arguments it reads `LINKEDIN_COOKIE` from `.env` if it is set, and
 * otherwise `LINKEDIN_LI_AT` / `LINKEDIN_JSESSIONID`. Pass the flags explicitly
 * to vet a freshly copied pair *before* writing it to disk.
 *
 * It deliberately does not import `config/env`: this has to run when
 * DATABASE_URL and API_KEY are still unset, and it must not need the database or
 * the server to be up. It sends the same headers as the real client (shared via
 * `src/linkedin/headers.ts`), so a cookie that passes here cannot fail in the
 * service because of a header that drifted.
 *
 * Cookie values are never printed — only lengths, cookie names and a verdict.
 */
import dotenv from "dotenv"
import { SessionCookies, isRawCookieHeader, jsessionIdFrom } from "../src/linkedin/cookies"
import { VOYAGER_BASE, voyagerHeaders } from "../src/linkedin/headers"
import { diagnoseAuthFailure } from "../src/linkedin/revocation"

dotenv.config()

const TIMEOUT_MS = 15_000

const readFlag = (name: string): string | undefined => {
  const prefix = `--${name}=`
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return match?.slice(prefix.length)
}

const stripQuotes = (value: string): string => value.trim().replace(/^"|"$/g, "")

const resolveCookies = (): SessionCookies | null => {
  const liAt = readFlag("li-at") ?? ""
  const jsessionId = readFlag("jsessionid") ?? ""
  if (liAt.trim() && jsessionId.trim()) {
    return { liAt: stripQuotes(liAt), jsessionId: stripQuotes(jsessionId) }
  }

  const raw = readFlag("cookie") ?? process.env.LINKEDIN_COOKIE ?? ""
  if (raw.trim()) return { raw: raw.trim() }

  const envLiAt = process.env.LINKEDIN_LI_AT ?? ""
  const envJsessionId = process.env.LINKEDIN_JSESSIONID ?? ""
  if (!envLiAt.trim() || !envJsessionId.trim()) return null
  return { liAt: stripQuotes(envLiAt), jsessionId: stripQuotes(envJsessionId) }
}

/** Cookie names only — never values. */
const cookieNames = (raw: string): string[] =>
  raw
    .split(";")
    .map((part) => part.split("=")[0].trim())
    .filter(Boolean)

const describeInput = (cookies: SessionCookies): void => {
  if (isRawCookieHeader(cookies)) {
    const names = cookieNames(cookies.raw)
    console.log(
      `Checking a captured cookie header (${cookies.raw.length} chars, ${names.length} cookies) against ${VOYAGER_BASE}/me`,
    )
    console.log(`  cookies present: ${names.join(", ")}`)
    if (!jsessionIdFrom(cookies.raw)) {
      console.log("Note: no JSESSIONID in the header — csrf-token will be empty and this will 403.")
    }
    if (!/(?:^|;)\s*li_at=[^;\s]/i.test(cookies.raw)) {
      console.log("Note: no li_at in the header — that capture was not from a logged-in request.")
    }
    return
  }
  console.log(
    `Checking li_at (${cookies.liAt.length} chars) + JSESSIONID (${cookies.jsessionId.length} chars) against ${VOYAGER_BASE}/me`,
  )
  if (cookies.liAt.length < 160) {
    console.log("Note: li_at is shorter than typical (~200 chars) — check it wasn't clipped on copy.")
  }
}

interface Verdict {
  ok: boolean
  verdict: string
  advice: string[]
}

/** Advice for a 3xx, which is where the interesting distinction lives. */
const explainRedirect = (status: number, setCookies: string[], location: string | null): Verdict => {
  const { kind, revokedCookies } = diagnoseAuthFailure(setCookies, location)

  if (kind === "revoked") {
    return {
      ok: false,
      verdict: `REVOKED — HTTP ${status}, and LinkedIn deleted the session cookies in the response.`,
      advice: [
        `Upstream sent a "delete me" / Max-Age=0 Set-Cookie for: ${revokedCookies.join(", ")}.`,
        "That is an active revocation, not an expiry: the credential itself was thrown away.",
        "The credential is being rejected for the request's shape, not (only) its age — a real Voyager call carries the whole cookie jar plus x-li-track / x-li-page-instance.",
        "Log in again in the browser, then capture a complete request:",
        "DevTools → Network → any /voyager/api/... request → Copy as cURL (bash), then",
        "npm run import:cookie -- capture.txt   (prints the .env lines to paste)",
        "Do not keep retrying with the same two cookies — that escalates to a checkpoint.",
      ],
    }
  }

  if (kind === "checkpoint") {
    return {
      ok: false,
      verdict: `INVALID — HTTP ${status}, redirected to a security checkpoint.`,
      advice: [
        "The account needs attention in a normal browser: open LinkedIn and clear the checkpoint (verification prompt) before trying again.",
        "Re-capture the cookies afterwards; the ones you have now will not start working.",
      ],
    }
  }

  if (kind === "login_wall") {
    return {
      ok: false,
      verdict: `INVALID — HTTP ${status}, redirected to the login wall.`,
      advice: [
        "The session is logged out on LinkedIn's side. Log in again in the browser.",
        "Then re-capture: npm run import:cookie -- capture.txt",
      ],
    }
  }

  return {
    ok: false,
    verdict: `INVALID — HTTP ${status}, an unexpected redirect.`,
    advice: [
      "The li_at cookie is expired, revoked, or truncated on copy.",
      "Copy li_at and JSESSIONID together, from the same browser session, in one sitting.",
      "Right-click the cookie row and copy the value — dragging across it can clip the end.",
      "Better: capture a whole request with `npm run import:cookie` and set LINKEDIN_COOKIE.",
    ],
  }
}

const explain = (status: number, setCookies: string[], location: string | null): Verdict => {
  if (status === 200) {
    return { ok: true, verdict: "VALID — LinkedIn accepted these cookies.", advice: [] }
  }
  if (status >= 300 && status < 400) return explainRedirect(status, setCookies, location)
  if (status === 401 || status === 403) {
    return {
      ok: false,
      verdict: `INVALID — HTTP ${status}.`,
      advice: [
        "403 with a li_at you believe is good usually means JSESSIONID does not match it.",
        "Both cookies must come from the same live session; LinkedIn rotates them independently.",
      ],
    }
  }
  if (status === 429 || status === 999) {
    return {
      ok: false,
      verdict: `RATE LIMITED — HTTP ${status}.`,
      advice: [
        "LinkedIn's anti-automation response. The cookies may be fine.",
        "Stop retrying for a while — repeated attempts are what escalate this to a checkpoint.",
      ],
    }
  }
  return { ok: false, verdict: `UNEXPECTED — HTTP ${status}.`, advice: [] }
}

const main = async (): Promise<number> => {
  const cookies = resolveCookies()
  if (!cookies) {
    console.error("No cookies to check.")
    console.error("Set LINKEDIN_COOKIE (see `npm run import:cookie`) in .env, or set")
    console.error("LINKEDIN_LI_AT and LINKEDIN_JSESSIONID, or pass:")
    console.error('  npm run check:session -- --li-at=AQEDA... --jsessionid="ajax:123..."')
    return 2
  }

  describeInput(cookies)

  let status: number
  let setCookies: string[] = []
  let location: string | null = null
  try {
    const response = await fetch(`${VOYAGER_BASE}/me`, {
      headers: voyagerHeaders(cookies),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    status = response.status
    setCookies = response.headers.getSetCookie()
    location = response.headers.get("location")
  } catch (err) {
    console.error(`\nCould not reach LinkedIn: ${err instanceof Error ? err.message : err}`)
    return 1
  }

  const { ok, verdict, advice } = explain(status, setCookies, location)
  console.log(`\n${verdict}`)
  for (const line of advice) console.log(`  - ${line}`)
  if (ok) {
    console.log("  - Put the values in .env and restart the server: a failed check is")
    console.log("    remembered for 30s, so the process will not recover on its own.")
  }
  return ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
