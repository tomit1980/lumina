import { defineConfig } from "vitest/config";
import { cpus } from "node:os";
import path from "node:path";

/**
 * Vitest defaults to one fork per core. Most of this suite is jsdom, and a
 * dozen forks each booting their own DOM is enough memory pressure on an
 * ordinary 16 GB machine that workers stop answering the reporter: the run
 * ends `Tests 955 passed` and `Errors 2 errors`, from
 * `[vitest-worker]: Timeout calling "onTaskUpdate"`, and vitest exits 1.
 * A suite that is entirely green and still fails the build is the worst
 * possible signal, and this repo has already lost one CI build to exactly it.
 *
 * Four is measured, not guessed: at the default twelve the errors appeared on
 * every run of the full suite, and at four on none of three, while the run got
 * FASTER (77s against 88s) because the forks stop fighting for memory. Capped
 * by the core count so a 2-core CI box is not oversubscribed.
 */
const MAX_FORKS = Math.max(1, Math.min(4, cpus().length));

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/rls/**", "**/node_modules/**"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    poolOptions: { forks: { maxForks: MAX_FORKS } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
