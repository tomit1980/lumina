# Lumina — an Owner role, a real privilege boundary, editable statuses, and a Settings area

**Branch:** `feat/owner-and-settings`, off `main` (currently `57c48da`, in sync with `origin/main`).

## Context

Two gaps prompted this.

**The top role has no ceiling.** Admin is the highest role and is `locked`, so there is no answer to "who may reshape the workspace itself". Worse, Admin is not actually a ceiling: Admin holds `members.manage`, which lets them create a role carrying any permission and assign it to a colleague. Two admins can promote each other to anything. So a role defined merely as "Admin plus one more permission" would not be above Admin at all — it would be a label. This plan makes Owner a boundary the database enforces.

**The board's columns are baked in.** Backlog / To Do / In Progress / In Review / Done live in a TypeScript union, a `check` constraint, and a `STATUS_META` map. A team cannot rename a column to match how they work, add one, or drop one they never use.

And there is nowhere to do any of this: Lumina has no settings surface at all. Role and permission editing lives on the People page; everything else is in an account dropdown.

**Outcome:** an Owner role that genuinely outranks Admin, workspace-wide statuses an Owner can edit, and one Settings area that absorbs the People page.

---

## What exploration changed since the earlier draft

This supersedes the Owner/statuses design previously held in this file. Five findings moved it:

1. **`STATUS_META` carries labels *and* dot colours** (`lib/types.ts:178`), and "To Do" is not a title-casing of `todo`. The statuses table must carry `name` and `color`, and `STATUS_META` disappears rather than being derived.
2. **`"done"` is special-cased in ~18 places across 8 files**, not the 8 the draft assumed. Full list below.
3. **`block_locked_role_update` already exists** (`supabase/migrations/20260910001000_storage.sql:197`), so locked roles and the `is_system`/`locked` flags are already protected in SQL. The header comment in `lib/backend/supabase/roles.ts` still calls this an open gap — **it is stale and must be corrected** as part of this work.
4. **`has_permission()` reads the `permissions` array only** (`20260906000100_identity.sql`) — it does not honour `locked`. Admin's array is therefore seeded with every permission. Owner's must be too, plus the new one, or every RLS check will refuse an Owner.
5. **160 status literals across 21 test files.** Preserving the five existing ids is load-bearing: rename changes `name`, never `id`.

---

## Part A — Owner, and a boundary the database enforces

### Rank

`roles` gains `rank integer not null default 50`. Seeded: Owner 100, Admin 80, Member 40, Guest 20. Rank is what "above" means; everything below reads it.

`RoleDef` gains `rank: number`.

### The four rules

Enforced by trigger and RLS — the UI mirrors them for good messages, but the database is the authority.

1. **No granting what you do not hold.** A role's `permissions` may not gain an entry the acting user lacks. Closes "Admin mints `workspace.statuses` and hands it to a colleague".
2. **No editing at or above your own rank.** `update`/`delete` on a role with `rank >= yours` is refused. An Owner may edit Admin; an Admin may not edit Owner, and (with Admin locked) may not edit Admin either.
3. **No assigning above your own rank.** `profiles.role_id` may not be set to a role outranking the actor. An Admin cannot create an Owner.
4. **No creating a role at or above your own rank.**

Rules 1 and 4 together are what make Owner real: an Admin can neither mint the permission nor mint a peer to hold it.

### The last-holder trigger

`block_last_admin_removal()` (`20260906000500_invariants.sql`) tests the **literal `'admin'` three times**. An Owner is invisible to it: a workspace could lose its only Owner while the trigger contentedly protects one Admin. Rewrite it to key on `roles.locked`, so it protects the last holder of *any* locked role — Owner and Admin alike. **This is the single most important line in Part A**, and the kind of gap that surfaces only when it matters.

Keep the `session_user = 'supabase_auth_admin'` carve-out exactly as it is; it exists for GoTrue's cascade delete and is documented at length in place.

### The role itself

A fourth seeded role: `owner`, `locked: true`, `is_system: true`, rank 100, holding every permission plus a new `workspace.statuses`. Because it is `locked`, it inherits the existing last-holder protection, the locked-role rule and the built-in-role rule with no new application code — every client gate already reads `role.locked`, never a literal id (verified across the tree).

### How an Owner first exists

- **Demo path:** a seeded `owner` account joins moshe/maya/elena on the login screen, so the role can be seen and used with no setup.
- **Supabase:** the migration promotes the existing admin (matched by role, not by name) to Owner where exactly one admin exists; otherwise it promotes nobody and the runbook covers it. `docs/runbooks/creating-a-user.md` gains an Owner section beside its existing "promote the first admin" SQL.

---

## Part B — Editable statuses

### Data model

A `statuses` table: `id text pk`, `name`, `color`, `position int`, `is_done boolean`. Seeded with today's five, **keeping their ids and their `STATUS_META` labels and colours**.

`tasks.status` loses its `check` constraint and gains a foreign key to `statuses.id` `on delete restrict`. **The deletion rule then comes free and cannot be bypassed** — not by the UI, not by a raw PostgREST call. The interface reads the count first and explains, rather than surfacing a constraint error.

Exactly one status carries `is_done`, enforced by a partial unique index. `AppState` gains `statuses: StatusDef[]`; `signedOutState()` gains `statuses: []` beside its `roles: []`.

### Replacing `"done"`

One helper — `isDone(state, status)` — and one for the reopen target, `firstOpenStatus(state)`. The sites:

