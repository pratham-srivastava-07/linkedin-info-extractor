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
    },
  },
})
