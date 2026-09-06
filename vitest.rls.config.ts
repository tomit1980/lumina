import { defineConfig } from "vitest/config";
import path from "node:path";

// The RLS suite is a local gate: it needs SUPABASE_* credentials from
// .env.test.local that CI does not hold, so it runs only via `npm run test:rls`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rls/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
