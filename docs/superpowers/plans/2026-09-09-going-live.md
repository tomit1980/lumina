> **Approved 2026-09-09.** The final phase of docs/superpowers/specs/2026-09-06-lumina-production-design.md.
> **Not to be executed without an explicit go-ahead** — this is the only plan that touches production.

# Lumina — going live

## Context

Lumina's public URL, `tomit1980.github.io/lumina`, still serves the browser-only demo: three
fictional colleagues, a password printed on the login screen, a workspace living entirely in each
visitor's browser. Behind it, across three plans, a real product now exists — real accounts with
server-side two-factor, every action writing to Postgres under row-level security, private file
storage, and live updates. It has never been switched on.

This plan switches it on. It is the last of the four the production design spec laid out, and the
only one that touches **production** (`eshstdmgceohizbevwll`), which to this day has never been
contacted: every migration, probe and test has run against development. The repository does not
reference it anywhere.

Cutover differs in kind from everything before it. Prior work was reversible by a git revert. This
changes a database you cannot re-run and changes what strangers see at a public address. So the
plan is built to be **rehearsed, reversible, and small at the moment of truth** — the flip itself
is one environment variable.

**Decisions taken with the user:**
- **The URL becomes the product.** The demo is retired, not preserved elsewhere.
- **Two people to start** — the user and one colleague. No wider rollout yet.

**Precondition:** live updates and presence merged and reviewed. A cutover that ships a
half-finished feature is how a good migration earns a bad reputation.

## What this review changed about the first draft

Four things in the draft did not survive scrutiny, and they are the reason this plan is shorter
and safer than it was.

**The rehearsal needed no third project.** The draft proposed a scratch Supabase project to run all
fifteen migrations in sequence, because nobody has ever watched them run in order against an empty
database — they were applied to development one at a time over three days, with fixes in between.
But the free tier allows two active projects and both are taken. Production *is* the empty database.
Rehearsing on it, while it holds nothing, gives the same evidence for free — and if it goes wrong,
resetting an empty project costs nothing. The rehearsal and the real application are the same act.

**The draft dropped a requirement the spec already made.** Phase 3 of the approved spec calls for a
weekly `pg_dump` to a build artifact, because the free tier has no backups. The draft demoted that
to an open question. It is not a question; it was decided. It returns as a task — with the
observation that it needs a production database credential stored as a repository secret, which is
the single highest-value secret this project will hold.

**Deleting the demo is far more expensive than the draft implied, and mostly unnecessary.**
`LocalBackend` is not only the demo's storage — it is what 34 test suites mount, and the failing
double used throughout the suite extends it. Deleting it would be a test-suite refactor disguised
as a cleanup. The correct split: **delete what users can reach** — the demo logins, the printed
password, "View as", "Reset demo data", the seeded workspace, the local two-factor — and **keep
`LocalBackend` as a test fixture** that is never selected at runtime. The demo disappears; the
tests keep working.

**The rollback claim was too comfortable.** "One commit" is true of the site, which has no server
state. It is not true of your data: anything created while live stays in production, invisible while
rolled back, and reappears when you go forward. That is fine, but it should be known rather than
discovered.

## Tasks

### Task 1 — apply the schema to production, and prove it there

The rehearsal and the application are one act, performed while production is empty.

- Confirm production is genuinely empty before touching it.
- Apply all fifteen migrations in order. **Expect trouble:** migration order is already known to be
  fragile — one file sorts before an earlier-applied one and needed the CLI's `--include-all`
  remedy. Finding the next such problem here is the point.
- Regenerate `lib/database.types.ts` against production and confirm it is **byte-identical** to the
  version generated against development. A difference means the two databases have diverged.
- **Run the probes against production, once, while it is empty.** They create and delete their own
  users, so this is the only moment it is safe — and it is the strongest available proof that the
  policies behave the same there as in development. Never run them against production again.

### Task 2 — configure production and create the two accounts

Following `docs/runbooks/creating-a-user.md`, which exists and should be re-read rather than
remembered.

- **Turn off public sign-ups first.** Until that is done, anyone reaching the Supabase URL can
  create themselves an account and the trigger will hand them a real member profile.
- Create both accounts with **Auto Confirm User** ticked — an unconfirmed account cannot sign in.
- Promote the first to admin with the bootstrap SQL.
- Verify the three system roles and the `general` channel exist, and that **no seeded content
  does**. Structure only was the choice; fictional colleagues in a real workspace would be worse
  than useless.

