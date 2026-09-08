# Controller probes

These attack the live **dev** database from an ordinary anonymous client, the way a
signed-in user's browser would. They exist because the task test-suites are written by
whoever wrote the code they test, and share its blind spots: these probes found **13
row-level-security holes** the suites missed during the backend build.

Run them against `lumina-dev` only. They read `.env.test.local` and clean up after
themselves.

```bash
node tests/probes/leak_probe.mjs
```

`sweep.mjs` deletes leftover `@lumina.test` fixtures and **refuses to run** if any
account with a different domain exists, so it can never touch a real user.

## The rule every probe must follow

**A probe must be able to fail.** On 2026-09-08 all seven of these reported
`ALL PROBES PASSED` while executing zero assertions: a new database trigger made their
setup throw, and with no catch block the abort skipped every check, reached the cleanup
block with a failure count of zero, and declared success. A verification tool that cannot
fail is worse than no tool, because it launders risk into confidence.

So each probe now:

- counts the checks it actually ran, and **fails if that count is zero**;
- catches setup errors, reports them, and counts them as failures;
- records a created auth user's id *before* any follow-up step, so cleanup can always
  delete it (that ordering bug leaked six orphaned users into the dev database);
- pairs negative assertions with a **positive control** proving the client can see
  something, so "cannot see the secret" is never vacuous.

Related trap, verified here: `.select("*", { head: true })` returns `error: null` for a
table that does not exist, and `{ count: "exact" }` does not fix it — only a body select
surfaces `PGRST205`, and the discriminator is `count` being a number rather than null.
Never write `count ?? 0` in an existence check.
