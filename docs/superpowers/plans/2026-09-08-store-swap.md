# Lumina — Plan 2: auth and store swap

> Approved 2026-09-08. Implements Phase 1 items 0, 3, 4, 5 of docs/superpowers/specs/2026-09-06-lumina-production-design.md.

## Context

The public site is a demo: every visitor's browser holds the entire workspace, private
channels and DMs included, and nothing talks to a server. Plan 1 built and independently
attacked the backend — schema, row-level security, invariant triggers, 87 tests, 8 probes.
`lib/store.tsx` is the one piece not wired to it. This plan wires it, and swaps the
browser-only login for real accounts, so the same URL stops being a demo.

Decisions taken with the user, in order:
- **Optimistic writes with rollback.** The screen updates instantly, the server reconciles,
  a rejected write is rolled back and explained. Exactly what spec item 4 specifies.
- **Seed structure only.** The real database gets the roles and a `general` channel. No
  fictional colleagues, tasks or messages.
- **Self-signup off; admin creates users.** Nobody outside the team can ever get an account.
  A trigger gives each new user a profile with the Member role.
- Already fixed by the spec: email + password, TOTP moved server-side, free tier, Mumbai.

What the two maps established and the plan depends on:
- The store has **24 write actions, 9 pure selectors, 1 demo reset.** No action calls
  `update()` twice. Four are multi-step (`sendToUser`, `openDm`, `setProjectAccess`,
  cascading deletes) and four are ordering-sensitive (`createTask` position, `moveTask`,
  `toggleReaction`, `markChannelRead`).
- **There is no profile-on-signup trigger.** A new auth user is nobody to the app until a
  `profiles` row exists. Must be closed before any real sign-in.
- The auth-to-store seam is one effect in `components/auth/session-bridge.tsx`. Sign-out does
  not clear the store, which was harmless with fake data and is not with real data.
- `lib/crypto.ts` is imported only by `lib/auth.tsx` and one test. It becomes dead code
  entirely and is deleted.
- `lib/auth.tsx` already has the shape the store must adopt: actions declared as
  `Promise<...>`, typed outcome unions instead of throws, a `ready` flag, a cancel guard on
  its async hydration. The codebase already knows how to call async actions.
- `tests/qa/_support.ts` `run()` captures return values **synchronously**. It breaks the
  moment actions return promises. `rbac-matrix`, `invariants`, `collaborators`,
  `resource-access`, `messages` and `task-ordering` all depend on it.

## Architecture

**One store, two backends, one flag.** `StoreValue` survives unchanged as the seam so
components stay largely untouched. Behind it, a new `Backend` interface holds the ~24
persistence operations. Two implementations:

- `LocalBackend` — today's localStorage behaviour, every operation resolves immediately.
- `SupabaseBackend` — real calls through `lib/supabase.ts`.

`NEXT_PUBLIC_BACKEND=local|supabase` selects one at build time; **`local` is the default and
what GitHub Pages builds until the Phase 3 cutover.** Every commit on main therefore stays
deployable and the public demo keeps working while the real path is built alongside it.
Cutover flips the flag and deletes `LocalBackend`, the demo affordances and `migrate()`.

**Every action becomes `Promise<T>` with the same `T` it returns today.** The sequence
inside each action:

1. `guard()` runs synchronously as before, the local fast path. A refusal resolves
   immediately with the same falsy value as today. No patch is applied.
2. The optimistic patch is applied to `AppState` with the existing updater function.
3. `await backend.op(...)`.
4. On success, resolve. On failure, **roll back and toast** — the store owns the toast, so
   every caller gets honest feedback without checking anything.

Callers may `await` for server truth (dialogs closing on save) or fire-and-forget for
instant feel (chat send). Both are correct; the store is truthful either way. This keeps
the five false-success fixes from yesterday intact: a refused write is always surfaced.

**Rollback rule.** Each write snapshots the pre-patch state and records a monotonic
write counter. On failure: if no later optimistic write has landed, restore the snapshot;
if one has, re-hydrate the whole `AppState` from the backend instead of guessing at an
inverse. Simple, honest, and never silently drops a neighbour's change.

**What stays server-side, not client-side.** Ordering, uniqueness and cascades belong in
Postgres: `move_task` (already exists), task position defaulting, DM pair uniqueness,
reaction toggling, collaborator pruning on revocation (trigger already exists). The
client computes the optimistic version for instant display and accepts the server's answer.

**Attachments wait for Phase 2 Storage.** File bytes cannot live in Postgres rows. The
`Backend` interface includes the attachment operations; `SupabaseBackend` returns a typed
"not available yet" for them until Plan 3, and `LocalBackend` keeps working. Nothing
reaches users before cutover, which is after Plan 3.

## Tasks

