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
    // One file at a time. Supabase rate-limits sign-ins per time window, and
    // running files in parallel bunches every suite's sign-ins into the same
    // few seconds. Memoising them (each file signs in once per identity)
    // bought headroom at 87 tests; by 233 the suite outgrew it again and the
    // gate started failing intermittently with "Request rate limit reached" —
    // never an assertion, always a different file. A gate that fails at
    // random is one people learn to ignore, which is worse than a slow one.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
