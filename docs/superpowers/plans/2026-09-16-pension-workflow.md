# Pension Workflow (notes log, tab preferences, six columns, all-tasks board) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task follows superpowers:test-driven-development (watch the test fail before writing code) and ends with superpowers:verification-before-completion (read the exit code, not the summary).

**Goal:** Shape Lumina around the pension-release workflow: dated append-only client notes, per-person project tab layout, six payout-stage board columns, and one board of every task across every project.

**Architecture:** Two new migrations (a `project_client_notes` child table modelled on `project_client_documents`; a data migration that reshapes the `statuses` rows and moves work out of Backlog). Everything else is client code behind the existing `Backend` seam and optimistic `commit()` helper. Tab layout is a per-device `localStorage` preference with a pure module in front of it. The all-tasks board generalises the existing `Board` (optional project, per-task read-only, per-card label) and adds a cross-project mode to the drag hook.

**Tech Stack:** Next.js 15 static export (`basePath /lumina`, `?id=` routes), React, Tailwind v4, shadcn/radix-ui, Supabase (Postgres 17, RLS, realtime), vitest + Testing Library, live RLS suite + probes against `lumina-dev`.

**Spec:** the design agreed in chat on 2026-09-16 and recorded in the "Design decisions" section below (no separate spec file exists; this section is the spec).

## Global Constraints

- **Migrations before code, always.** `hydrate.ts` selects every table unconditionally and throws on a missing one; shipping code that reads a table production lacks turns the public URL into an error screen. Order: dev → suites → production (`npx supabase link --project-ref eshstdmgceohizbevwll`, `npx supabase db push`, link back to `nsioivydefazicxnozqw`, verify `supabase/.temp/project-ref`) → `git push`.
- **Never `git push` from the agent** (denied by permission); commit and tell the user. Never touch production data except through a migration the user has seen.
- **Every negative assertion is paired with a `CONTROL:` test.** A refusal that cannot fail is not a test.
- **New RLS tables must carry both restrictive gates** (`require_assurance`, `require_password_change`) or `tests/rls/gate-coverage.test.ts` fails. Policies split per verb, never `for all`; columns table-qualified.
- **Every write does `.select(...)` + `requireRows`**: PostgREST reports a policy-filtered write as `error: null` with an empty body.
- **Icon-only buttons get an explicit `aria-label`.** A tooltip does not name its trigger.
- **Read exit codes**: `cmd > log 2>&1; echo EXIT=$?`. The unit suite's reporter timeout is intermittent; a green summary with exit 1 is exit 1.
- **Keep jsdom renders few.** A slow render suite starved CI's reporter and failed a build with every test passing. Assert combinations in pure modules; render once to prove wiring.
- **Dates never pass through `new Date(string)`** in client-info code; epoch-ms timestamps are formatted with `date-fns` `format`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Design decisions (the spec)

1. **Notes** become `project_client_notes` rows: `{ id text, project_id, body, created_at, created_by }`, author and time stamped by a `before insert` trigger from `auth.uid()`/`now()`. **Append-only enforced by the database**: read + insert policies only, no update, no delete. Existing `project_client_info.notes` text is backfilled as each client's first entry (carrying the row's `updated_at`/`updated_by`), then the column is dropped. Pane shows entries oldest-first with avatar, name, `d MMM yyyy, HH:mm`, and a "New note" box with an "Add note" button (Enter = newline, Ctrl/Cmd+Enter submits; a refused note keeps the draft).
2. **Project tabs** Board, List, Client Info, Files all stay. A per-device preference (`localStorage` key `lumina:project-tabs`) chooses which are shown and their order, via a "Customise tabs" popover at the end of the tab row with checkboxes, up/down arrows and Reset. Default order is unchanged. Invariants: unknown ids ignored, missing ids appended in default order, duplicates collapsed, all-hidden falls back to the default row.
3. **Columns** become exactly, in order: To Do, In Progress, In Review, Pending Payout (From Super), Pending Payment (From Client), Done. Ids `todo`, `in-progress`, `in-review`, `pending-payout`, `pending-payment`, `done`. Backlog is removed; **any task in Backlog moves to To Do** (production data change, agreed). Names of surviving columns are not touched.
4. **All-tasks view** is a board at `/tasks` with the same six columns, every task the user can see across every project, each card labelled "Project name - Task name". Per-column add buttons are absent (no project to add to). Cards from projects where the user is a viewer are not draggable. Within a column, cards sort by project name then `order`; a drop computes the index within the task's own project subset. Sidebar entry "All tasks" and a command-palette "Go to" entry.

---

## File structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/20260916000100_pension_columns.sql` | Reshape `statuses` rows; move Backlog work; idempotent |
| `supabase/migrations/20260916000200_client_notes.sql` | `project_client_notes` table, trigger, policies, gates, publication, backfill, drop `notes` |
| `lib/statuses.ts` | `DEFAULT_STATUSES` (the six) |
| `lib/seed.ts` | seed tasks off Backlog; `SEED_VERSION` 15 with a `migrate()` branch |
| `lib/project-tabs.ts` | pure: tab list, prefs load/save, `visibleTabs`, `moveTab`, `toggleTab` |
| `components/project/tab-preferences.tsx` | the popover control |
| `lib/types.ts` | `ClientNote`; `ClientInfo.notes: ClientNote[]` |
| `lib/backend/types.ts` | `addClientNote` on the seam; `notes` off `ClientInfoPatch` |
| `lib/backend/supabase/client-info.ts` | `addClientNote` insert |
| `lib/backend/supabase/{hydrate,mapping,index}.ts` | select + fold notes into `Project.client` |
| `lib/backend/local.ts` | no-op `addClientNote` |
| `lib/store.tsx` | `addClientNote` action |
| `components/project/client-info-pane.tsx` | Notes section as a log |
| `components/kanban/task-filters.tsx` | assignee/priority selects shared by both pages |
| `components/kanban/board.tsx`, `task-card.tsx`, `use-task-dnd.ts` | optional project, per-task readOnly, card label, cross-project ordering |
| `app/tasks/page.tsx`, `lib/routes.ts`, `components/app-shell.tsx`, `components/command-palette.tsx` | the new page and how to reach it |
| `docs/runbooks/client-info.md`, `README.md` | docs |

---

### Task 0: Put the plan in the repo

**Files:**
- Create: `docs/superpowers/plans/2026-09-16-pension-workflow.md`

- [ ] **Step 1: Copy this file verbatim to `docs/superpowers/plans/2026-09-16-pension-workflow.md`** (the repo convention; plan mode only allowed writing it under `~/.claude/plans`).
- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-09-16-pension-workflow.md
git commit -m "docs(plan): pension workflow — notes log, tab preferences, six columns, all-tasks board

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part A — The six columns

### Task A1: `DEFAULT_STATUSES` becomes the six; seed and tests follow

**Files:**
- Modify: `lib/statuses.ts:25-31`
- Modify: `lib/seed.ts` (task `status: "backlog"` at lines 370, 373, 376, 405, 408)
- Modify: `tests/qa/statuses.test.ts`, `tests/qa/status-writes.test.ts:105-113`, `tests/qa/drag-moves.test.ts:159-165`, `README.md:29`

**Interfaces:**
- Produces: `DEFAULT_STATUSES: StatusDef[]` with ids `todo | in-progress | in-review | pending-payout | pending-payment | done`, positions 0..5, `done` the only `isDone`. Later tasks rely on `firstOpenStatus(DEFAULT_STATUSES) === "todo"` and on `pending-payment` being empty in the seed.

- [ ] **Step 1: Write the failing test** — in `tests/qa/statuses.test.ts` replace the exact-id assertion (lines 43-54) and the `firstOpenStatus` rename-safety assertion (77-79):

```ts
it("preserve the six ids exactly — the decision the whole change rests on", () => {
  expect(DEFAULT_STATUSES.map((s) => s.id)).toEqual([
    "todo", "in-progress", "in-review", "pending-payout", "pending-payment", "done",
  ]);
  expect(DEFAULT_STATUSES.map((s) => s.name)).toEqual([
    "To Do", "In Progress", "In Review",
    "Pending Payout (From Super)", "Pending Payment (From Client)", "Done",
  ]);
});

it("land new work in To Do — the first open column — whatever it is called", () => {
  expect(firstOpenStatus(renamed())).toBe("todo");
});
```

and in the board-render block (line 249) replace `expect(screen.getByText("Backlog")).toBeTruthy();` with `expect(screen.getByText("Pending Payout (From Super)")).toBeTruthy();`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/qa/statuses.test.ts`
Expected: FAIL — received `["backlog","todo",…]`.

- [ ] **Step 3: Change the constant** — `lib/statuses.ts`:

```ts
export const DEFAULT_STATUSES: StatusDef[] = [
  { id: "todo",            name: "To Do",                         color: "#0ea5e9", position: 0, isDone: false },
  { id: "in-progress",     name: "In Progress",                   color: "#f59e0b", position: 1, isDone: false },
  { id: "in-review",       name: "In Review",                     color: "#8b5cf6", position: 2, isDone: false },
  { id: "pending-payout",  name: "Pending Payout (From Super)",   color: "#14b8a6", position: 3, isDone: false },
  { id: "pending-payment", name: "Pending Payment (From Client)", color: "#f43f5e", position: 4, isDone: false },
  { id: "done",            name: "Done",                          color: "#10b981", position: 5, isDone: true },
];
```

- [ ] **Step 4: Move the seed's Backlog tasks** — in `lib/seed.ts`, every task with `status: "backlog"` (five of them) becomes `status: "todo"`. Do not touch the activity string "moved … to In Review".

- [ ] **Step 5: Retarget the other unit tests that pinned Backlog**
  - `tests/qa/status-writes.test.ts:105-113` ("CONTROL: removes an empty, non-finished column"): delete `"pending-payment"` instead of `"backlog"` — it is the seed's empty open column now.
  - `tests/qa/drag-moves.test.ts:159-165`: drag into `"pending-payout"` and assert `toContain("pending-payout")`.
  - `README.md:29`: `Per-project boards with 6 columns: To Do → In Progress → In Review → Pending Payout (From Super) → Pending Payment (From Client) → Done`.

- [ ] **Step 6: Run the unit suite, read the exit code**

Run: `npm test > /tmp/a1.log 2>&1; echo EXIT=$?; grep -E "Tests |×" /tmp/a1.log | head`
Expected: EXIT=0 (or the known intermittent reporter timeout with zero `×` lines — if any `×`, fix it).

- [ ] **Step 7: Commit**

```bash
git add lib/statuses.ts lib/seed.ts tests/qa/statuses.test.ts tests/qa/status-writes.test.ts tests/qa/drag-moves.test.ts README.md
git commit -m "feat(board): the six pension columns replace Backlog…Done in the seed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A2: Existing demo blobs migrate to the six columns