### Task 3 — weekly backup

A scheduled GitHub Actions workflow running `pg_dump` and keeping the result as an artifact, per
the spec. The free tier has no backups; without this, a mistake is unrecoverable.

**Flag plainly:** this requires a production database credential in repository secrets — the
highest-value secret this project will hold, and one that grants far more than the anonymous key
already shipped in the bundle. Confirm before adding it, and never let it reach a build output.

**Prove the backup by restoring it, not by admiring it.** Once the first dump exists, restore it
into the development project and compare table lists and row counts against production. An
unrestored dump is a belief. This restore is also the gate on Task 6 — nothing is deleted until it
has succeeded once.

### Task 4 — point the build at production, and test it locally

Set `NEXT_PUBLIC_BACKEND=supabase` and production's URL and anonymous key as repository secrets,
but **do not flip the deployed build yet**. Build with that configuration and serve it locally.

Then walk it end to end as both real accounts: sign in, enrol two-factor, sign out and back in with
a code, post in a channel, create a project and a task, upload a file, open it in the editor, and in
a second browser confirm live updates arrive and a restricted project is absent.

Add a mechanical check to the workflow that the **secret key never appears in build output** — a
one-line grep, permanently. This is the last point where a problem costs nothing.

### Task 5 — the flip

Change the flag in the deploy workflow, push, watch the deploy. Load the public URL signed-out and
confirm a login screen with **no demo accounts and no password hint**.

**Rehearse the rollback before telling anyone the app is live.** Revert, push, confirm the demo
returns, then go forward again. Untested rollbacks are not rollbacks.

### Task 6 — retire the demo, after it has been used in anger

Only once the real thing has been running, and **only behind the backup gate below**.

**Nothing is deleted until all three are true.** A backup that has never been restored is a belief,
not a backup.

1. **The scheduled backup has produced at least one real dump** — not merely that the workflow was
   added, but that an artifact exists and was downloaded.
2. **That dump has been restored somewhere and checked.** Restore it into the development project
   (which is disposable) and confirm the tables and row counts match production. This is the only
   way to learn that a dump is restorable *before* needing it to be.
3. **The commit before the deletion is tagged** — `demo-final` — so the demo is one checkout away
   permanently, regardless of what happens to any branch.

Then, and only then:

- **Delete what users can reach:** the one-click demo logins, `DEMO_PASSWORD`, "View as",
  "Reset demo data", `lib/totp.ts`, the seeded workspace, and the backend flag with its branch in
  every consumer.
- **Keep `LocalBackend` as a test fixture.** It backs 34 suites and the failing double; it simply
  stops being selectable at runtime. Rename it so nobody mistakes it for a shipped path.

Doing any of this earlier removes the safety net while it is still needed. The deletion is the one
step in this plan with no natural undo — every other step is a revert or a re-run.

## Open items to decide, not discover

- **The project pauses after seven days idle** and needs waking by hand. With two people that is an
  annoyance you will notice yourself. It becomes a real problem the day a third person depends on it.
- **Deletion events bypass the access rules** — any signed-in person receives the identifier of any
  deleted row, no content, no linkage. Accepted for one team and pinned by a probe; revisit if
  Lumina ever serves more than one.
- **Orphaned files accumulate**; `scripts/sweep-orphaned-attachments.mjs` clears them and nothing
  runs it automatically.
- **Removing someone else's second factor needs dashboard access.** The lost-phone path is manual
  until an Edge Function exists — which matters more now that a colleague is involved.
- **One role operation is last-writer-wins**, and three writes span statements without a
  transaction. Both self-correct on reload; neither has a realistic trigger with two people.

## Verification

Before the flip: all fifteen migrations applied to production, generated types identical to
development, probes green against production while empty, the full local pass in Task 4, and
`npm run typecheck && npm run lint && npm test` clean.

Before any deletion: a real dump downloaded, **restored into development and verified**, and the
pre-deletion commit tagged `demo-final`.

After the flip: the public URL shows a real login screen; both accounts complete the end-to-end walk;
`npm run test:rls` and `npm run probes` still pass **against development** — those suites create and
delete users and must never be pointed at production once it holds real data.

Rollback rehearsed and confirmed before anyone is told.

## Out of scope

Invites and email notifications, deferred by the spec and still deferred. A custom domain. Message
pagination. Anything not required to put the existing product in front of the two people it is for.
