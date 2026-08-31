/**
 * Saves a raw Voyager payload to tests/fixtures/ so the normalizer can be tested
 * against real upstream shapes without hitting the network.
 *
 * Usage: npm run capture:fixture -- <profile-url> [fixture-name]
 *
 * What lands on disk is the whole `identity/dash/profiles` finder response —
 * `{ elements: [profile], paging }` — exactly as `normalizeProfile` consumes it.
 * Prefer public figures for anything that gets committed: the payload is a
 * complete profile, and tests/fixtures/ is checked in.
 *
 * Per docs/notes.md, when fields suddenly go null the fix is to capture a fresh
 * payload and diff it against the last known fixture to find what moved.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { sessionManager } from "../src/linkedin/sessionManager"
import { voyagerClient } from "../src/linkedin/voyagerClient"
import { parseProfileUrl } from "../src/validators/profile"

const main = async () => {
  const [url, name] = process.argv.slice(2)
  if (!url) {
    console.error("Usage: npm run capture:fixture -- <profile-url> [fixture-name]")
    process.exit(1)
  }

  const { publicId } = parseProfileUrl(url)
  const cookies = await sessionManager.getSession()
  const raw = await voyagerClient.profile(publicId, cookies)

  const file = join(__dirname, "..", "tests", "fixtures", `${name ?? publicId}.json`)
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`)
  console.log(`Wrote ${file}`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
