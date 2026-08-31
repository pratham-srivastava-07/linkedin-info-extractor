import express from "express"
import cors from "cors"
import { buildCorsOptions } from "./config/cors"
import { env } from "./config/env"
import { PrismaClass } from "./helpers/prisma"
import { requestLogger } from "./middlewares/requestLogger"
import { router } from "./routes"
import { globalErrorHandler, notFoundHandler } from "./utils/error"
import { gracefulShutdown } from "./utils/shutdown"

const app = express()
app.disable("x-powered-by")
// First, so a request is logged whatever happens to it afterwards — including a
// CORS preflight the cors middleware answers and ends on its own.
app.use(requestLogger())
app.use(cors(buildCorsOptions(env.CORS_ORIGINS)))
app.use(express.json({ limit: "16kb" }))

// Routes sit at the root because docs/api.md publishes them there, and that
// document is the contract callers integrate against.
app.use(router)

app.use(notFoundHandler)
app.use(globalErrorHandler) // must be last, after routes

const server = app.listen(env.PORT, () =>
  console.log(`ProfileLens API on http://localhost:${env.PORT}`),
)

// Let in-flight extractions finish, and give Postgres its connections back,
// before the process goes away on a redeploy.
let shuttingDown = false
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // A platform that sends SIGTERM twice must not start a second sequence.
    if (shuttingDown) return
    shuttingDown = true
    void gracefulShutdown(signal, {
      closeServer: () =>
        new Promise<void>((resolve, reject) => {
          // `close` waits for every open socket, and an idle keep-alive
          // connection would otherwise hold it open until the timeout fires.
          server.closeIdleConnections()
          server.close((err) => (err ? reject(err) : resolve()))
        }),
      disconnectDatabase: () => PrismaClass.disconnect(),
    })
  })
}

export { app }
