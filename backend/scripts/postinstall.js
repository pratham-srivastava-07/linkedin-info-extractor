/**
 * Generates the Prisma client and compiles to dist/ straight after install, so a
 * platform whose build step is a bare `yarn` / `npm install` still produces a
 * runnable app.
 *
 * Plain JS on purpose — this runs before anything can rely on tsx.
 *
 * Each step is skipped when its inputs are absent. That is what keeps the
 * Dockerfile working: it installs dependencies *before* copying `prisma/` and
 * `src/` so the dependency layer stays cached, and then runs generate + build
 * explicitly. Without these guards that install would fail on a missing schema.
 */
const { spawnSync } = require("node:child_process")
const { existsSync } = require("node:fs")
const { join } = require("node:path")

const root = join(__dirname, "..")
const has = (...parts) => existsSync(join(root, ...parts))

const run = (label, command, args) => {
  console.log(`[postinstall] ${label}`)
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!has("prisma", "schema.prisma")) {
  console.log("[postinstall] no prisma/schema.prisma yet — skipping generate")
} else {
  run("prisma generate", "npx", ["prisma", "generate"])
}

if (!has("src", "index.ts") || !has("tsconfig.json")) {
  console.log("[postinstall] no src/ yet — skipping build")
} else {
  run("tsc", "npx", ["tsc"])
}
