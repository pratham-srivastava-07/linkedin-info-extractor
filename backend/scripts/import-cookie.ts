/**
 * Turns a "Copy as cURL (bash)" blob into the `.env` lines to paste.
 *
 *   npm run import:cookie -- capture.txt
 *   pbpaste | npm run import:cookie          (or on Windows: Get-Clipboard | ...)
 *
 * In the browser: DevTools → Network → any request to `/voyager/api/...` →
 * right-click → Copy → Copy as cURL (bash). Save it to a file or pipe it in.
 *
 * Assembling a 15-cookie header by hand is where mistakes happen, and a partial
 * cookie set is exactly what got a session revoked (see docs/notes.md).
 *
 * It prints the env lines to **stdout and nothing else** — it never writes
 * `.env` for you, so a paste that captured the wrong request cannot silently
 * replace a working configuration. Progress messages go to stderr and never
 * contain a cookie value; only cookie *names* are shown.
 */
import { readFileSync } from "node:fs"
import { parseCurl } from "./curl"

const readInput = async (): Promise<string> => {
  const [file] = process.argv.slice(2).filter((arg) => !arg.startsWith("-"))
  if (file) return readFileSync(file, "utf8")

  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * dotenv treats single-quoted values as literal, which is what a cookie header
 * needs: it contains `"` (JSESSIONID) and `=` and `;`. x-li-track is JSON, so it
 * needs the same treatment.
 */
const envLine = (name: string, value: string): string => {
  if (value.includes("'")) {
    console.error(`Warning: ${name} contains a single quote; quote it yourself before pasting.`)
  }
  return `${name}='${value}'`
}

const main = async (): Promise<number> => {
  const blob = await readInput()
  if (!blob.trim()) {
    console.error("Nothing to read.")
    console.error("Usage: npm run import:cookie -- <file-with-curl-command>")
    console.error("   or: <copy the curl command> | npm run import:cookie")
    console.error("DevTools → Network → a /voyager/api/... request → Copy as cURL (bash)")
    return 2
  }

  const captured = parseCurl(blob)
  if (!captured.cookie) {
    console.error("No cookie header found in that blob.")
    console.error("Make sure you used 'Copy as cURL (bash)' on a request to www.linkedin.com")
    console.error("while logged in — an anonymous request carries no li_at.")
    return 1
  }

  const names = captured.cookie
    .split(";")
    .map((part) => part.split("=")[0].trim())
    .filter(Boolean)
  console.error(`Found ${names.length} cookies: ${names.join(", ")}`)
  for (const required of ["li_at", "JSESSIONID"]) {
    if (!names.some((name) => name.toLowerCase() === required.toLowerCase())) {
      console.error(`Warning: no ${required} in this capture — it will not authenticate.`)
    }
  }

  const lines = [envLine("LINKEDIN_COOKIE", captured.cookie)]
  if (captured.userAgent) lines.push(envLine("LINKEDIN_USER_AGENT", captured.userAgent))
  if (captured.xLiTrack) lines.push(envLine("LINKEDIN_X_LI_TRACK", captured.xLiTrack))
  if (captured.xLiPageInstance) {
    lines.push(envLine("LINKEDIN_X_LI_PAGE_INSTANCE", captured.xLiPageInstance))
  }

  console.error("Paste the following into backend/.env (nothing was written for you):\n")
  for (const line of lines) console.log(line)
  console.error("\nThen: npm run check:session")
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