**Files:**
- Modify: `lib/seed.ts` (`SEED_VERSION` 14 → 15; `migrate()`)
- Test: `tests/qa/migration.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_STATUSES` from A1.
- Produces: `migrate(state)` on a v14 blob yields six columns in default order, no `backlog`, Backlog tasks in `todo`, a user-renamed surviving column keeps its name.

- [ ] **Step 1: Write the failing test** — append to `tests/qa/migration.test.ts` (reuse the file's existing way of building a v14 state; the seed exports `migrate`):

```ts
it("v14 → v15 reshapes the columns and moves Backlog work to To Do", () => {
  const v14 = {
    ...createSeed(),
    version: 14,
    statuses: [
      { id: "backlog", name: "Backlog", color: "#a1a1aa", position: 0, isDone: false },
      { id: "todo", name: "Renamed To Do", color: "#0ea5e9", position: 1, isDone: false },
      { id: "in-progress", name: "In Progress", color: "#f59e0b", position: 2, isDone: false },
      { id: "in-review", name: "In Review", color: "#8b5cf6", position: 3, isDone: false },
      { id: "done", name: "Done", color: "#10b981", position: 4, isDone: true },
    ],
  };
  v14.tasks[0] = { ...v14.tasks[0], status: "backlog" };

  const out = migrate(v14);

  expect(sortedStatuses(out.statuses).map((s) => s.id)).toEqual([
    "todo", "in-progress", "in-review", "pending-payout", "pending-payment", "done",
  ]);
  expect(out.tasks[0].status).toBe("todo");
  // A rename the person made is not undone by the bump.
  expect(out.statuses.find((s) => s.id === "todo")?.name).toBe("Renamed To Do");
  expect(out.version).toBe(15);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/qa/migration.test.ts`
Expected: FAIL — `backlog` still present / version 14.

- [ ] **Step 3: Implement the branch** — `lib/seed.ts`: `export const SEED_VERSION = 15;` and, at the end of the existing version chain inside `migrate()`:

```ts
if (version < 15) {
  // Same reshape the SQL migration 20260916000100 performs on a real workspace:
  // move work out of Backlog, drop it, add the two payout columns if absent,
  // and pin the known ids to their default positions. Names are left alone.
  const byDefault = new Map(DEFAULT_STATUSES.map((s) => [s.id, s]));
  state.tasks = state.tasks.map((t) =>
    t.status === "backlog" ? { ...t, status: "todo" } : t
  );
  let statuses = (state.statuses ?? []).filter((s) => s.id !== "backlog");
  for (const def of DEFAULT_STATUSES) {
    if (!statuses.some((s) => s.id === def.id)) statuses = [...statuses, { ...def }];
  }
  state.statuses = statuses.map((s) =>
    byDefault.has(s.id) ? { ...s, position: byDefault.get(s.id)!.position } : s
  );
}
```

- [ ] **Step 4: Run to see it pass**: `npx vitest run tests/qa/migration.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/seed.ts tests/qa/migration.test.ts
git commit -m "feat(board): stored demo workspaces migrate to the six columns without losing a rename

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A3: The SQL migration, and the live tests that pinned Backlog

**Files:**
- Create: `supabase/migrations/20260916000100_pension_columns.sql`
- Modify: `tests/rls/statuses.test.ts:92,96,153`, `tests/rls/project-instantiation.test.ts:58`

- [ ] **Step 1: Retarget the live tests first** (once the migration lands on dev, `backlog` matches zero rows and these would silently test nothing): in `tests/rls/statuses.test.ts` change every `.eq("id", "backlog")` to `.eq("id", "todo")`; in `tests/rls/project-instantiation.test.ts:58` change `status: "backlog"` to `status: "todo"`.

- [ ] **Step 2: Write the migration**

```sql
-- The six pension columns.
--
-- Columns are rows in `statuses`, seeded once by 20260910005000 with
-- `on conflict do nothing`. So this is a data migration: it must move work
-- before it removes a column, because `tasks.status` references `statuses`
-- with `on delete restrict`. Idempotent — every statement is a no-op the
-- second time.
--
-- ANY TASK IN BACKLOG MOVES TO TO DO. Agreed with the owner on 2026-09-16.
-- Names of the four surviving columns are not touched: a rename made in
-- Settings must not be undone by a redeploy (20260910005000's rule).
insert into public.statuses (id, name, color, position, is_done) values
  ('pending-payout',  'Pending Payout (From Super)',   '#14b8a6', 3, false),
  ('pending-payment', 'Pending Payment (From Client)', '#f43f5e', 4, false)
on conflict (id) do nothing;

update public.tasks set status = 'todo' where status = 'backlog';

delete from public.statuses where id = 'backlog';

update public.statuses set position = 0 where id = 'todo';
update public.statuses set position = 1 where id = 'in-progress';
update public.statuses set position = 2 where id = 'in-review';
update public.statuses set position = 3 where id = 'pending-payout';
update public.statuses set position = 4 where id = 'pending-payment';
update public.statuses set position = 5 where id = 'done';
```

- [ ] **Step 3: Apply to dev and confirm** (`supabase/.temp/project-ref` must read `nsioivydefazicxnozqw` first):

Run: `npx supabase db push`
Expected: `Applying migration 20260916000100_pension_columns.sql…`.

- [ ] **Step 4: Run the two live files, read the exit code**

Run: `npx vitest run --config vitest.rls.config.ts tests/rls/statuses.test.ts tests/rls/project-instantiation.test.ts > /tmp/a3.log 2>&1; echo EXIT=$?`
Expected: EXIT=0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260916000100_pension_columns.sql tests/rls/statuses.test.ts tests/rls/project-instantiation.test.ts
git commit -m "feat(board): migration to the six pension columns; Backlog work moves to To Do

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part B — Which tabs, and in what order

### Task B1: The pure tab-preference module

**Files:**
- Create: `lib/project-tabs.ts`
- Test: `tests/qa/project-tabs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ProjectView = "board" | "list" | "client" | "files";
  export const PROJECT_TABS: ReadonlyArray<{ id: ProjectView; label: string }>;
  export interface TabPrefs { order: ProjectView[]; hidden: ProjectView[] }
  export const DEFAULT_TAB_PREFS: TabPrefs;
  export function visibleTabs(prefs: TabPrefs): Array<{ id: ProjectView; label: string }>;
  export function moveTab(prefs: TabPrefs, id: ProjectView, direction: -1 | 1): TabPrefs;
  export function toggleTab(prefs: TabPrefs, id: ProjectView, visible: boolean): TabPrefs;
  export function loadTabPrefs(): TabPrefs;   // never throws; DEFAULT on anything odd
  export function saveTabPrefs(prefs: TabPrefs): void; // never throws
  ```

- [ ] **Step 1: Write the failing tests** — `tests/qa/project-tabs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAB_PREFS, PROJECT_TABS, moveTab, toggleTab, visibleTabs,
} from "@/lib/project-tabs";

const ids = (prefs: Parameters<typeof visibleTabs>[0]) => visibleTabs(prefs).map((t) => t.id);

describe("visibleTabs", () => {
  it("shows the four in default order with no preference", () => {
    expect(ids(DEFAULT_TAB_PREFS)).toEqual(["board", "list", "client", "files"]);
  });
  it("applies an order and a hidden set", () => {
    expect(ids({ order: ["client", "board", "files", "list"], hidden: ["list"] }))
      .toEqual(["client", "board", "files"]);
  });
  it("ignores an id it does not know", () => {
    expect(ids({ order: ["board", "wat" as never, "files"], hidden: ["nope" as never] }))
      .toEqual(["board", "files", "list", "client"]);
  });
  it("appends ids missing from the order, in default order — a fifth tab later must appear", () => {
    expect(ids({ order: ["files"], hidden: [] })).toEqual(["files", "board", "list", "client"]);
  });
  it("collapses duplicates", () => {
    expect(ids({ order: ["board", "board", "list"], hidden: [] }))
      .toEqual(["board", "list", "client", "files"]);
  });
  it("falls back to the default row when everything is hidden", () => {
    // A project with no tabs is a project you cannot use.
    expect(ids({ order: [], hidden: ["board", "list", "client", "files"] }))
      .toEqual(["board", "list", "client", "files"]);
  });
});

describe("editing a preference", () => {
  it("moves a tab earlier and later, and not past the ends", () => {
    const p = DEFAULT_TAB_PREFS;
    expect(moveTab(p, "client", -1).order).toEqual(["board", "client", "list", "files"]);
    expect(moveTab(p, "board", -1).order).toEqual(p.order);
    expect(moveTab(p, "files", 1).order).toEqual(p.order);
  });
  it("hides and shows without disturbing the order", () => {
    const hidden = toggleTab(DEFAULT_TAB_PREFS, "list", false);
    expect(hidden.hidden).toEqual(["list"]);
    expect(hidden.order).toEqual(DEFAULT_TAB_PREFS.order);
    expect(toggleTab(hidden, "list", true).hidden).toEqual([]);
  });
  it("CONTROL: PROJECT_TABS is the source of truth for the defaults", () => {
    expect(DEFAULT_TAB_PREFS.order).toEqual(PROJECT_TABS.map((t) => t.id));
  });
});
```

- [ ] **Step 2: Run to see it fail**: `npx vitest run tests/qa/project-tabs.test.ts` → FAIL, cannot find module.
- [ ] **Step 3: Implement** — `lib/project-tabs.ts`:

```ts
/**
 * Which of a project's tabs a person sees, and in what order.
 *
 * A per-device preference rather than a workspace setting: it lives in
 * localStorage next to `lumina:reminder-sound`, needs no table, no policy and
 * no realtime, and is how nearly every app treats view customisation. If the
 * team later wants one shared layout, back these same functions with a table.
 *
 * Pure, so the invariants below are asserted in milliseconds:
 * unknown ids are ignored, ids missing from `order` are appended in default
 * order (a fifth tab added later appears rather than vanishing), duplicates
 * collapse, and an all-hidden preference shows the default row.
 */
export type ProjectView = "board" | "list" | "client" | "files";

export const PROJECT_TABS: ReadonlyArray<{ id: ProjectView; label: string }> = [
  { id: "board", label: "Board" },
  { id: "list", label: "List" },
  { id: "client", label: "Client Info" },
  { id: "files", label: "Files" },
];

export interface TabPrefs {
  order: ProjectView[];
  hidden: ProjectView[];
}

export const DEFAULT_TAB_PREFS: TabPrefs = {
  order: PROJECT_TABS.map((t) => t.id),
  hidden: [],
};

const STORAGE_KEY = "lumina:project-tabs";

const isView = (x: unknown): x is ProjectView =>
  PROJECT_TABS.some((t) => t.id === x);

export function visibleTabs(prefs: TabPrefs): Array<{ id: ProjectView; label: string }> {
  const seen = new Set<ProjectView>();
  const order: ProjectView[] = [];
  for (const id of [...prefs.order, ...PROJECT_TABS.map((t) => t.id)]) {
    if (isView(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  const hidden = new Set(prefs.hidden.filter(isView));
  const shown = order.filter((id) => !hidden.has(id));
  const ids = shown.length > 0 ? shown : PROJECT_TABS.map((t) => t.id);
  return ids.map((id) => PROJECT_TABS.find((t) => t.id === id)!);
}

export function moveTab(prefs: TabPrefs, id: ProjectView, direction: -1 | 1): TabPrefs {
  const order = visibleTabs({ order: prefs.order, hidden: [] }).map((t) => t.id);
  const from = order.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return prefs;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return { ...prefs, order: next };
}

export function toggleTab(prefs: TabPrefs, id: ProjectView, visible: boolean): TabPrefs {
  const hidden = prefs.hidden.filter((h) => h !== id);
  return { ...prefs, hidden: visible ? hidden : [...hidden, id] };
}

export function loadTabPrefs(): TabPrefs {
  if (typeof window === "undefined") return DEFAULT_TAB_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TAB_PREFS;
    const parsed = JSON.parse(raw) as Partial<TabPrefs>;
    return {
      order: Array.isArray(parsed.order) ? parsed.order.filter(isView) : DEFAULT_TAB_PREFS.order,
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter(isView) : [],
    };
  } catch {
    return DEFAULT_TAB_PREFS;
  }
}

export function saveTabPrefs(prefs: TabPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable — the preference lasts for this page only.
  }
}
```

- [ ] **Step 4: Run to see it pass**: `npx vitest run tests/qa/project-tabs.test.ts` → 9 passed.
- [ ] **Step 5: Mutation check** — temporarily change `shown.length > 0 ? shown : …` to just `shown`; the all-hidden test must go red; restore.
- [ ] **Step 6: Commit**

```bash
git add lib/project-tabs.ts tests/qa/project-tabs.test.ts
git commit -m "feat(projects): a pure module for which tabs a person sees, and in what order

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task B2: The control, and the tab row reads from it

**Files:**
- Create: `components/project/tab-preferences.tsx`
- Modify: `app/projects/page.tsx` (`ProjectView` type at 51-54 → import; state at 101; tab row 293-313; dispatch 374-385)
- Test: `tests/qa/client-info-pane.test.ts` (one new rendered case in `describe("the tab row")`)

**Interfaces:**
- Consumes: everything from B1.
- Produces: `<TabPreferences prefs onChange />` rendering a button `aria-label="Customise tabs"`.

- [ ] **Step 1: Write the failing test** — add to `describe("the tab row")` in `tests/qa/client-info-pane.test.ts`:

```ts
it("honours a saved preference: List hidden, Client Info first", async () => {
  localStorage.setItem(
    "lumina:project-tabs",
    JSON.stringify({ order: ["client", "board", "files", "list"], hidden: ["list"] })
  );
  await renderProject(asUser(baseState(), "u_vlad"));

  const tabs = screen.getAllByRole("tab").map((t) => t.textContent?.trim());
  expect(tabs).toEqual(["Client Info", "Board", "Files"]);
  // The way to change it is on the row, and it is named.
  expect(screen.getByRole("button", { name: "Customise tabs" })).toBeInTheDocument();
});
```

(The two existing default-order tests stay exactly as they are; `afterEach` already clears `localStorage`.)

- [ ] **Step 2: Run to see it fail**: `npx vitest run tests/qa/client-info-pane.test.ts -t "saved preference"` → FAIL: received the default four.
- [ ] **Step 3: Write the control** — `components/project/tab-preferences.tsx`:

```tsx
"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DEFAULT_TAB_PREFS, PROJECT_TABS, moveTab, toggleTab, visibleTabs, type TabPrefs,
} from "@/lib/project-tabs";

/**
 * Which tabs this person sees on a project, and in what order.
 *
 * Arrows rather than drag, to match how Settings reorders board columns and to
 * keep a menu keyboard-operable. The last visible tab's checkbox is disabled so
 * the row cannot be emptied from here; `visibleTabs` falls back to the default
 * row anyway if the stored key is edited by hand.
 */
export function TabPreferences({
  prefs,
  onChange,
}: {
  prefs: TabPrefs;
  onChange: (next: TabPrefs) => void;
}) {
  const ordered = visibleTabs({ order: prefs.order, hidden: [] });
  const hidden = new Set(prefs.hidden);
  const shownCount = ordered.length - ordered.filter((t) => hidden.has(t.id)).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          // Icon-only: the name has to be explicit, a tooltip would not do it.
          aria-label="Customise tabs"
        >
          <SlidersHorizontal className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <p className="mb-2 text-xs font-medium">Tabs on this project</p>
        <ul className="flex flex-col gap-1">
          {ordered.map((tab, i) => {
            const visible = !hidden.has(tab.id);
            const lastVisible = visible && shownCount === 1;
            return (
              <li key={tab.id} className="flex items-center gap-2">
                <Checkbox
                  id={`tab-pref-${tab.id}`}
                  checked={visible}
                  disabled={lastVisible}
                  onCheckedChange={(v) => onChange(toggleTab(prefs, tab.id, v === true))}
                />
                <Label htmlFor={`tab-pref-${tab.id}`} className="flex-1 text-[13px]">
                  {tab.label}
                </Label>
                <Button
                  variant="ghost" size="icon" className="size-6"
                  disabled={i === 0}
                  aria-label={`Move ${tab.label} earlier`}
                  onClick={() => onChange(moveTab(prefs, tab.id, -1))}
                >
                  <ChevronUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost" size="icon" className="size-6"
                  disabled={i === ordered.length - 1}
                  aria-label={`Move ${tab.label} later`}
                  onClick={() => onChange(moveTab(prefs, tab.id, 1))}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          variant="link" size="sm" className="mt-2 h-auto p-0 text-xs"
          onClick={() => onChange(DEFAULT_TAB_PREFS)}
        >
          Reset to default
        </Button>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Remembered on this device. {PROJECT_TABS.length} tabs available.
        </p>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Wire the page** — `app/projects/page.tsx`:
  - delete the local `type ProjectView = …` and `import { type ProjectView, visibleTabs, loadTabPrefs, saveTabPrefs, type TabPrefs, DEFAULT_TAB_PREFS } from "@/lib/project-tabs";` plus `import { TabPreferences } from "@/components/project/tab-preferences";`
  - state, next to `view`:
    ```tsx
    const [prefs, setPrefs] = React.useState<TabPrefs>(DEFAULT_TAB_PREFS);
    React.useEffect(() => { setPrefs(loadTabPrefs()); }, []);
    const tabs = visibleTabs(prefs);
    // If the current tab has just been hidden, move to the first one shown
    // rather than showing a selected tab that is not in the row.
    React.useEffect(() => {
      if (!tabs.some((t) => t.id === view)) setView(tabs[0].id);
    }, [tabs, view]);
    const changePrefs = (next: TabPrefs) => { setPrefs(next); saveTabPrefs(next); };
    ```
  - the row: replace the four literal triggers with
    ```tsx
    <TabsList className="h-8">
      {tabs.map((tab) => (
        <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5 text-xs">
          {tab.label}
          {tab.id === "files" && project.attachments.length > 0 && (
            <Badge className="h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums">
              {project.attachments.length}
            </Badge>
          )}
        </TabsTrigger>
      ))}
    </TabsList>
    ```
    and, immediately after the `<Tabs>` element inside the same flex row: `<TabPreferences prefs={prefs} onChange={changePrefs} />`.
  - `setView(v as ProjectView)` and the dispatch chain are unchanged; the filter gate stays `(view === "board" || view === "list")`.

- [ ] **Step 5: Run the pane file, then typecheck and lint**

Run: `npx vitest run tests/qa/client-info-pane.test.ts > /tmp/b2.log 2>&1; echo EXIT=$?; npm run typecheck; npx eslint app/projects/page.tsx components/project/tab-preferences.tsx lib/project-tabs.ts`
Expected: EXIT=0, three default-order/preference tests green, no lint errors.

- [ ] **Step 6: Browser check** (start `lumina-dev`, sign in `owner`/`lumina24`, open a project): hide List and move Client Info first via the control, reload, the row keeps it; Reset restores Board, List, Client Info, Files. Run the unnamed-button sweep from the QA notes on the page: zero unnamed.
- [ ] **Step 7: Commit**

```bash
git add app/projects/page.tsx components/project/tab-preferences.tsx tests/qa/client-info-pane.test.ts
git commit -m "feat(projects): choose which tabs to show and their order, per device

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part C — Notes as a dated log

### Task C1: The `project_client_notes` migration

**Files:**
- Create: `supabase/migrations/20260916000200_client_notes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Notes become a log.
--
-- `project_client_info.notes` was one text box. What the case work needs is a
-- record of what was known when: each entry carries who wrote it and when,
-- set by the database rather than the client, and nothing can be edited or
-- removed afterwards — enforced here by having no update and no delete policy
-- at all, not by hiding buttons.
--
-- Modelled on `project_client_documents` (20260914000200): a child of the
-- project rather than of the info row, split-per-verb policies with
-- table-qualified columns, both restrictive gates, realtime publication.
--
-- ORDER MATTERS BELOW. The existing text is backfilled as each client's first
-- entry BEFORE the stamping trigger exists, so it keeps the row's real
-- `updated_at` and `updated_by`; created afterwards, the trigger would stamp
-- every backfilled entry with now() and a null author.
create table if not exists public.project_client_notes (
  id         text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  body       text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);

create index if not exists project_client_notes_project_idx
  on public.project_client_notes (project_id, created_at);

-- Backfill: one entry per client that had text.
insert into public.project_client_notes (id, project_id, body, created_at, created_by)
select 'n_' || replace(gen_random_uuid()::text, '-', ''),
       i.project_id, i.notes, i.updated_at, i.updated_by
from public.project_client_info i
where length(btrim(i.notes)) > 0
  and not exists (select 1 from public.project_client_notes n where n.project_id = i.project_id);

-- Now the trigger. The client never names itself or picks its time.
create or replace function public.stamp_client_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_at = now();
  new.created_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists project_client_notes_stamp on public.project_client_notes;
create trigger project_client_notes_stamp
  before insert on public.project_client_notes
  for each row execute function public.stamp_client_note();

alter table public.project_client_notes enable row level security;

drop policy if exists client_notes_read on public.project_client_notes;
create policy client_notes_read on public.project_client_notes
  for select to authenticated
  using (public.can_see_project(project_client_notes.project_id));

drop policy if exists client_notes_insert on public.project_client_notes;
create policy client_notes_insert on public.project_client_notes
  for insert to authenticated
  with check (
    public.can_see_project(project_client_notes.project_id)
    and not public.project_is_viewer_only(project_client_notes.project_id)
  );
-- No UPDATE and no DELETE policy, deliberately: an entry is a record.

do $$
declare t text;
begin
  foreach t in array array['project_client_notes'] loop
    execute format('drop policy if exists require_assurance on public.%I', t);
    execute format(
      'create policy require_assurance on public.%I as restrictive to authenticated '
      'using (public.session_is_assured()) with check (public.session_is_assured())', t);
    execute format('drop policy if exists require_password_change on public.%I', t);
    execute format(
      'create policy require_password_change on public.%I as restrictive to authenticated '
      'using (public.password_is_current()) with check (public.password_is_current())', t);
  end loop;
end
$$;

alter publication supabase_realtime add table public.project_client_notes;
alter table public.project_client_notes replica identity full;

-- The text box is gone. A dead column is written by the next person who
-- forgets it is dead.
alter table public.project_client_info drop column if exists notes;
```

- [ ] **Step 2: Apply to dev, regenerate types**

Run: `npx supabase db push && npm run db:types && grep -n "project_client_notes" lib/database.types.ts | head -3`
Expected: the table appears in the generated types; `notes` is gone from `project_client_info`.

- [ ] **Step 3: Confirm the gates and the backfill on dev**

Run: `npx vitest run --config vitest.rls.config.ts tests/rls/gate-coverage.test.ts > /tmp/c1.log 2>&1; echo EXIT=$?`
Expected: EXIT=0 (both gates present on the new table).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260916000200_client_notes.sql lib/database.types.ts
git commit -m "feat(client-info): notes become an append-only, database-stamped log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C2: Types, the seam, and the data path

**Files:**
- Modify: `lib/types.ts:259`, `lib/backend/types.ts` (`ClientInfoPatch`, `Backend`), `lib/backend/supabase/client-info.ts`, `lib/backend/supabase/hydrate.ts:86,114,156`, `lib/backend/supabase/mapping.ts:104,132,313-358,492,566-569`, `lib/backend/supabase/index.ts:373-384`, `lib/backend/local.ts:474-480`, `lib/store.tsx:2557` (`emptyClientInfo`), `components/project/client-info-pane.tsx:73` (`EMPTY`)
- Test: `tests/qa/supabase-mapping.test.ts`, `tests/qa/supabase-backend.test.ts:250-280` (`TABLES`)

**Interfaces:**
- Produces:
  ```ts
  // lib/types.ts
  export interface ClientNote { id: string; body: string; createdAt: number; createdBy: string | null }
  // ClientInfo.notes: ClientNote[]
  // lib/backend/types.ts
  addClientNote(projectId: string, note: ClientNote): Promise<void>;
  // ClientInfoPatch no longer has `notes`
  ```

- [ ] **Step 1: Write the failing mapping test** — in `tests/qa/supabase-mapping.test.ts` beside the client-info cases:

```ts
it("folds note rows into the client record, oldest first, and counts them in updatedAt", () => {
  const rows = baseRows();
  rows.clientNotes = [
    { id: "n_2", project_id: "p_website", body: "Second", created_at: "2026-09-16T09:10:00Z", created_by: "u_raz" },
    { id: "n_1", project_id: "p_website", body: "First",  created_at: "2026-09-15T14:32:00Z", created_by: null },
  ];
  const state = toAppState(rows);
  const client = state.projects.find((p) => p.id === "p_website")!.client!;
  expect(client.notes.map((n) => n.id)).toEqual(["n_1", "n_2"]);
  expect(client.notes[0]).toEqual({ id: "n_1", body: "First", createdAt: Date.parse("2026-09-15T14:32:00Z"), createdBy: null });
  expect(client.updatedAt).toBe(Date.parse("2026-09-16T09:10:00Z"));
});

it("CONTROL: a project with notes but no info row still gets a client record", () => {
  const rows = baseRows();
  rows.clientNotes = [
    { id: "n_1", project_id: "p_website", body: "Only a note", created_at: "2026-09-15T14:32:00Z", created_by: null },
  ];
  expect(toAppState(rows).projects.find((p) => p.id === "p_website")!.client).not.toBeNull();
});
```

(`baseRows()`/`toAppState` are whatever that file already uses to build `HydrateRows`; add `clientNotes: []` to its default.) Also add `"project_client_notes"` to the `TABLES` array in `tests/qa/supabase-backend.test.ts`.

- [ ] **Step 2: Run to see it fail**: `npx vitest run tests/qa/supabase-mapping.test.ts tests/qa/supabase-backend.test.ts` → FAIL (no `clientNotes`, `notes` typed as string, query plan short by one).
- [ ] **Step 3: Types** — `lib/types.ts`: add above `ClientInfo`:

```ts
/** One dated entry in a client's notes. Author and time are set by the
 *  database; nothing edits or removes an entry afterwards. */
export interface ClientNote {
  id: string;
  body: string;
  createdAt: number;
  /** Null when that account has since been removed. */
  createdBy: string | null;
}
```
and change `notes: string;` to `notes: ClientNote[];`. In `lib/backend/types.ts` remove `notes` from `ClientInfoPatch` (and add to its comment: "`notes` has its own method: a patch carrying the list would make two people adding notes a last-write-wins race") and add to `Backend`:

```ts
  /** Appends one note. The row's time and author are stamped by the
   *  database; the entry passed in carries the client's optimistic values. */
  addClientNote(projectId: string, note: ClientNote): Promise<void>;
```
Set `notes: []` in `emptyClientInfo()` (`lib/store.tsx`) and in `EMPTY` (`client-info-pane.tsx`).

- [ ] **Step 4: Supabase write** — `lib/backend/supabase/client-info.ts`: remove `notes` from `COLUMNS`; add

```ts
type ClientNoteInsert = Database["public"]["Tables"]["project_client_notes"]["Insert"];

/** Appends a note. `.select()` + `requireRows`, like every write here: a
 *  policy-filtered insert comes back as `error: null` with no rows. */
export async function addClientNote(
  client: LuminaClient,
  projectId: string,
  note: ClientNote
): Promise<void> {
  const row: ClientNoteInsert = { id: note.id, project_id: projectId, body: note.body };
  const result = await client.from("project_client_notes").insert(row).select("id");
  requireRows("adding that note", "you may only view this project", result);
}
```
and delegate in `lib/backend/supabase/index.ts` next to `setClientDocument`:
```ts
  async addClientNote(projectId: string, note: ClientNote): Promise<void> {
    return clientInfo.addClientNote(await this.client(), projectId, note);
  }
```
`lib/backend/local.ts`: `addClientNote(): Promise<void> { return Promise.resolve(); }`.

- [ ] **Step 5: Read path** — `hydrate.ts`: add `client.from("project_client_notes").select("*")` to the fan-out, destructure as `clientNotes`, unwrap as `clientNotes: unwrap("project_client_notes", clientNotes)`. `mapping.ts`: `export type ClientNoteRow = Row<"project_client_notes">;`, `clientNotes: ClientNoteRow[]` on `HydrateRows`, `const clientNotesByProject = groupBy(rows.clientNotes, (r) => r.project_id);`, pass `clientNotesByProject.get(p.id) ?? []` as a third argument, and in `toClientInfo(row, documentRows, noteRows)`:

```ts
  if (!row && documentRows.length === 0 && noteRows.length === 0) return null;
  const notes: ClientNote[] = noteRows
    .map((n) => ({ id: n.id, body: n.body, createdAt: toEpoch(n.created_at), createdBy: n.created_by }))
    .sort((a, b) => a.createdAt - b.createdAt);
  const stamps = [
    ...(row ? [toEpoch(row.updated_at)] : []),
    ...documentRows.map((d) => toEpoch(d.updated_at)),
    ...notes.map((n) => n.createdAt),
  ];
```
and set `notes` on the returned record (remove `notes: row?.notes ?? ""`).

- [ ] **Step 6: Typecheck and run the two files**

Run: `npm run typecheck && npx vitest run tests/qa/supabase-mapping.test.ts tests/qa/supabase-backend.test.ts tests/qa/client-info.test.ts tests/qa/client-info-pane.test.ts > /tmp/c2.log 2>&1; echo EXIT=$?`
Expected: typecheck reveals every remaining `notes: string` use (fix each — the pane's textarea is replaced in C4, so for now make it compile by rendering nothing in the Notes section); mapping/backend tests pass; `client-info.test.ts`'s `["notes", "…"]` row of the per-field table is deleted here (C3 replaces it).

- [ ] **Step 7: Commit**

```bash
git add lib/types.ts lib/backend lib/store.tsx components/project/client-info-pane.tsx tests/qa/supabase-mapping.test.ts tests/qa/supabase-backend.test.ts tests/qa/client-info.test.ts
git commit -m "feat(client-info): notes flow through the seam as dated entries

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C3: The store action

**Files:**
- Modify: `lib/store.tsx` (declare on `StoreValue` beside `setClientDocument`; implement beside it; export)
- Modify: `tests/qa/_support.ts:450-452,591` (`FailingBackend` + failing-op union)
- Test: `tests/qa/client-info.test.ts`

**Interfaces:**
- Produces: `addClientNote(projectId: string, body: string): Promise<boolean>` on `StoreValue`.

- [ ] **Step 1: Write the failing tests** — in `tests/qa/client-info.test.ts`, a new describe (using the file's existing `mount`, `run`, `asOwner`-style helpers and `FailingBackend`):

```ts
describe("adding a note", () => {
  it("appends an entry carrying the caller as author and a time", async () => {
    const { result } = await mount(asUser(baseState(), "u_vlad"));
    const before = Date.now();
    expect(await run(() => result.current.addClientNote("p_website", "Called, left a message."))).toBe(true);
    const notes = result.current.state.projects.find((p) => p.id === "p_website")!.client!.notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("Called, left a message.");
    expect(notes[0].createdBy).toBe("u_vlad");
    expect(notes[0].createdAt).toBeGreaterThanOrEqual(before);
  });

  it("refuses a blank note before any network call", async () => {
    const backend = new FailingBackend("addClientNote");
    const { result } = await mount(asUser(baseState(), "u_vlad"), backend);
    expect(await run(() => result.current.addClientNote("p_website", "   "))).toBe(false);
    expect(backend.calls).toHaveLength(0);
  });

  it("CONTROL: a real note does reach the backend", async () => {
    const backend = new FailingBackend("addClientNote");
    const { result } = await mount(asUser(baseState(), "u_vlad"), backend);
    await run(() => result.current.addClientNote("p_website", "Real"));
    expect(backend.calls.map((c) => c.op)).toContain("addClientNote");
  });

  it("rolls the entry back when the backend refuses", async () => {
    const { result } = await mount(asUser(baseState(), "u_vlad"), new FailingBackend("addClientNote"));
    expect(await run(() => result.current.addClientNote("p_website", "Lost?"))).toBe(false);
    expect(result.current.state.projects.find((p) => p.id === "p_website")!.client?.notes ?? []).toEqual([]);
  });

  it("refuses a viewer", async () => {
    // Same fixture the other viewer refusals in this file use: a restricted
    // project where u_maya is listed as a viewer.
    const state = restrictedWithViewer(asUser(baseState(), "u_maya"));
    const { result } = await mount(state);
    expect(await run(() => result.current.addClientNote("p_locked", "Nope"))).toBe(false);
  });

  it("keeps one project's notes off another", async () => {
    const { result } = await mount(asUser(baseState(), "u_vlad"));
    await run(() => result.current.addClientNote("p_website", "Only here"));
    expect(result.current.state.projects.find((p) => p.id === "p_mobile")!.client).toBeNull();
  });
});
```

(`restrictedWithViewer` = whatever helper the existing "refuses a viewer BEFORE any network call" test builds its state with; reuse it by name.)

- [ ] **Step 2: Run to see it fail**: `npx vitest run tests/qa/client-info.test.ts -t "adding a note"` → FAIL: `addClientNote` is not a function.
- [ ] **Step 3: Implement** — `lib/store.tsx`, on `StoreValue`:

```ts
  /** Appends a dated note to the client record. Refused for viewers and for
   *  blank text; the entry's author and time are the caller's, then the
   *  database's on the next reload. */
  addClientNote: (projectId: string, body: string) => Promise<boolean>;
```
implementation beside `setClientDocument`:
```ts
    const addClientNote: StoreValue["addClientNote"] = (projectId, body) => {
      if (!clientEditGuard(projectId)) return Promise.resolve(false);
      const text = body.trim();
      if (!text) {
        deny("Write something before adding a note.");
        return Promise.resolve(false);
      }
      const note: ClientNote = {
        id: uid("n"),
        body: text,
        createdAt: Date.now(),
        createdBy: stateRef.current?.currentUserId ?? null,
      };
      return commit(
        (s) => patchClient(s, projectId, (client) => ({ ...client, notes: [...client.notes, note] })),
        () => backend.addClientNote(projectId, note),
        { ok: () => true, failed: false, describe: "add that note" }
      );
    };
```
Add it to the exported value object. In `tests/qa/_support.ts` add `"addClientNote"` to the failing-op union and an override on `FailingBackend` shaped like `setClientDocument`'s.

- [ ] **Step 4: Run to see it pass**: `npx vitest run tests/qa/client-info.test.ts` → all green.
- [ ] **Step 5: Commit**

```bash
git add lib/store.tsx tests/qa/_support.ts tests/qa/client-info.test.ts
git commit -m "feat(client-info): addClientNote — optimistic, refused for viewers and blanks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C4: The pane renders the log

**Files:**
- Modify: `components/project/client-info-pane.tsx` (Notes section, lines ~470-494)
- Test: `tests/qa/client-info-pane.test.ts`

- [ ] **Step 1: Write the failing tests** — in `tests/qa/client-info-pane.test.ts`:

```ts
describe("notes as a log", () => {
  it("shows each entry with who wrote it and when, oldest first", async () => {
    const state = asUser(baseState(), "u_vlad");
    const withNotes: AppState = {
      ...state,
      projects: state.projects.map((p) => p.id !== "p_website" ? p : {
        ...p,
        client: {
          fullName: "", dateOfBirth: null, phone: "", email: "", address: "",
          superCompany: "", memberId: "", amount: null, currency: "AUD",
          diagnosis: "", lastDayOfWork: null, employerName: "", contractSigned: false,
          newPhone: "", newEmail: "", documents: {}, hasPassword: false,
          updatedAt: 0, updatedBy: null,
          notes: [
            { id: "n_2", body: "Bank statement received.", createdAt: Date.UTC(2026, 8, 16, 9, 10), createdBy: "u_maya" },
            { id: "n_1", body: "Called, left a message.", createdAt: Date.UTC(2026, 8, 15, 14, 32), createdBy: null },
          ],
        },
      }),
    };
    await renderProject(withNotes);
    await selectTab("Client Info");

    const entries = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(entries[0]).toContain("Called, left a message.");
    expect(entries[0]).toContain("Someone");           // unknown author is never a real colleague
    expect(entries[1]).toContain("Maya Chen");
    expect(entries[1]).toMatch(/16 Sep 2026/);
  });

  it("adds a note from the box and keeps the draft if the store refuses", async () => {
    await renderProject(asUser(baseState(), "u_vlad"));
    await selectTab("Client Info");
    const box = screen.getByLabelText("New note") as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(box, { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    });
    expect(screen.getByText("Couldn't save")).toBeInTheDocument();
    expect(box.value).toBe("   ");                     // not wiped

    await act(async () => {
      fireEvent.change(box, { target: { value: "Spoke to the fund." } });
      fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    });
    expect(screen.getByRole("listitem")).toHaveTextContent("Spoke to the fund.");
    expect(box.value).toBe("");
  });

  it("gives a viewer the entries and no box", async () => {
    // Same viewer fixture the existing "shows the record with no inputs at all" test uses.
    await renderProject(viewerState());
    await selectTab("Client Info");
    expect(screen.queryByLabelText("New note")).not.toBeInTheDocument();
  });
});
```
Also retarget the existing "retires a refusal" test from `getByLabelText("Notes")` to `getByLabelText("New note")`.

- [ ] **Step 2: Run to see it fail**: `npx vitest run tests/qa/client-info-pane.test.ts -t "notes as a log"` → FAIL: no "New note".
- [ ] **Step 3: Implement the section** — replace the Notes `<Section>` in `client-info-pane.tsx` with:

```tsx
        <Section title="Notes" aside={client.notes.length > 0 ? `${client.notes.length} ${client.notes.length === 1 ? "entry" : "entries"}` : undefined}>
          <ol className="flex flex-col gap-3">
            {client.notes.map((note) => {
              const author = note.createdBy ? state.users.find((u) => u.id === note.createdBy) : undefined;
              return (
                <li key={note.id} className="flex items-start gap-2.5">
                  {author ? (
                    <UserAvatar user={author} size="sm" className="mt-0.5" />
                  ) : (
                    <span className="mt-0.5 size-6 shrink-0 rounded-full bg-muted" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">{author?.name ?? "Someone"}</span>
                      {" · "}
                      <time dateTime={new Date(note.createdAt).toISOString()}>
                        {format(note.createdAt, "d MMM yyyy, HH:mm")}
                      </time>
                    </p>
                    <p className="whitespace-pre-wrap text-[13px]">{note.body}</p>
                  </div>
                </li>
              );
            })}
            {client.notes.length === 0 && (
              <li className="text-[13px] text-muted-foreground">No notes yet.</li>
            )}
          </ol>
          {canEdit && (
            <NoteComposer
              id={id("notes")}
              state={state("notes")}
              onSubmit={(body, keep) =>
                run("notes", () => addClientNote(project.id, body), keep)
              }
            />
          )}
        </Section>
```
and the composer, in the same file below `AmountField`:

```tsx
/**
 * The box a new note is typed into. Enter is a newline — this is the one
 * field meant for paragraphs — and Ctrl/Cmd+Enter or the button submits.
 * A refused note keeps its draft: wiping what somebody typed is the failure
 * the password field had, and this must not repeat it.
 */
function NoteComposer({
  id, state, onSubmit,
}: {
  id: string;
  state: SaveState;
  onSubmit: (body: string, keepDraft: () => void) => void;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const submit = () => {
    const el = ref.current;
    if (!el) return;
    const body = el.value;
    onSubmit(body, () => { if (el.value === "") el.value = body; });
    if (body.trim()) el.value = "";
  };
  return (
    <Field label="New note" htmlFor={id} state={state} className="mt-4">
      <Textarea
        ref={ref}
        id={id}
        className="min-h-24 text-[13px]"
        placeholder="What happened, and when."
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
        }}
      />
      <div className="mt-1.5 flex justify-end">
        <Button size="sm" onClick={submit}>Add note</Button>
      </div>
    </Field>
  );
}
```
Imports: `format` from `date-fns`, `UserAvatar` from `@/components/user-avatar`, `addClientNote` and `state` from `useStore()` at the top of `ClientInfoPane`.

- [ ] **Step 4: Run the pane file, typecheck, lint** — `npx vitest run tests/qa/client-info-pane.test.ts > /tmp/c4.log 2>&1; echo EXIT=$?; npm run typecheck; npx eslint components/project/client-info-pane.tsx` → all green.
- [ ] **Step 5: Browser check** on the demo: add a note, see your name and the time; hard refresh, it persists; sign in as `elena` (Guest) — entries visible, no box.
- [ ] **Step 6: Commit**

```bash
git add components/project/client-info-pane.tsx tests/qa/client-info-pane.test.ts
git commit -m "feat(client-info): the notes log on screen — author, time, and a box that keeps its draft

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C5: The database says no to editing, and the probe says no to outsiders

**Files:**
- Modify: `tests/rls/client-info.test.ts` (new describe), `tests/probes/client_probe.mjs`

- [ ] **Step 1: Write the live tests** — `tests/rls/client-info.test.ts`, using its existing `emails`, `projects`, `signInAs`:

```ts
describe("notes are a log", () => {
  const noteId = `n_rls_${stamp}`;

  it("CONTROL: the editor appends an entry, and the database names them as its author", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);
    const { data, error } = await them
      .from("project_client_notes")
      .insert({ id: noteId, project_id: projects.locked, body: "Called the fund.", created_by: ids.viewer })
      .select("id, created_by");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    // The request claimed the viewer wrote it. The trigger disagrees.
    expect(data![0].created_by).toBe(ids.editor);
  });

  it("REFUSES the editor an update of their own entry", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);
    const { data } = await them
      .from("project_client_notes").update({ body: "Rewritten" }).eq("id", noteId).select("id");
    expect(data ?? []).toHaveLength(0);
    const { data: still } = await serviceClient.from("project_client_notes").select("body").eq("id", noteId).single();
    expect(still?.body).toBe("Called the fund.");
  });

  it("REFUSES the editor a delete of their own entry", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);
    await them.from("project_client_notes").delete().eq("id", noteId);
    const { data } = await serviceClient.from("project_client_notes").select("id").eq("id", noteId);
    expect(data).toHaveLength(1);
  });

  it("REFUSES a viewer an insert", async () => {
    const them = await signInAs(emails.viewer, TEST_PASSWORD);
    const { data } = await them
      .from("project_client_notes")
      .insert({ id: `n_v_${stamp}`, project_id: projects.locked, body: "Nope" })
      .select("id");
    expect(data ?? []).toHaveLength(0);
  });

  it("REFUSES an outsider a read", async () => {
    const them = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await them.from("project_client_notes").select("*").eq("project_id", projects.locked);
    expect(data ?? []).toHaveLength(0);
  });

  it("CONTROL: a viewer on the project reads the log", async () => {
    const them = await signInAs(emails.viewer, TEST_PASSWORD);
    const { data } = await them.from("project_client_notes").select("id").eq("project_id", projects.locked);
    expect((data ?? []).map((r) => r.id)).toContain(noteId);
  });
});
```

- [ ] **Step 2: Add the probe checks** — in `tests/probes/client_probe.mjs`, after the document checks, with the file's `svc`, `as()`, `check()`:

```js
  // Notes hold the client's circumstances; an outsider gets none of them.
  const NOTE = `Case note ${stamp} - circumstances`;
  must("seed note", await svc.from("project_client_notes").insert({
    id: `n_probe_${stamp}`, project_id: PROJ, body: NOTE,
  }));
  const noteAsColleague = await colleague.from("project_client_notes").select("*").eq("project_id", PROJ);
  check("a colleague on another case cannot read this client's notes",
    (noteAsColleague.data ?? []).length === 0,
    (noteAsColleague.data ?? []).length ? "LEAKED" : "hidden");
  const noteAsEditor = await editor.from("project_client_notes").select("body").eq("project_id", PROJ);
  check("CONTROL: the case's editor reads them",
    (noteAsEditor.data ?? []).some((n) => n.body === NOTE));
  const rewrite = await editor.from("project_client_notes").update({ body: "x" }).eq("id", `n_probe_${stamp}`).select("id");
  check("nobody, editor included, can rewrite a note", (rewrite.data ?? []).length === 0);
