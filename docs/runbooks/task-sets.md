# Task sets

A task set is a reusable list of tasks for work that repeats — a Pension
Release case, an onboarding, an audit. Pick one when you create a project and
its tasks are created with it, so a new client is a name and a dropdown rather
than twelve retyped lines.

## Making one

**Settings → Task sets → New task set.** Name it, then add lines. Enter saves,
Escape cancels, and the arrows move a line up or down.

Only an **Owner** or an **Admin** sees the tab. The permission is
`workspace.taskSets`, and it appears in Settings → Roles & permissions, so a
custom role can be given it.

It is deliberately *not* `project.create`. That permission is meant to be
grantable on its own — someone who runs projects without administering the
workspace — and if set management rode on it, granting project creation would
silently also grant the right to delete the definition every future project is
built from.

## Using one

**Create a project → Task set.** Choosing one shows what will happen before you
commit to it:

> 12 tasks will be created
> 1. Collect client identification
> 2. Obtain pension fund statement
> …

Press Create and the project and all twelve tasks arrive together.

## What a set does NOT do

**Nothing syncs, in either direction.** This is the point of the design, not a
limitation to work around:

| You do this | This happens |
|---|---|
| Edit a task in a project | The set is unchanged |
| Edit the set | Projects already created are unchanged |
| Create a project afterwards | It gets the edited set |

So a set is safe to improve. Changing it cannot disturb a case already in
progress, and the next case gets the improvement.

## Archiving

Sets are **archived**, not deleted. An archived set disappears from the project
picker and stays in Settings, where the ↺ button brings it back. Projects
created from it keep their tasks and keep pointing at it.

## What a line carries

Title, description, priority, labels, and its position in the list.

**Not a status.** Instantiated tasks land in the first unfinished column,
which is where a new case belongs. **Not a due date** — a definition cannot
know when a case will start, and relative offsets (`+7 days`) are a later
addition. **Not an assignee** — a definition naming a person goes stale when
they leave, and the assignee would have to be someone who can see a project
that does not exist yet.

## If something goes wrong

**"We couldn't save" when creating a project from a set.** The project and its
tasks are created in one database transaction, so a refusal leaves *nothing* —
no half-made project with four of its twelve tasks. Try again; if it repeats,
the account may lack `task.create`, which instantiation needs as well as
`project.create`.

**Pressing Create twice.** Harmless. Task ids are generated in the browser, so
a repeated request carries ids the database already holds and creates nothing.

**The tab is missing.** The role does not hold `workspace.taskSets`. An Owner
can grant it in Settings → Roles & permissions.

## Where this lives

- `supabase/migrations/20260911000200_task_sets.sql` — tables, policies, the
  permission, and `create_project_with_tasks`
- `supabase/migrations/20260911000300_project_insert_conflict.sql` — why the
  function checks for the row instead of using `on conflict do nothing`
- `components/settings/task-sets-section.tsx` — the editor
- `tests/rls/task-sets.test.ts`, `tests/rls/project-instantiation.test.ts` —
  the rules, asserted against a real database
