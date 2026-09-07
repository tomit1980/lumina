> Approved plan, copied from the session plan file for durability.

# Part B — task owner + collaborators

## Context

Today a task has exactly one `assigneeId`. The user wants a task assignable to several
people. Decisions already taken with the user:

- **One owner plus collaborators**, not a flat set. One person stays accountable; the board
  card keeps a single primary avatar; "whose is this?" always has an answer.
- **Build now, Supabase schema included.** Types, store logic and UI carry straight into
  Plan 2 (only persistence changes there), and the `task_collaborators` table ships now so
  Plan 2 finds it ready.

Design principles that fall out of the codebase map:

- **Keep `assigneeId` as the owner field.** It has 30+ call sites, a DB column, and generated
  types; renaming buys nothing. The UI label changes from "Assignee" to "Owner".
- **Assignment never grants access.** A collaborator on a restricted project must already be
  able to see it. The picker only offers such people, and the store refuses anyone else as
  defence in depth. This is the same rule the RLS layer enforces for `task_attachments`.
- **Invariants:** the owner is never also a collaborator; no duplicate collaborators.
  Enforced in the store on every write, and by a trigger in Postgres.
- **"Mine" means owner *or* collaborator** everywhere the app asks — home dashboard, schedule
  export, reminders, project filter. Owner-first ordering where a list is shown.

## Data model

`lib/types.ts` `Task` gains one field:

```ts
assigneeId: string | null;      // unchanged — the OWNER
collaboratorIds: string[];      // new — never contains assigneeId, no duplicates
```

`TaskInput` (`lib/store.tsx:53`) gains `collaboratorIds?: string[]` (optional, default `[]`).

## Tasks

Execute with subagent-driven development, one implementer per task, on a new branch
`feat/task-collaborators` created **after Part A is merged**. Every task ends green on
`npm run typecheck && npm run lint && npm test`. **Never run `npm run build`** while the
static preview server is up.

### Task 1 — type, seed, migration

- `lib/types.ts`: add `collaboratorIds: string[]` to `Task`.
- `lib/seed.ts`: bump `SEED_VERSION` 10 → 11; `task()` helper defaults `collaboratorIds: []`;
  give two or three seeded tasks real collaborators so the UI has something to show.
- `lib/store.tsx` `migrate()`: extend `LegacyState`'s task shape (`:273-284`) to make
  `collaboratorIds` optional, and backfill `collaboratorIds: t.collaboratorIds ?? []` in the
  `tasks.map` (`:331-339`), exactly like `attachments: t.attachments ?? []`.
- `tests/qa/_support.ts` `addTask` defaults `collaboratorIds: []`; every fixture that builds a
  `Task` literal (`task-ordering`, `resource-access`, `rbac-matrix`, `migration`,
  `pure-helpers`) gets the field — the type-checker will list them.
- **Tests:** `tests/qa/migration.test.ts` — a v10 blob without the field migrates to `[]`;
  the existing `for v = 1..SEED_VERSION` loop picks up 11 automatically.

### Task 2 — store: normalise, guard, log

In `lib/store.tsx`:

- Add `canUserSeeProject(s, project, userId)`: unrestricted → true; restricted → the user is a
  member, the creator, or holds `members.manage`. The existing `canSeeProject` only answers for
  the *current* user; this is the per-user form the picker and guard both need. Reuse
  `resourceMemberLevel` and `roleHas`.
- Add a pure `normaliseCollaborators(ownerId, ids)`: dedupe, drop the owner, keep order.
  Export it (it is also what the dialog uses to show a consistent list).
- `createTask` / `updateTask`: after merging the patch, run the normaliser with the
  *resulting* owner (a patch may change both at once). If any collaborator fails
  `canUserSeeProject`, `deny("… can't see this project")` and refuse the whole write rather
  than silently dropping — silent drops hide intent.
- Activity text (there is none today for assignment): on owner change
  `assigned "<title>" to <Name>` / `unassigned "<title>"`; on collaborator add/remove
  `added <Name> to "<title>"` / `removed <Name> from "<title>"`. Emit per person.
- **Tests:** new `tests/qa/collaborators.test.ts` — owner removed from collaborator list
  automatically; duplicates collapse; patch that sets the owner to an existing collaborator
  removes them from the list; non-visible user on a restricted project is denied and state is
  unchanged; activity text emitted; unrestricted project accepts anyone.

### Task 3 — every "mine" read