```

- [ ] **Step 3: Run both, read exit codes**

Run: `npx vitest run --config vitest.rls.config.ts tests/rls/client-info.test.ts > /tmp/c5.log 2>&1; echo EXIT=$?; node tests/probes/client_probe.mjs; echo PROBE_EXIT=$?`
Expected: both 0. If `fetch failed` appears, the dev project is unreachable — check connectivity before touching SQL.

- [ ] **Step 4: Mutation check** — on dev only, `create policy tmp on public.project_client_notes for update to authenticated using (true) with check (true);` via the SQL editor, re-run the update test and watch it go red, then `drop policy tmp …`.
- [ ] **Step 5: Commit**

```bash
git add tests/rls/client-info.test.ts tests/probes/client_probe.mjs
git commit -m "test(client-info): notes cannot be edited, deleted, or read by the wrong person

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C6: The runbook

**Files:**
- Modify: `docs/runbooks/client-info.md` (the Notes paragraph)

- [ ] **Step 1: Rewrite the Notes section**

```markdown
### Notes

Notes are a log, not a text box. Type what happened in **New note** and press
**Add note** (or Ctrl/Cmd+Enter); the entry appears with your name and the time,
both set by the database rather than typed. Enter is a new line.

**An entry cannot be edited or deleted once added — by anyone, through the app
or the API.** That is enforced by the database having no update and no delete
rule for notes at all, and it is what makes the log a record of what was known
when. Mistyped something? Add a correcting note.

Text that was in the old single Notes box became each client's first entry,
carrying the date it was last saved and who saved it.

Viewers see the log and have no box.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/client-info.md
git commit -m "docs(client-info): notes are a log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part D — The all-tasks board

### Task D1: `TaskFilters`, shared by both pages

**Files:**
- Create: `components/kanban/task-filters.tsx`
- Modify: `app/projects/page.tsx` (lines 315-372, the filter cluster)

**Interfaces:**
- Produces:
  ```tsx
  export function TaskFilters(props: {
    assignee: string; onAssignee: (v: string) => void;   // "all" | "unassigned" | userId
    priority: string; onPriority: (v: string) => void;   // "all" | Priority
  }): JSX.Element;
  export function applyTaskFilters(tasks: Task[], assignee: string, priority: string): Task[];
  ```

- [ ] **Step 1: Write the failing test** — `tests/qa/task-filters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyTaskFilters } from "@/components/kanban/task-filters";
import { baseState } from "./_support";

