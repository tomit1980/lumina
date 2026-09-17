import { defineConfig } from "vitest/config";
import { cpus } from "node:os";
import path from "node:path";

/**
 * Vitest defaults to one fork per core. This box has 12 and the suite is
 * mostly jsdom, so a dozen forks each booting a DOM fight for memory. Four is
 * measured: the run is FASTER at four than at twelve (77s against 88s). That,
 * and nothing else, is why the cap is here.
 *
 * IT DOES NOT FIX `npm test` EXITING 1 ON A GREEN RUN, and an earlier version
 * of this comment claimed it did, on the strength of three clean runs in a
 * row. It is not fixed. `[vitest-worker]: Timeout calling "onTaskUpdate"` still
 * appears, and the run still ends `955 passed`, `2 errors`, exit 1.
 *
 * What it is NOT, each ruled out by measurement rather than argument:
 *   - not fork contention   -> identical at maxForks 2 and 4
 *   - not reporter cost     -> identical with --reporter=dot
 *   - not a specific file   -> bisected; either 25-file half is clean, so no
 *                              file carries it, and 50 files reproduce it
 *
 * It scales with the SIZE of the run: 25 files clean, 50 or more gives exactly
 * two. That shape says worker-pool teardown on this machine, not this
 * codebase. CI runs `npm test` on every push (.github/workflows/deploy.yml)
 * and is green, so it does not reproduce on a fresh 2-core runner.
 *
 * THE RULE THAT FOLLOWS: on this machine, read the FAILURE COUNT, not the exit
 * code — `grep -cE "^\s*×"` — and treat a non-zero exit with zero failures as
 * this and nothing else. Anywhere but here, exit code is still the gate.
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
