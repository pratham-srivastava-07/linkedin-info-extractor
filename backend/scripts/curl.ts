/**
 * Parses a DevTools "Copy as cURL (bash)" blob into the few values we need.
 *
 * Kept apart from `import-cookie.ts` so it can be unit tested without running
 * the CLI. It is a shell-ish tokenizer rather than a regex per flag because the
 * blob varies: single or double quotes, `-H`/`--header`, `-b`/`--cookie`, and
 * backslash line continuations, all mixed in one paste.
 */
export interface CapturedRequest {
  cookie: string | null
  userAgent: string | null
  xLiTrack: string | null
  xLiPageInstance: string | null
}

/**
 * Splits on whitespace, honouring single quotes (literal), double quotes (with
 * backslash escapes) and `\`-newline continuations. Good enough for a curl
 * command line; it is not a shell.
 */
export const tokenize = (input: string): string[] => {
  const tokens: string[] = []
  let current = ""
  let started = false
  let quote: "'" | '"' | null = null

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]

    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }

    if (quote === '"') {
      if (char === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1])) {
        i += 1
        if (input[i] !== "\n") current += input[i]
        continue
      }
      if (char === '"') quote = null
      else current += char
      continue
    }

    if (char === "\\") {
      const next = input[i + 1]
      // A trailing backslash before a newline is a continuation, not an escape.
      if (next === "\n") {
        i += 1
        continue
      }
      if (next === "\r" && input[i + 2] === "\n") {
        i += 2
        continue
      }
      if (next !== undefined) {
        i += 1
        current += next
        started = true
        continue
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }

    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }

    current += char
    started = true
  }

  if (started) tokens.push(current)
  return tokens
}

const HEADER_FLAGS = new Set(["-H", "--header"])
const COOKIE_FLAGS = new Set(["-b", "--cookie"])

/** All `-H` values, as `[lowercased name, value]` pairs. */
const headersOf = (tokens: string[]): Array<[string, string]> => {
  const headers: Array<[string, string]> = []
  for (let i = 0; i < tokens.length; i += 1) {
    if (!HEADER_FLAGS.has(tokens[i])) continue
    const raw = tokens[i + 1]
    if (raw === undefined) continue
    const separator = raw.indexOf(":")
    if (separator < 0) continue
    headers.push([raw.slice(0, separator).trim().toLowerCase(), raw.slice(separator + 1).trim()])
  }
  return headers
}

const cookieFlagValue = (tokens: string[]): string | null => {
  for (let i = 0; i < tokens.length; i += 1) {
    if (COOKIE_FLAGS.has(tokens[i]) && tokens[i + 1] !== undefined) return tokens[i + 1].trim()
  }
  return null
}

export const parseCurl = (blob: string): CapturedRequest => {
  const tokens = tokenize(blob)
  const headers = headersOf(tokens)
  const pick = (name: string): string | null =>
    headers.find(([headerName]) => headerName === name)?.[1] || null

  // `-b` is the other way DevTools (and hand-written curl) carries cookies; a
  // `-H 'cookie: …'` wins because that is what the browser actually sent.
  const cookie = pick("cookie") ?? cookieFlagValue(tokens)

  return {
    cookie: cookie && cookie.trim() ? cookie.trim() : null,
    userAgent: pick("user-agent"),
    xLiTrack: pick("x-li-track"),
    xLiPageInstance: pick("x-li-page-instance"),
  }
}