Subagent-driven, one implementer per task, on branch `feat/store-swap` from main. Every
task ends green on `npm run typecheck && npm run lint && npm test` — **both, since Vitest
does not typecheck** — and on `npm run test:rls` where the database is touched. Never run
`npm run build` while a preview server is up. Never `db push` to prod (`eshstdmgceohizbevwll`);
dev is `nsioivydefazicxnozqw`.

### Task 0 — make the ground safe (spec item 0)

No behaviour change. Three things, in this order:

- **Await-ready test harness.** `tests/qa/_support.ts` `run()` becomes async-capable and
  every call site that reads a return value awaits it. Awaiting a non-promise is a no-op,
  so the full 297-test suite must stay green against today's synchronous store. This is the
  characterisation net the spec demands, made ready for the swap **before** the swap.
- **Global `unhandledrejection` handler** in `components/providers.tsx`, surfacing through the
  existing `toast.error`. Test: a rejected promise from an event handler produces a toast.
  The spec calls this the single most likely Phase 1 failure mode.
- **The flag scaffold.** `lib/backend/index.ts` reads `NEXT_PUBLIC_BACKEND` (default
  `local`), exports `backendKind`. `.env.example` documents it. Nothing consumes it yet.

### Task 1 — the seam and the async refactor (the bulk, and the risk)

- `lib/backend/types.ts`: the `Backend` interface — one method per persistence operation,
  named after the store action, taking plain data and returning `Promise<void>` or the
  created row. Plus `hydrate(): Promise<AppState>` and `reset()`.
- `lib/backend/local.ts`: `LocalBackend` — moves the hydrate/persist effects and `migrate()`
  out of `lib/store.tsx` unchanged. Operations resolve immediately.
- `lib/store.tsx`: every write action follows the four-step sequence above, using a shared
  `commit(patch, () => backend.op())` helper that implements the rollback rule. Return types
  become `Promise<T>`. `guard`/`deny`/`activity` are untouched. The 9 selectors are untouched.
- Every caller of a write action is checked: those that use the return value `await` it;
  chat send and reactions fire-and-forget. `components/task-dialog.tsx`,
  `components/documents/document-page.tsx`, `app/page.tsx` quick-complete, `access-dialog`,
  `project-dialog`, `channel-dialog`, `conversation.tsx`, `kanban/board.tsx` drag-drop.
- **Tests that must exist before this is done:** a `FailingBackend` test double in
  `tests/qa/_support.ts` that rejects a named operation. For at least one action per
  family (message, task, project, role): optimistic patch is visible before the promise
  resolves; rejection restores the snapshot and toasts; rejection after a *second* optimistic
  write triggers re-hydrate rather than a bad restore. Plus: all 297 existing tests green.

Split this into two commits if it helps review: (a) seam + LocalBackend with sync-looking
wrappers, (b) the async/optimistic conversion.

### Task 2 — the database additions Plan 1 did not need

One migration `supabase/migrations/20260908000800_store_swap.sql`, plus RLS tests:

- **`handle_new_user` trigger** `after insert on auth.users`: inserts a `profiles` row with
  `role_id = 'member'`, `email` from the auth row, `name`/`handle` derived from the email's
  local part, made unique. `security definer`, `set search_path = public`. Test: creating an
  auth user via the admin API yields a profile with the Member role and no manual insert.
- **First-admin bootstrap:** a documented one-line SQL the user runs once in the dashboard
  to promote their own profile to `admin`. Not automated — it is a deliberate act.
- **DM uniqueness:** a unique index on the ordered member pair (least/greatest), and an RPC
  `find_or_create_dm(other_user_id uuid) returns text` that is race-safe. This retires the
  client-side find-then-create in `sendToUser`/`openDm`.
- **Task position:** a `before insert` trigger on `tasks` that defaults `position` to
  `max + 1` within the column when not supplied. Retires the client-side `columnSize` count.
- **`toggle_reaction(message_id, emoji)` RPC** — atomic add-or-remove, respecting the
  existing visibility rule.
- **Structure-only seed:** the three system roles (already present) and a `general` channel
  with `is_team = true`, idempotent. Test: fresh project has exactly these.
- **`mfa_required boolean default false` on `profiles`** for the admin "require 2FA" policy.
- Follow every Plan 1 lesson: table-qualified columns, per-command policies, `security
  definer` helpers, no `for all`. Extend the relevant probe or add `store_swap_probe.mjs`.

### Task 3 — the auth swap (spec item 3), flag-gated

- `lib/auth.tsx` keeps its `AuthValue` shape where the login screen consumes it, backed by
  Supabase Auth when `backendKind === "supabase"`: `signInWithPassword`, `signOut`,
  `onAuthStateChange` → `session`, `ready` when the initial session is resolved.