describe("applyTaskFilters", () => {
  const tasks = baseState().tasks;
  it("passes everything through on all/all", () => {
    expect(applyTaskFilters(tasks, "all", "all")).toHaveLength(tasks.length);
  });
  it("narrows to one person, owner or collaborator", () => {
    const mine = applyTaskFilters(tasks, "u_maya", "all");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.assigneeId === "u_maya" || t.collaboratorIds.includes("u_maya"))).toBe(true);
  });
  it("narrows to the unassigned and to a priority", () => {
    expect(applyTaskFilters(tasks, "unassigned", "all").every((t) => t.assigneeId === null)).toBe(true);
    expect(applyTaskFilters(tasks, "all", "high").every((t) => t.priority === "high")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see it fail** → cannot find module.
- [ ] **Step 3: Implement** — move the two `<Select>`s and the filtering expression from `app/projects/page.tsx` into `components/kanban/task-filters.tsx`:

```tsx
"use client";

import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isMine } from "@/lib/permissions";
import { useStore } from "@/lib/store";
import { PRIORITIES, PRIORITY_META, type Task } from "@/lib/types";

/** The two narrowing controls a board or list shows above its tasks. */
export function applyTaskFilters(tasks: Task[], assignee: string, priority: string): Task[] {
  return tasks.filter(
    (t) =>
      (assignee === "all" ||
        (assignee === "unassigned" ? t.assigneeId === null : isMine(t, assignee))) &&
      (priority === "all" || t.priority === priority)
  );
}

export function TaskFilters({
  assignee, onAssignee, priority, onPriority,
}: {
  assignee: string; onAssignee: (v: string) => void;
  priority: string; onPriority: (v: string) => void;
}) {
  const { state } = useStore();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={assignee} onValueChange={onAssignee}>
        <SelectTrigger className="h-8 w-40 text-xs" aria-label="Filter by person">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Everyone</SelectItem>
          <SelectItem value="unassigned">Unassigned</SelectItem>
          {state.users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={priority} onValueChange={onPriority}>
        <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter by priority">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any priority</SelectItem>
          {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
```
In `app/projects/page.tsx`, replace the inline selects with `<TaskFilters assignee={assigneeFilter} onAssignee={setAssigneeFilter} priority={priorityFilter} onPriority={setPriorityFilter} />` and the inline filter with `const tasks = applyTaskFilters(allTasks, assigneeFilter, priorityFilter);`. Keep whatever labels/copy the page's selects had if they differ from the above — the test is on `applyTaskFilters`, not the copy.

- [ ] **Step 4: Run** `npx vitest run tests/qa/task-filters.test.ts tests/qa/projects-page-collaborators.test.ts` → green (the collaborators test exercises the person filter through the page).
- [ ] **Step 5: Commit**

```bash
git add components/kanban/task-filters.tsx app/projects/page.tsx tests/qa/task-filters.test.ts
git commit -m "refactor(kanban): the task filters are one component, shared

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task D2: A board that need not belong to one project

**Files:**
- Modify: `components/kanban/board.tsx:118-133,170-178,186-190`, `components/kanban/task-card.tsx:17-28,133-146`
- Test: `tests/qa/board-cross-project.test.ts`

**Interfaces:**
- Produces:
  ```tsx
  // Board
  { project?: Project; tasks: Task[]; viewerOnly?: boolean;
    readOnly?: (task: Task) => boolean;      // per-task, for mixed boards
    label?: (task: Task) => string | undefined } // rendered "label - title"
  // TaskCardContent / SortableTaskCard gain `label?: string`
  ```

- [ ] **Step 1: Write the failing test** — `tests/qa/board-cross-project.test.ts` (one render):

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { Board } from "@/components/kanban/board";
import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { STORAGE_KEY, asUser, baseState, installMenuShims, renderHydrated } from "./_support";

installMenuShims();
const h = React.createElement;

describe("a board with no single project", () => {
  it("labels every card with its project, offers no add buttons, and marks read-only cards", async () => {
    const state = asUser(baseState(), "u_vlad");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const nameOf = (t: { projectId: string }) => state.projects.find((p) => p.id === t.projectId)?.name;
    await renderHydrated(
      h(StoreProvider, null, h(TooltipProvider, null, h(UIProvider, null,
        h(Board, {
          tasks: state.tasks,
          label: nameOf,
          readOnly: (t) => t.projectId === "p_mobile",
        })
      )))
    );
    // Every card carries "Project - Title".
    const first = state.tasks[0];
    expect(screen.getByText(new RegExp(`${nameOf(first)} - ${first.title}`))).toBeInTheDocument();
    // No project, no "Add a task to …".
    expect(screen.queryAllByRole("button", { name: /^Add a task to/ })).toHaveLength(0);
    // Read-only cards are not draggable (dnd-kit sets aria-disabled on the handle).
    const mobile = state.tasks.find((t) => t.projectId === "p_mobile")!;
    const card = screen.getByText(new RegExp(mobile.title)).closest("[aria-roledescription='sortable']");
    expect(card).toHaveAttribute("aria-disabled", "true");
  });
});
```
(If the existing sortable cards expose disabled state differently, assert on that — the point is the card is not draggable; check `task-card.tsx` for how `disabled` reaches the DOM.)

- [ ] **Step 2: Run to see it fail** → FAIL on the label text / type error on `project` missing.
- [ ] **Step 3: Implement**
  - `task-card.tsx`: add `label?: string` to `TaskCardContent` and `SortableTaskCard` props (pass through), and render the title line as
    ```tsx
    <p className={cn("text-[13px] leading-snug", done && "line-through text-muted-foreground")}>
      {label && <span className="text-muted-foreground">{label} - </span>}
      {task.title}
    </p>
    ```
  - `board.tsx`: props `project?: Project; readOnly?: (task: Task) => boolean; label?: (task: Task) => string | undefined;`. `Column` receives `project?: Project` and renders the add button only when `project && canCreate`; each card gets `disabled={!canMove || readOnly?.(task) === true}` and `label={label?.(task)}`; the `DragOverlay` copy gets `label={label?.(dnd.activeTask)}`.
- [ ] **Step 4: Run** `npx vitest run tests/qa/board-cross-project.test.ts tests/qa/accessible-names.test.ts tests/qa/drag-moves.test.ts` → green (the accessible-names test still passes `project`, so its five add buttons remain).
- [ ] **Step 5: Commit**

```bash
git add components/kanban/board.tsx components/kanban/task-card.tsx tests/qa/board-cross-project.test.ts
git commit -m "feat(kanban): a board may span projects — optional project, per-card label and read-only

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task D3: Ordering across projects

**Files:**
- Modify: `components/kanban/use-task-dnd.ts`
- Test: `tests/qa/task-dnd-cross-project.test.ts`

**Interfaces:**
- Produces: `useTaskDnd(tasks, opts?: { crossProject?: boolean; projectName?: (task: Task) => string })` plus two exported pure helpers:
  ```ts
  export function orderColumn(tasks: Task[], crossProject: boolean, projectName: (t: Task) => string): Task[];
  export function indexWithinProject(destination: Task[], task: Task, dropIndex: number): number;
  ```

- [ ] **Step 1: Write the failing tests** — `tests/qa/task-dnd-cross-project.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { indexWithinProject, orderColumn } from "@/components/kanban/use-task-dnd";
import type { Task } from "@/lib/types";

const t = (id: string, projectId: string, order: number): Task =>
  ({ id, projectId, order, status: "todo", title: id, collaboratorIds: [], assigneeId: null } as unknown as Task);
const name = (x: Task) => ({ p_b: "Beta", p_a: "Alpha" }[x.projectId] ?? x.projectId);

describe("orderColumn", () => {
  it("in one project, sorts by order — exactly as before", () => {
    expect(orderColumn([t("x", "p_a", 2), t("y", "p_a", 0)], false, name).map((x) => x.id)).toEqual(["y", "x"]);
  });
  it("across projects, groups by project name and keeps each project's order inside the group", () => {
    const col = [t("b1", "p_b", 0), t("a2", "p_a", 1), t("b0", "p_b", 1), t("a1", "p_a", 0)];
    expect(orderColumn(col, true, name).map((x) => x.id)).toEqual(["a1", "a2", "b1", "b0"]);
  });
});

describe("indexWithinProject", () => {
  // `order` is dense only within project+status, so the index moveTask needs
  // is the position among the SAME project's tasks in the destination.
  const dest = [t("a1", "p_a", 0), t("a2", "p_a", 1), t("b1", "p_b", 0)];
  it("counts only the task's own project's cards before the drop point", () => {
    expect(indexWithinProject(dest, t("a9", "p_a", 5), 0)).toBe(0);
    expect(indexWithinProject(dest, t("a9", "p_a", 5), 1)).toBe(1);
    expect(indexWithinProject(dest, t("a9", "p_a", 5), 3)).toBe(2);
  });
  it("appends when the project has nothing in that column yet", () => {
    expect(indexWithinProject(dest, t("c1", "p_c", 0), 1)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to see it fail** → not exported.
- [ ] **Step 3: Implement** — in `use-task-dnd.ts`:

```ts
/** A column's cards in display order. Within one project that is `order`;
 *  across projects it is project name, then `order`, so a client's cards sit
 *  together and no two projects' 0,1,2… interleave. */
export function orderColumn(
  tasks: Task[], crossProject: boolean, projectName: (t: Task) => string
): Task[] {
  const byOrder = (a: Task, b: Task) => a.order - b.order;
  if (!crossProject) return [...tasks].sort(byOrder);
  return [...tasks].sort((a, b) => projectName(a).localeCompare(projectName(b)) || byOrder(a, b));
}

/** The index `moveTask` applies is within the task's own project's slice of
 *  the destination column. A drop index computed over a merged column is not
 *  that number. */
export function indexWithinProject(destination: Task[], task: Task, dropIndex: number): number {
  return destination
    .slice(0, Math.max(0, dropIndex))
    .filter((t) => t.projectId === task.projectId && t.id !== task.id).length;
}
```
Then thread an options argument: `export function useTaskDnd(tasks: Task[], opts: { crossProject?: boolean; projectName?: (t: Task) => string } = {})`; use `orderColumn(...)` where `byStatus` groups are sorted; and in the drop handler, before calling `moveTask(id, toStatus, index)`, compute `index = opts.crossProject ? indexWithinProject(byStatus[toStatus] ?? [], task, rawIndex) : rawIndex`. The single-project path must be byte-for-byte the previous behaviour.

- [ ] **Step 4: Run** `npx vitest run tests/qa/task-dnd-cross-project.test.ts tests/qa/drag-moves.test.ts tests/qa/task-ordering.test.ts` → green.
- [ ] **Step 5: Commit**

```bash
git add components/kanban/use-task-dnd.ts tests/qa/task-dnd-cross-project.test.ts
git commit -m "feat(kanban): cross-project ordering — group by project, index within it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task D4: The page, and how to reach it

**Files:**
- Create: `app/tasks/page.tsx`
- Modify: `lib/routes.ts`, `components/app-shell.tsx:362-418`, `components/command-palette.tsx:85-131`
- Test: `tests/qa/all-tasks-page.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/qa/all-tasks-page.test.ts` (one render per case, two cases):

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import * as React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/tasks",
}));

import AllTasksPage from "@/app/tasks/page";
import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { STORAGE_KEY, addProject, addTask, asUser, baseState, installMenuShims, renderHydrated } from "./_support";
import type { AppState } from "@/lib/types";

installMenuShims();
const h = React.createElement;

async function renderAs(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  await renderHydrated(h(StoreProvider, null, h(TooltipProvider, null, h(UIProvider, null, h(AllTasksPage)))));
}

/** A restricted project u_maya is not on, with one task in it. */
function withSecret(state: AppState): AppState {
  let s = addProject(state, { id: "p_secret", name: "Secret Case", createdBy: "u_vlad", restricted: true, members: [] });
  s = addTask(s, { id: "t_secret", projectId: "p_secret", title: "Hidden work" });
  return s;
}

describe("the all-tasks board", () => {
  it("shows every visible project's tasks as 'Project - Task', and not one the person cannot see", async () => {
    await renderAs(withSecret(asUser(baseState(), "u_maya")));
    const website = baseState().tasks.find((t) => t.projectId === "p_website")!;
    expect(screen.getByText(new RegExp(`Website Redesign - ${website.title}`))).toBeInTheDocument();
    expect(screen.queryByText(/Hidden work/)).not.toBeInTheDocument();
  });

  it("CONTROL: an admin sees the restricted project's task too", async () => {
    await renderAs(withSecret(asUser(baseState(), "u_vlad")));
    expect(screen.getByText(/Secret Case - Hidden work/)).toBeInTheDocument();
  });
});
```
(Check `addProject`/`addTask` parameter names in `tests/qa/_support.ts:103-160` and adjust the object keys to match.)

- [ ] **Step 2: Run to see it fail** → cannot find `@/app/tasks/page`.
- [ ] **Step 3: The route and the page** — `lib/routes.ts`: `export const allTasksHref = "/tasks";`. `app/tasks/page.tsx`:

```tsx
"use client";

import * as React from "react";

import { Board } from "@/components/kanban/board";
import { TaskFilters, applyTaskFilters } from "@/components/kanban/task-filters";
import { canUserSeeTaskProject, useStore } from "@/lib/store";

/**
 * Every task the person can see, across every project, on one board.
 *
 * Same six columns as a project board — statuses are workspace-wide — with
 * each card prefixed by its project. No per-column add buttons, because there
 * is no project to add to; open a card to reach its project. Cards from a
 * project this person may only view are not draggable, and the store refuses
 * the move anyway if the screen is wrong about that.
 */
export default function AllTasksPage() {
  const { state, currentUser, projectAccessLevel } = useStore();
  const [assignee, setAssignee] = React.useState("all");
  const [priority, setPriority] = React.useState("all");

  const visible = state.tasks.filter((t) => canUserSeeTaskProject(state, t, currentUser.id));
  const tasks = applyTaskFilters(visible, assignee, priority);
  const projectOf = (t: { projectId: string }) => state.projects.find((p) => p.id === t.projectId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-6 pt-5 pb-3">
        <h1 className="text-base font-semibold">All tasks</h1>
        <p className="text-xs text-muted-foreground">
          {visible.length} across {new Set(visible.map((t) => t.projectId)).size} projects
        </p>
        <div className="mt-3">
          <TaskFilters assignee={assignee} onAssignee={setAssignee} priority={priority} onPriority={setPriority} />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <Board
          tasks={tasks}
          label={(t) => projectOf(t)?.name}
          readOnly={(t) => {
            const p = projectOf(t);
            return !p || projectAccessLevel(p) === "viewer";
          }}
          crossProject
        />
      </div>
    </div>
  );
}
```
Add a `crossProject?: boolean` prop to `Board` that it passes to `useTaskDnd(tasks, { crossProject, projectName: (t) => label?.(t) ?? "" })`.

- [ ] **Step 4: Nav and palette** — `components/app-shell.tsx`, after the Home `NavLink`:
```tsx
  <NavLink href={allTasksHref} active={pathname === "/tasks"} onNavigate={onNavigate}>
    <CheckSquare className="size-4" />
    All tasks
  </NavLink>
```
(import `CheckSquare` from `lucide-react` and `allTasksHref` from `@/lib/routes`). `components/command-palette.tsx`, after the Settings item in "Go to":
```tsx
  <CommandItem onSelect={() => run(() => router.push(allTasksHref))}>
    <CheckSquare />
    All tasks
    <CommandShortcut>G T</CommandShortcut>
  </CommandItem>
```
(wire `G T` the same way `G H`/`G P` are wired in that file).

- [ ] **Step 5: Run, typecheck, lint, then the whole unit suite with exit code**

Run: `npx vitest run tests/qa/all-tasks-page.test.ts && npm run typecheck && npm run lint && npm test > /tmp/d4.log 2>&1; echo EXIT=$?`
Expected: all green; `accessible-names.test.ts` still green (the new nav link has text, so it is not icon-only).

- [ ] **Step 6: Browser check** on the demo: All tasks in the sidebar; cards from both seeded projects prefixed with their names; drag one to Pending Payout and see it move; the board at 375px scrolls horizontally like a project board; the unnamed-button sweep finds zero.
- [ ] **Step 7: Commit**

```bash
git add app/tasks/page.tsx lib/routes.ts components/app-shell.tsx components/command-palette.tsx components/kanban/board.tsx tests/qa/all-tasks-page.test.ts
git commit -m "feat(tasks): one board of every task across every project

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part E — Ship it

### Task E1: Full verification against dev

- [ ] **Step 1: Every gate, exit codes read**

```bash
npm run typecheck; echo TC=$?
npm run lint; echo LINT=$?
npm test > /tmp/e-unit.log 2>&1; echo UNIT=$?
npm run test:rls > /tmp/e-rls.log 2>&1; echo RLS=$?
npm run probes > /tmp/e-probes.log 2>&1; echo PROBES=$?
grep -E "Tests |PASSED|FAILED|NO CHECKS" /tmp/e-unit.log /tmp/e-rls.log /tmp/e-probes.log
```
Expected: all 0 (the unit reporter timeout is the one tolerated non-zero, and only with zero `×` lines). If the RLS suite fails on `fetch failed`, the dev project is unreachable; check `curl` against its REST URL before reading it as a policy failure.

### Task E2: Production

- [ ] **Step 1: Migrations first.** Ask the user to run, or run if permitted:
```bash
npx supabase link --project-ref eshstdmgceohizbevwll
npx supabase migration list --linked      # exactly 20260916000100 and 20260916000200 pending
npx supabase db push
npx supabase link --project-ref nsioivydefazicxnozqw
```
then confirm `supabase/.temp/project-ref` reads `nsioivydefazicxnozqw`. State plainly before pushing: **any Backlog task on production moves to To Do, and each client's notes text becomes their first log entry.**
- [ ] **Step 2: The user runs `git push`.** Watch the Pages workflow with `gh run watch`, read its exit status.
- [ ] **Step 3: Verify the live site**: it loads with no console errors; the projects route's chunks contain `New note`, `Pending Payout (From Super)` and `Customise tabs`, with a nonsense-string control absent; the tasks route's chunks contain `All tasks`. Then ask the user to open a project on the live site and confirm the six columns and the notes log.
- [ ] **Step 4: Memory.** Record in `lumina-project.md`: six columns and their ids, notes are an append-only table, the tab-preference key, the `/tasks` route, and the cross-project index rule.

---

## Self-review

- **Spec coverage:** decision 1 → C1–C6; decision 2 → B1–B2; decision 3 → A1–A3; decision 4 → D1–D4; deploy → E. Global constraints → each task's exit-code steps and the CONTROL tests.
- **Placeholders:** none of the forbidden phrases; every code step has code. Two places tell the executor to check a helper's exact parameter names (`addTask`/`addProject`, `restrictedWithViewer`/`viewerState`) because those helpers exist and their shapes must be read, not guessed.
- **Type consistency:** `ClientNote { id, body, createdAt, createdBy }` is used identically in C2, C3, C4 and the mapping test; `addClientNote(projectId, note)` on the seam vs `addClientNote(projectId, body)` on the store is deliberate and matches `setClientDocument`'s split; `ProjectView` now lives in `lib/project-tabs.ts` and `app/projects/page.tsx` imports it; `orderColumn`/`indexWithinProject` names match between D3's test and implementation; `label`/`readOnly`/`crossProject` props match between D2, D3 and D4.