- `app/page.tsx:68, 97, 234` — open-task filter, completed count, quick-complete
- `app/projects/page.tsx:170` — progress bar
- `components/reminders.tsx:148` — reminder suppression
- `components/kanban/board.tsx:128, 135` — quick-complete toggle and its toast wording
- `components/kanban/list-view.tsx:47, 50, 78, 270, 277` — done flag, overdue guard, strike-through, reopen target, toast
- `components/kanban/task-card.tsx:28, 31, 56, 95` — icon, tooltip, overdue guard, strike-through
- `lib/store.tsx:2026, 2089` — the "completed" activity line, in `updateTask` and `moveTask`

Two hardcoded `"todo"` reopen targets (`board.tsx:128`, `list-view.tsx:270`) become `firstOpenStatus`. `components/task-dialog.tsx:179`'s creation default becomes the first status by position. `mapping.ts`'s `toStatus` fallback (`"backlog"`) becomes the first status by position — keep the coercion, since it is the difference between a broken row and a broken page.

Column rendering needs no work: `board.tsx:151`, `list-view.tsx:293`, `use-task-dnd.ts:33` and `task-dialog.tsx:445` already all iterate `TASK_STATUSES`, which becomes `state.statuses`.

### Refusals

Deleting a status holding tasks, the last status, or the one marked done: refused, with the count, in the interface before the database has to.

---

## Part C — The Settings area

`app/settings/page.tsx`, a top-level page like `/people`, with sections selected by query param (`?tab=members|roles|statuses`) to match the static-export routing in `lib/routes.ts`. Add a `settingsHref(tab)` helper beside `projectHref`.

- **Members** — the People page's member list, role assignment and two-factor controls, moved wholesale.
- **Roles & permissions** — the roles list, `RoleDialog` and the permission matrix, moved wholesale, plus rank and the new refusals.
- **Statuses** — Owner only: rename, recolour, reorder, add, delete.

`/people` keeps working and redirects to `?tab=members`; the sidebar entry and the command palette's "G P" both point at Settings. Nothing that links to `/people` breaks.

**What Settings deliberately does not do:** create or delete accounts. That needs the service-role key, which cannot ship to a browser in a static export. Accounts are made in the Supabase dashboard and picked up by the `handle_new_user` trigger as Members. The Members section says so in a line of copy, rather than offering a button that cannot work.

---

## Files

**Create:** `supabase/migrations/2026xxxx_owner_and_statuses.sql`, `app/settings/page.tsx`, `components/settings/*` (members, roles, statuses sections), `components/status-dialog.tsx`, `lib/statuses.ts` (the `isDone`/`firstOpenStatus` helpers).

**Modify:** `lib/types.ts` (`StatusDef`, `AppState.statuses`, `RoleDef.rank`, remove `TASK_STATUSES`/`STATUS_META`), `lib/permissions.ts` (`workspace.statuses`, the Owner seed), `lib/seed.ts` (+`SEED_VERSION` 13→14), `lib/backend/local.ts` (`migrate`), `lib/backend/types.ts` (status write methods), `lib/backend/supabase/{roles,mapping,hydrate,statuses}.ts`, `lib/store.tsx`, `components/app-shell.tsx`, `components/command-palette.tsx`, `lib/routes.ts`, the eight `"done"` files above, and `app/people/page.tsx` (becomes a redirect).

**Correct:** the stale gap comment in `lib/backend/supabase/roles.ts`.

---

## Phases

1. **Statuses, data first** — table, FK, seed, `AppState.statuses`, the two helpers, every `"done"` site. Board and dialogs read state. No UI for editing yet.
2. **Owner and the boundary** — rank, the four rules as triggers, the last-holder rewrite, the Owner role, the demo account, the runbook.
3. **Settings area** — the page, the three sections, the People move and redirect, nav and palette.
4. **QA** — see below.
5. **Fix plan, then fixes** — findings written up, then fixed in waves, each fix mutation-tested.
6. **Merge to main and push.**

---

## Verification

Every phase ends green on `npm run typecheck && npm run lint && npm test && npm run test:rls`, then `npm run probes`. Baselines to beat, not just match: **694 unit, 235 access, 12 probes, lint 0 errors / 11 warnings.** Run `node tests/probes/e2e_dana.mjs clean` before the access suite, and `npm run probes` once — two full runs back to back interfere.

**Database tests (these are the ones that matter):**
- Deleting a status that holds tasks is refused **via a raw PostgREST call**, not through the UI — that is what proves the constraint rather than the dialog. A second `is_done` is refused.
- Each of the four rules, driven as an Admin against an Owner-ranked role: cannot grant a permission they lack, cannot edit or delete a role at or above their rank, cannot assign it, cannot create one.
- The last holder of a locked role cannot be demoted or removed, tested as **both** Owner and Admin — that trigger is the thing being rewritten.
- **Controls throughout:** an Owner *can* do each of the things an Admin cannot, and an ordinary Admin action still succeeds. A rule that refuses everybody passes every negative test.

**Unit:**
- The done-helper replaces every literal; renaming a status leaves the progress bar and home statistics correct; the reopen target resolves with no status called `todo`.
- **The regression that matters:** the 160 status literals across 21 test files still pass untouched. If they do not, the id-preserving decision did not hold and this plan needs revisiting.

**Browser, both backends.** As Owner: rename a column and watch every project follow, add one, try to delete one holding tasks and read the refusal, delete an empty one, reorder. As Admin: the Statuses section is absent and statuses are unchanged. Confirm `/people` still lands somewhere sensible. Rebuild the static export and check the demo path, since that is what the public site ships.

**Two browsers, one workspace** — the case unit tests structurally cannot see: an Owner renaming a status while an Admin has the board open.

---

## Out of scope

Per-project statuses. A status filter, which does not exist today. Bulk-reassigning tasks when a status is deleted — the refusal is the design. Any Owner power beyond editing statuses and outranking Admin. Inviting or removing accounts from the app (see Part C). Pagination of the message fetch (QA-109, recorded separately and needing its own product decision).
