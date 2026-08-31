import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // config/env.ts validates on import, so the HTTP-layer tests need these
    // present. Dummy values: nothing here reaches the network or a database.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/profilelens_test",
      API_KEY: "test-api-key",
      LINKEDIN_LI_AT: "test-li-at",
      LINKEDIN_JSESSIONID: '"ajax:0000000000000000000"',
      /**
       * Pinned empty on purpose, and it must stay that way.
       *
       * `config/env.ts` calls `dotenv.config()`, which fills in any key vitest
       * has not already set — so without this line a developer with a real
       * `LINKEDIN_COOKIE` in `backend/.env` runs a different test suite from
       * one without: the captured header wins over the pair, and the tests that
       * exercise the two-cookie fallback fail on their machine only. Worse, the
       * live cookie ends up printed in assertion diffs. Declaring the key here
       * (dotenv never overrides a key that already exists) keeps the suite
       * hermetic and keeps real credentials out of test output. The
       * captured-header path is covered by `rawCookie.test.ts`, which sets the
       * value itself.
       */
      LINKEDIN_COOKIE: "",
    },
  },
})
