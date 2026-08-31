/**
 * Ordered, bounded shutdown: stop accepting connections, let in-flight
 * extractions finish, then hand the database connections back before the process
 * goes away. A redeploy that skips `$disconnect()` leaves Postgres holding
 * sessions until they time out, which on a small managed instance is enough to
 * starve the replacement container of connection slots.
 */

export interface ShutdownDeps {
  /** Anything with Node's `close(cb)` shape — the HTTP server in practice. */
  closeServer: () => Promise<void>
  disconnectDatabase: () => Promise<void>
  /** Hard ceiling on the whole sequence. */
  timeoutMs?: number
  exit?: (code: number) => void
  log?: (message: string) => void
  logError?: (message: string, err?: unknown) => void
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Never resolves without exiting. If either step hangs — a keep-alive socket that
 * won't close, a database that stopped answering — the timeout fires and we exit
 * anyway, because a process that refuses to die is worse than one that dies
 * untidily: the platform's own SIGKILL is the alternative, and it is not gentler.
 */
export const gracefulShutdown = async (
  signal: string,
  {
    closeServer,
    disconnectDatabase,
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    exit = (code) => process.exit(code),
    log = (message) => console.log(message),
    logError = (message, err) => console.error(message, err),
  }: ShutdownDeps,
): Promise<void> => {
  log(`${signal} received, shutting down`)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    logError(`Shutdown did not finish within ${timeoutMs}ms, exiting anyway`)
    exit(1)
  }, timeoutMs)

  // Each step is independently guarded: failing to close the server must not
  // skip the disconnect, which is the step that actually leaks.
  try {
    await closeServer()
  } catch (err) {
    logError("Error while closing the HTTP server", err)
  }
  try {
    await disconnectDatabase()
  } catch (err) {
    logError("Error while disconnecting from the database", err)
  }

  clearTimeout(timer)
  if (timedOut) return // The timeout already called exit(1); don't contradict it.
  log("Shutdown complete")
  exit(0)
}