Four places test `assigneeId === me`; each becomes owner-or-collaborator, keeping the existing
"unassigned and I created it" fallback where it already exists:

- `app/page.tsx:59` and `:79` (home: my open tasks, completed by me) — owner tasks sort first.
- `components/app-shell.tsx:214-215` (my scheduled tasks / calendar export).
- `components/reminders.tsx:144-146` — the reminder gate. Collaborators get reminders too.
- `app/projects/page.tsx:150-153` — the assignee filter matches owner *or* collaborator;
  "Unassigned" keeps meaning no owner.

Introduce one helper `isMine(task, userId)` in `lib/permissions.ts` (or beside the pure task
helpers) and use it in all four so they cannot drift again. **Tests:** unit-test the helper;
extend the existing home-page test if one exists, otherwise a small one in `pure-helpers`.

### Task 4 — the dialog and the cards

- `components/task-dialog.tsx`: rename the "Assignee" `Select` to **Owner** (same control).
  Below it add a **Collaborators** block modelled on `components/access-dialog.tsx`'s
  add/remove list (avatar chip + remove ×, plus an "Add person" `Select` of remaining
  candidates) — no per-row level select, collaborators are equal. Candidates come from
  `canUserSeeProject` for the selected project, minus the owner and existing collaborators;
  when the project changes, prune collaborators who can no longer see it and say so inline.
  Respect the existing `readOnly` gate.
- `components/kanban/task-card.tsx:114-122` and `components/kanban/list-view.tsx:90-98`: the
  single avatar becomes a small stack — owner first, then up to two collaborators, then "+N".
  Tooltip lists everyone with the owner marked. Keep the existing `UserAvatar` sizes.
- **Verification is in the browser** (Task 6); no jsdom test for the dialog.

### Task 5 — Supabase schema and RLS

New migration `supabase/migrations/20260907000600_task_collaborators.sql`, mirroring
`task_attachments` (the two-column join table, `20260906000400_attachments.sql:67-71,
175-222`) rather than `project_members` (which has a level column we don't want):

```sql
create table public.task_collaborators (
  task_id text not null references public.tasks (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (task_id, user_id)
);
```

- A per-user visibility function `user_can_see_project(project_id text, user_id uuid)`,
  `security definer`, `set search_path = public`, mirroring `can_see_project` but taking the
  user explicitly — the existing one reads `auth.uid()`.
- Policies: `_read` joins through `tasks` + `can_see_project`; `_insert`/`_delete` require
  `has_permission('task.edit')` and the task's project visible and not viewer-only —
  **table-qualify every outer column** (`task_collaborators.task_id`), the lesson from
  Plan 1. No `for all`. No update policy at all (a row is a fact; delete + insert).
- Two triggers: on `task_collaborators` insert, reject if `user_id` equals the task's
  `assignee_id` or cannot see the project; on `tasks` update of `assignee_id`, delete the
  matching collaborator row so the DB invariant matches the store's.
- `npm run db:push` to lumina-dev, `npm run db:types` to regenerate `lib/database.types.ts`.
- **Tests:** `tests/rls/task-collaborators.test.ts` plus `addTaskCollaborator` in
  `tests/helpers/workspace.ts` — outsider cannot read rows for a restricted project's task;
  member with `task.edit` can add a visible person; cannot add an outsider (trigger); cannot
  add the owner; promoting a collaborator to owner removes their row; viewer-only member
  cannot add. And **one controller probe** `collaborator_probe.mjs` in the SDD workspace
  attacking the live table from an anon client — the suites missed 13 holes last time, the
  probes caught them.

### Task 6 — browser verification and docs

- On `lumina-static` (`http://localhost:3001/lumina/`): open a task, set an owner and two
  collaborators, save; the card shows the stack; the home page lists it for a collaborator
  when signed in as them; the reminder fires for a collaborator; a restricted project's
  picker excludes non-members; reload survives.
- Note in `docs/superpowers/specs/2026-09-06-lumina-production-design.md` under the store
  mapping: `collaboratorIds` ↔ `task_collaborators` rows, so Plan 2 does not rediscover it.

## Verification (whole plan)

```
npm run typecheck && npm run lint && npm test && npm run test:rls
```
plus all eight probes (seven existing + `collaborator_probe.mjs`), the browser pass above, and
a final whole-branch review before merge.

## Out of scope

No notifications or emails on assignment (deferred with invites, per the production spec). No
"assign to everyone" bulk action. No change to who may *edit* a task — collaborator status is
informational plus reminders/"mine", not a permission.