- **TOTP via native MFA:** `auth.mfa.enroll({factorType:"totp"})` feeds the existing
  `TwoFactorQr` (it only renders a URI and secret); `challenge` + `verify` on login when a
  verified factor exists; `mfa_required` on the profile drives forced enrolment at login,
  replacing the local `"pending"` status. `SelfEnrollDialog` is rewired; the login screen's
  three-step machine is kept.
- `components/auth/session-bridge.tsx` becomes auth-uid → profile → `currentUserId`, and
  **sign-out clears the store** (`backend.reset()` + re-gate). Test it.
- Under the supabase flag: the demo logins, `DEMO_PASSWORD`, "View as", `requestSwitch`,
  `SwitchTwoFactorPrompt`, "Reset demo data" and `resetAll` are **not rendered and not
  reachable** (spec item 5). They stay in the local path until cutover deletes them.
- `lib/crypto.ts` and `tests/qa/auth-crypto.test.ts` are deleted; the local path's
  password check is the only thing that needed them and it is being retired — keep the
  local demo working with a plain constant comparison behind the flag so nothing
  cryptographic remains to maintain.
- **User's dashboard step, documented in `docs/runbooks/`:** turn off "Enable email signups"
  in Authentication → Providers → Email on lumina-dev now and lumina-prod at cutover.

### Task 4 — `SupabaseBackend.hydrate()` (reads)

- Parallel selects at sign-in: `profiles`, `roles`, `channels` + `channel_members`, `dms` +
  `dm_members`, `messages` + `reactions` + `message_attachments`, `projects` +
  `project_members` + `project_attachments`, `tasks` + `task_collaborators` +
  `task_attachments`, `activities`, `read_state` for the current user. RLS does the
  filtering — the client never holds a row it may not see, which is what closes QA-001.
- Assemble `AppState` with the existing types. Row→model mapping lives in one file,
  `lib/backend/supabase/mapping.ts`, with unit tests against fixture rows (including
  `collaboratorIds` from join rows, `position` → `order`, `read_state` → `lastRead`).
- Loading: the existing hydration screen in `StoreProvider` shows until `hydrate` resolves;
  failure shows a retry state, not a blank page.
- Verify against lumina-dev with a seeded user: a guest's `AppState` contains no restricted
  project and no private channel — assert it in an RLS-layer test, not just by eye.

### Task 5 — writes: messages, DMs, reactions, read state

`sendMessage`, `sendToUser` (via `find_or_create_dm`), `editMessage`, `deleteMessage`,
`toggleReaction` (via RPC), `markChannelRead` (upsert `read_state`), `openDm`. Chat is the
most latency-sensitive surface and the one place fire-and-forget matters; confirm the
composer clears instantly and a rejected send restores the draft.

### Task 6 — writes: channels, projects, access

`createChannel`, `deleteChannel` (cascade), `setChannelAccess`, `createProject`,
`updateProject`, `deleteProject` (cascade), `setProjectAccess`. Membership changes are
delete-plus-insert on the join tables. The collaborator pruning that `setProjectAccess`
does client-side is **also** done by the existing server trigger — keep the client version
for the optimistic display, and add a test proving the two agree.

### Task 7 — writes: tasks and collaborators

`createTask` (position from the trigger; collaborators as join rows), `updateTask`
(delete-plus-insert on `task_collaborators`), `moveTask` (existing `move_task` RPC),
`deleteTask`. Re-run the four findings from the collaborators review (F1–F4) against the
Supabase path: they were proven on the store; they must hold when the store defers to the
server.

### Task 8 — writes: roles and users

`setUserRole`, `createRole`, `updateRole`, `setRolePermission`, `deleteRole`. The
last-admin and self-role invariants already exist as triggers; the client keeps its
guards for instant feedback and the tests assert the server refuses too.

### Task 9 — end-to-end against lumina-dev

Build with `NEXT_PUBLIC_BACKEND=supabase`, serve statically, and drive a real browser as a
real user (created in the dashboard, promoted with the bootstrap SQL): sign in, enrol TOTP,
sign out and back in with the code, post in `general`, DM a second real user, create a
project and restrict it, create a task with an owner and a collaborator, move it across
columns, sign in as the second user in another tab and confirm the restricted project is
absent and the message is present. Every step is recorded with what was observed. Then the
eight existing probes plus the new one. This task produces the go/no-go note for Plan 3.

## Verification (whole plan)

```
npm run typecheck && npm run lint && npm test && npm run test:rls
```
plus all probes, the Task 9 browser transcript, and a whole-branch review on the most
capable model before merge. The merge keeps `NEXT_PUBLIC_BACKEND` defaulting to `local`,
so GitHub Pages still serves the demo. Flipping it is Plan 4.

## Out of scope

Realtime, presence and file storage (Plan 3). Invites and email notifications (deferred by
the spec). Deleting `LocalBackend`, `migrate()` and the demo affordances (Plan 4 cutover).
Pagination of messages — the team is small; noted for later.
