# Lumina Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Supabase backend for Lumina — full schema, Row Level Security, and invariant enforcement — proven by an automated policy test suite, while the shipped app continues to run unchanged on localStorage.

**Architecture:** Postgres tables mirroring `lib/types.ts`, with nested arrays unnested into their own tables so RLS can guard them, a `conversations` parent so messages get one real foreign key, and per-user `read_state`. All access decisions live in RLS policies backed by `SECURITY DEFINER` helper functions; four business invariants that policies cannot express become triggers. No client code changes in this plan: the app keeps using localStorage until Plan 2 swaps the store.

**Tech Stack:** Supabase (Postgres 15, Auth, CLI), Vitest, TypeScript strict, Next.js 15 static export, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-06-lumina-production-design.md`

## Global Constraints

- **No Docker on this machine.** Never use `supabase start`, `supabase db reset`, or any local-stack command. All CLI work is remote: `supabase link`, `supabase db push`, `supabase gen types`.
- **Two Supabase projects**, both free tier: `lumina-dev` (tests run here) and `lumina-prod` (untouched until Plan 4).
- **The `service_role` key never enters `app/`, `components/`, or `lib/`.** It appears only in `.env.test.local`, which is gitignored. Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` may reach client code.
- **Every table gets `enable row level security`.** A table without RLS is readable by anyone holding the anon key. There are no exceptions in this plan.
- **Every policy helper that queries a table which itself has RLS must be `SECURITY DEFINER`** with `set search_path = public`. A policy on `channel_members` that selects from `channel_members` recurses infinitely; this is the single most common way to break a Supabase schema.
- **Ids are client-generated prefixed text** (`c_`, `p_`, `t_`, `m_`, `d_`, `r_`, `att_`, `a_`), matching `uid()` at `lib/store.tsx:31`. The one exception is `profiles.id`, a uuid equal to `auth.users.id`.
- **Permission strings** are exactly the 11 in `lib/types.ts:1-12`: `channel.create`, `channel.delete`, `project.create`, `project.delete`, `task.create`, `task.edit`, `task.move`, `task.delete`, `message.send`, `message.deleteAny`, `members.manage`.
- **Task statuses** are exactly `backlog`, `todo`, `in-progress`, `in-review`, `done` (`lib/types.ts:87-93`). **Priorities** are exactly `high`, `medium`, `low` (`lib/types.ts:96`).
- **Timestamps are `timestamptz`** in Postgres. The client uses epoch milliseconds; conversion happens in Plan 2, not here.
- **The task ordering column is named `position`, never `order`.** `order` is a SQL
  reserved word and collides with PostgREST's `order` query parameter. `Task.order` in
  `lib/types.ts:118` maps to `tasks.position`; Plan 2 does that translation.
- Node 24, npm. Existing scripts in `package.json` must keep working.

## Human prerequisite — blocks Task 3 onward

Tasks 1 and 2 can start immediately. **Tasks 3-8 cannot begin until a human does this**, because it requires creating an account and cannot be automated:

1. Sign up at supabase.com and create an organisation.
2. Create two free projects: `lumina-dev` and `lumina-prod`. Save the database password for each.
3. For **`lumina-dev`**, from Project Settings → API, copy: the Project URL, the `anon` public key, the `service_role` secret key, and from Settings → General the Project Reference ID.
4. Hand those four `lumina-dev` values to the implementer. `lumina-prod` values are not needed until Plan 4.

---

### Task 1: Test harness and CI gates

Nothing in this repo is tested and CI runs neither typecheck nor lint. This lands first so every later task has a safety net.

**Files:**
- Modify: `package.json` (scripts + devDependencies)
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `tests/sanity.test.ts`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` (Vitest, single run), `npm run test:watch`, `npm run typecheck` (`tsc --noEmit`). Test files live under `tests/` and may import app code via the `@/` alias.

- [ ] **Step 1: Install test dependencies**

```bash
npm install -D vitest@^3 @vitest/coverage-v8@^3 dotenv@^17
```

- [ ] **Step 2: Write the Vitest config**

Create `vitest.config.ts`. The `@/` alias must mirror `tsconfig.json` `paths` so tests can import app modules. `pool: "forks"` avoids a known Windows worker-thread issue.

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
```

- [ ] **Step 3: Write the setup file**

Create `tests/setup.ts`. It loads `.env.test.local` so later tasks get Supabase credentials; it must not fail when that file is absent, because Task 1 and 2 tests do not need it.

```ts
import { config } from "dotenv";

config({ path: ".env.test.local", quiet: true });
```

- [ ] **Step 4: Write the failing sanity test**

Create `tests/sanity.test.ts`. This proves the harness and the `@/` alias both work.

```ts
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "@/lib/permissions";

describe("test harness", () => {
  it("resolves the @/ alias into app code", () => {
    expect(ALL_PERMISSIONS).toContain("members.manage");
  });

  it("has exactly the 11 permissions the schema will encode", () => {
    expect(ALL_PERMISSIONS).toHaveLength(11);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `npm error Missing script: "test"`, because Step 6 has not added it yet.

- [ ] **Step 6: Add the scripts**

Modify `package.json`, adding to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 2 tests. If the alias fails to resolve, the `resolve.alias` path in `vitest.config.ts` is wrong.

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 8: Add CI gates**

Modify `.github/workflows/deploy.yml`. Insert these three steps in the `build` job **between** `- run: npm ci` and `- run: npm run build`, so a broken typecheck, lint, or test blocks the deploy:

```yaml
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
```

- [ ] **Step 9: Verify the whole gate sequence locally**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all four succeed. This is exactly what CI will now run.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/ .github/workflows/deploy.yml
git commit -m "test: add Vitest harness and CI typecheck/lint/test gates

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Error boundaries and environment template

A thrown render error currently blanks the screen with no recovery. Next.js only picks up error boundaries at these exact filenames.

**Files:**
- Create: `app/error.tsx`
- Create: `app/global-error.tsx`
- Create: `.env.example`
- Create: `tests/error-boundary.test.ts`

**Interfaces:**
- Consumes: `Button` from `@/components/ui/button`.
- Produces: nothing other tasks import. `.env.example` documents the two public variables Plan 2 will consume.

- [ ] **Step 1: Write the failing test**

Create `tests/error-boundary.test.ts`. These files are React Server Component boundaries, so rather than render them, assert they exist with the contract Next.js requires — a default export and the `reset` prop.

```ts
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("error boundaries", () => {
  it("defines a route-level error boundary", () => {
    expect(existsSync("app/error.tsx")).toBe(true);
    const src = readFileSync("app/error.tsx", "utf8");
    expect(src).toContain('"use client"');
    expect(src).toContain("export default function");
    expect(src).toContain("reset");
  });

  it("defines a global error boundary with its own html shell", () => {
    expect(existsSync("app/global-error.tsx")).toBe(true);
    const src = readFileSync("app/global-error.tsx", "utf8");
    expect(src).toContain('"use client"');
    expect(src).toContain("<html");
    expect(src).toContain("<body");
  });

  it("documents the public Supabase variables", () => {
    expect(existsSync(".env.example")).toBe(true);
    const src = readFileSync(".env.example", "utf8");
    expect(src).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(src).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/error-boundary.test.ts`
Expected: FAIL — all three, `expected false to be true`.

- [ ] **Step 3: Write the route error boundary**

Create `app/error.tsx`. It renders inside the app shell, so it only needs the panel.

```tsx
"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
        <TriangleAlert className="size-6 text-amber-600 dark:text-amber-400" />
      </div>
      <div>
        <h2 className="text-base font-semibold">Something went wrong</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          This part of Lumina failed to load. Your data is safe.
        </p>
        {error.digest && (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{error.digest}</p>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Write the global error boundary**

Create `app/global-error.tsx`. This one replaces the whole document when the root layout itself throws, so it must supply its own `<html>` and `<body>` and cannot rely on app CSS.

```tsx
"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          margin: 0,
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Lumina failed to start</h2>
          <p style={{ fontSize: "0.875rem", color: "#666", marginBottom: "1rem" }}>
            Reload the page. If this keeps happening, clear the site data for this domain.
          </p>
          <button
            onClick={reset}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "1px solid #ccc",
              background: "white",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Write the environment template**

Create `.env.example`. `.gitignore` already excludes `.env*`, so this file must be force-added in Step 8.

```bash
# Supabase — public values, safe to ship in the browser bundle.
# Injected at build time by .github/workflows/deploy.yml from repository secrets.
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Tests only. Copy to .env.test.local and fill from the lumina-dev project.
# NEVER import these in app/, components/, or lib/ — the service role key
# bypasses every Row Level Security policy.
# SUPABASE_URL=https://your-dev-ref.supabase.co
# SUPABASE_ANON_KEY=your-dev-anon-key
# SUPABASE_SERVICE_ROLE_KEY=your-dev-service-role-key
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/error-boundary.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Verify the build still exports**

Run: `npm run build`
Expected: success. `/_error` may appear in the route list; that is correct.

- [ ] **Step 8: Commit**

`.env.example` needs `-f` because `.gitignore` excludes `.env*`.

```bash
git add app/error.tsx app/global-error.tsx tests/error-boundary.test.ts
git add -f .env.example
git commit -m "feat: add error boundaries and env template

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Supabase wiring and test client helpers

**Requires the human prerequisite above.** Links the repo to `lumina-dev` and builds the helpers every later task's tests depend on.

**Files:**
- Modify: `package.json` (devDependency + scripts)
- Create: `.env.test.local` (gitignored, never committed)
- Create: `supabase/config.toml` (generated by `supabase init`)
- Create: `lib/database.types.ts` (generated)
- Create: `lib/supabase.ts`
- Create: `tests/helpers/supabase.ts`
- Create: `tests/helpers/supabase.test.ts`

**Interfaces:**
- Consumes: Task 1's Vitest harness and `tests/setup.ts` env loading.
- Produces: `lib/supabase.ts` exporting `supabase: SupabaseClient<Database>` — the browser client Plan 2's store and auth will consume.
- Produces, all from `tests/helpers/supabase.ts`:
  - `serviceClient: SupabaseClient<Database>` — bypasses RLS, for seeding and cleanup only.
  - `anonClient(): SupabaseClient<Database>` — a fresh signed-out client.
  - `signInAs(email: string, password: string): Promise<SupabaseClient<Database>>` — a client authenticated as that user.
  - `createTestUser(opts: { email: string; password: string; name: string; handle: string; roleId: string }): Promise<string>` — creates an auth user plus its profile, returns the uuid.
  - `deleteTestUser(userId: string): Promise<void>`
  - `TEST_PASSWORD: string`

- [ ] **Step 1: Install the Supabase packages**

```bash
npm install @supabase/supabase-js@^2
npm install -D supabase@^2
```

`@supabase/supabase-js` is a runtime dependency (Plan 2 ships it to the browser); the CLI is dev-only.

- [ ] **Step 2: Initialise the Supabase directory**

Run: `npx supabase init`
Expected: creates `supabase/config.toml`. Answer no if it offers to generate VS Code or Deno settings.

- [ ] **Step 3: Link to the dev project**

Substitute the Project Reference ID from the prerequisite. The CLI prompts for the database password.

```bash
npx supabase link --project-ref <lumina-dev-ref>
```

Expected: `Finished supabase link.` This performs no local-stack work, so Docker is not involved.

- [ ] **Step 4: Write the test credentials file**

Create `.env.test.local` from the four dev values. Confirm it is ignored — `git check-ignore .env.test.local` must print the filename.

```bash
SUPABASE_URL=https://<lumina-dev-ref>.supabase.co
SUPABASE_ANON_KEY=<dev anon key>
SUPABASE_SERVICE_ROLE_KEY=<dev service role key>
```

- [ ] **Step 5: Generate the database types**

Add to `package.json` `"scripts"`:

```json
"db:push": "supabase db push",
"db:types": "supabase gen types typescript --linked > lib/database.types.ts"
```

Run: `npm run db:types`
Expected: `lib/database.types.ts` exists, exporting `Database`. Against an empty database it contains only the scaffolding — that is correct, and Task 4 regenerates it.

- [ ] **Step 6: Write the browser client module**

Create `lib/supabase.ts`. Nothing imports it until Plan 2 — it exists now so the public
env-var contract is fixed and typed before the store swap depends on it. It reads only the
two `NEXT_PUBLIC_` values; the service-role key must never appear in this file.

```ts
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local."
  );
}

/** The one browser client. Safe to ship: the anon key grants nothing on its own —
 *  Row Level Security is the boundary. */
export const supabase = createClient<Database>(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
```

- [ ] **Step 7: Write the failing helper test**

Create `tests/helpers/supabase.test.ts`.

```ts
import { afterAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  serviceClient,
  signInAs,
  TEST_PASSWORD,
} from "./supabase";

const created: string[] = [];
afterAll(async () => {
  for (const id of created) await deleteTestUser(id);
});

describe("supabase test helpers", () => {
  it("reads credentials from .env.test.local", () => {
    expect(process.env.SUPABASE_URL).toMatch(/^https:\/\/.+\.supabase\.co$/);
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeTruthy();
  });

  it("reaches the project with the service client", async () => {
    const { error } = await serviceClient.auth.admin.listUsers({ perPage: 1 });
    expect(error).toBeNull();
  });

  it("creates a user that can then sign in", async () => {
    const email = `helper-${Date.now()}@lumina.test`;
    const id = await createTestUser({
      email,
      password: TEST_PASSWORD,
      name: "Helper Probe",
      handle: `helper${Date.now()}`,
      roleId: "member",
    });
    created.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const client = await signInAs(email, TEST_PASSWORD);
    const { data } = await client.auth.getUser();
    expect(data.user?.id).toBe(id);
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx vitest run tests/helpers/supabase.test.ts`
Expected: FAIL — cannot resolve `./supabase`.

- [ ] **Step 9: Write the helpers**

Create `tests/helpers/supabase.ts`. `createTestUser` inserts the profile row with the service client because the `profiles` table does not exist until Task 4 — the insert is wrapped so this helper is usable in both tasks.

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    "Missing Supabase test credentials. Copy .env.example to .env.test.local and fill in the lumina-dev values."
  );
}

export const TEST_PASSWORD = "test-password-9f3a2b";

/** Bypasses every RLS policy. Seeding and cleanup only — never assert authorisation with this. */
export const serviceClient = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** A fresh signed-out client, subject to RLS as the anon role. */
export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client authenticated as one user. Each call gets its own client so tests can hold several at once. */
export async function signInAs(
  email: string,
  password: string
): Promise<SupabaseClient<Database>> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInAs(${email}) failed: ${error.message}`);
  return client;
}

export async function createTestUser(opts: {
  email: string;
  password: string;
  name: string;
  handle: string;
  roleId: string;
}): Promise<string> {
  const { data, error } = await serviceClient.auth.admin.createUser({
    email: opts.email,
    password: opts.password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createTestUser failed: ${error?.message}`);

  const profile = await serviceClient.from("profiles").upsert({
    id: data.user.id,
    email: opts.email,
    name: opts.name,
    handle: opts.handle,
    title: "Test User",
    role_id: opts.roleId,
    color: "#7c3aed",
  });
  // Tolerated only before Task 4 creates the table.
  if (profile.error && !/relation .* does not exist/.test(profile.error.message)) {
    throw new Error(`createTestUser profile insert failed: ${profile.error.message}`);
  }
  return data.user.id;
}

export async function deleteTestUser(userId: string): Promise<void> {
  await serviceClient.auth.admin.deleteUser(userId);
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run tests/helpers/supabase.test.ts`
Expected: PASS, 3 tests. A `fetch failed` means the dev project is paused — open the Supabase dashboard and resume it.

- [ ] **Step 11: Confirm no secret is committable**

Run: `git status --short`
Expected: `.env.test.local` does not appear. If it does, stop and fix `.gitignore` before continuing.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json supabase/config.toml lib/database.types.ts lib/supabase.ts tests/helpers/
git commit -m "feat: wire Supabase client and test helpers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Identity schema and permission function

`roles` and `profiles`, plus `has_permission` — the database twin of `guard()` (`lib/store.tsx:400-410`) that every later policy calls.

**Files:**
- Create: `supabase/migrations/20260906000100_identity.sql`
- Create: `tests/rls/identity.test.ts`
- Create: `tests/helpers/workspace.ts`
- Modify: `lib/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: Task 3's helpers.
- Produces:
  - SQL: `public.roles`, `public.profiles`, `public.has_permission(perm text) returns boolean`, `public.my_role_id() returns text`.
  - `tests/helpers/workspace.ts` exports `seedRoles(): Promise<void>` and `TEST_ROLE_IDS = { admin: "admin", member: "member", guest: "guest" }`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260906000100_identity.sql`. `presence` is deliberately absent from `profiles` — it becomes ephemeral Realtime Presence in Plan 3, not a stored column.

```sql
-- Roles carry the permission set. Ids are text: the three system roles keep
-- their literal ids ('admin'/'member'/'guest'), custom roles use 'r_<uuid>'.
create table public.roles (
  id          text primary key,
  name        text not null,
  description text not null default '',
  color       text not null default '#64748b',
  permissions text[] not null default '{}',
  is_system   boolean not null default false,
  locked      boolean not null default false
);

-- One profile per auth user.
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique,
  name       text not null,
  handle     text not null unique,
  title      text not null default '',
  role_id    text not null references public.roles (id) on delete restrict,
  color      text not null default '#7c3aed',
  created_at timestamptz not null default now()
);

create index profiles_role_id_idx on public.profiles (role_id);

-- SECURITY DEFINER so policies on profiles can call it without recursing
-- into profiles' own RLS.
create or replace function public.my_role_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role_id from public.profiles where id = auth.uid();
$$;

create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select perm = any (r.permissions)
       from public.profiles p
       join public.roles r on r.id = p.role_id
      where p.id = auth.uid()),
    false);
$$;

alter table public.roles    enable row level security;
alter table public.profiles enable row level security;

-- One team: every signed-in member can read the directory.
create policy roles_read on public.roles
  for select to authenticated using (true);

create policy roles_write on public.roles
  for all to authenticated
  using (public.has_permission('members.manage'))
  with check (public.has_permission('members.manage'));

create policy profiles_read on public.profiles
  for select to authenticated using (true);

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_admin_write on public.profiles
  for all to authenticated
  using (public.has_permission('members.manage'))
  with check (public.has_permission('members.manage'));

-- Mirrors lib/store.tsx:420 — nobody may change their own role, including admins.
create or replace function public.block_self_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role_id is distinct from old.role_id and old.id = auth.uid() then
    raise exception 'You cannot change your own role';
  end if;
  return new;
end;
$$;

create trigger profiles_block_self_role_change
  before update on public.profiles
  for each row execute function public.block_self_role_change();
```

- [ ] **Step 2: Write the workspace seed helper**

Create `tests/helpers/workspace.ts`. Permission arrays copy `DEFAULT_ROLES` in `lib/permissions.ts:28-60` exactly.

```ts
import { serviceClient } from "./supabase";

export const TEST_ROLE_IDS = { admin: "admin", member: "member", guest: "guest" } as const;

/** Idempotent: mirrors DEFAULT_ROLES from lib/permissions.ts. */
export async function seedRoles(): Promise<void> {
  const { error } = await serviceClient.from("roles").upsert([
    {
      id: "admin",
      name: "Admin",
      description: "Full access to everything",
      color: "#7c3aed",
      permissions: [
        "channel.create", "channel.delete", "project.create", "project.delete",
        "task.create", "task.edit", "task.move", "task.delete",
        "message.send", "message.deleteAny", "members.manage",
      ],
      is_system: true,
      locked: true,
    },
    {
      id: "member",
      name: "Member",
      description: "Can create and edit work",
      color: "#0ea5e9",
      permissions: [
        "channel.create", "project.create", "task.create", "task.edit",
        "task.move", "message.send",
      ],
      is_system: true,
      locked: false,
    },
    {
      id: "guest",
      name: "Guest",
      description: "Read-mostly access",
      color: "#64748b",
      permissions: ["message.send"],
      is_system: true,
      locked: false,
    },
  ]);
  if (error) throw new Error(`seedRoles failed: ${error.message}`);
}
```

- [ ] **Step 3: Write the failing RLS test**

Create `tests/rls/identity.test.ts`. Every case asserts the denial explicitly — an empty result set is a pass only when the test says so.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient, createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  admin: `admin-${stamp}@lumina.test`,
  member: `member-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `ada${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo Member", handle: `mo${stamp}`, roleId: "member",
  });
});

afterAll(async () => {
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("identity RLS", () => {
  it("denies a signed-out client any profile", async () => {
    const { data, error } = await anonClient().from("profiles").select("id");
    expect(error ?? data).toBeTruthy();
    expect(data ?? []).toHaveLength(0);
  });

  it("lets a signed-in member read the directory", async () => {
    const client = await signInAs(emails.member, TEST_PASSWORD);
    const { data, error } = await client.from("profiles").select("id,name");
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("denies a member editing another member's profile", async () => {
    const client = await signInAs(emails.member, TEST_PASSWORD);
    const { error } = await client
      .from("profiles").update({ title: "Hacked" }).eq("id", ids.admin).select();
    const { data: after } = await serviceClient
      .from("profiles").select("title").eq("id", ids.admin).single();
    expect(after?.title).not.toBe("Hacked");
    expect(error === null && after?.title === "Hacked").toBe(false);
  });

  it("lets a member edit their own title", async () => {
    const client = await signInAs(emails.member, TEST_PASSWORD);
    const { error } = await client
      .from("profiles").update({ title: "Designer" }).eq("id", ids.member);
    expect(error).toBeNull();
    const { data } = await serviceClient
      .from("profiles").select("title").eq("id", ids.member).single();
    expect(data?.title).toBe("Designer");
  });

  it("denies a member creating a role", async () => {
    const client = await signInAs(emails.member, TEST_PASSWORD);
    const { error } = await client.from("roles").insert({
      id: `r_${stamp}`, name: "Sneaky", description: "", color: "#000", permissions: [],
    });
    expect(error).not.toBeNull();
  });

  it("lets an admin create a role", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    const roleId = `r_ok_${stamp}`;
    const { error } = await client.from("roles").insert({
      id: roleId, name: "Reviewer", description: "", color: "#000", permissions: ["task.edit"],
    });
    expect(error).toBeNull();
    await serviceClient.from("roles").delete().eq("id", roleId);
  });

  it("blocks anyone from changing their own role, admin included", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    const { error } = await client
      .from("profiles").update({ role_id: "guest" }).eq("id", ids.admin);
    expect(error).not.toBeNull();
    const { data } = await serviceClient
      .from("profiles").select("role_id").eq("id", ids.admin).single();
    expect(data?.role_id).toBe("admin");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/rls/identity.test.ts`
Expected: FAIL in `beforeAll` — `relation "public.roles" does not exist`.

- [ ] **Step 5: Push the migration**

Run: `npm run db:push`
Expected: applies `20260906000100_identity.sql`. Review the printed statement list before confirming.

- [ ] **Step 6: Regenerate the types**

Run: `npm run db:types`
Expected: `lib/database.types.ts` now contains `roles` and `profiles` row types.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/rls/identity.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Verify typecheck still holds**

Run: `npm run typecheck && npm test`
Expected: both succeed.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/ lib/database.types.ts tests/rls/identity.test.ts tests/helpers/workspace.ts
git commit -m "feat: identity schema with RLS and has_permission

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Conversations, channels, DMs, messages, reactions

The spec's structural change: `Message.channelId` (`lib/types.ts:76`) holds a channel id *or* a DM id today. A `conversations` parent makes it one foreign key and lets one policy cover both.

**Files:**
- Create: `supabase/migrations/20260906000200_conversations.sql`
- Create: `tests/rls/conversations.test.ts`
- Modify: `tests/helpers/workspace.ts`
- Modify: `lib/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: `has_permission`, `profiles` from Task 4.
- Produces:
  - SQL: `public.conversations`, `public.channels`, `public.channel_members`, `public.dms`, `public.dm_members`, `public.messages`, `public.reactions`, and `public.can_see_conversation(conversation_id text) returns boolean`.
  - `tests/helpers/workspace.ts` gains `createChannel(opts: { id: string; name: string; isPrivate: boolean; createdBy: string }): Promise<void>` and `addChannelMember(channelId: string, userId: string, level: "viewer" | "editor"): Promise<void>`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260906000200_conversations.sql`.

```sql
create table public.conversations (
  id   text primary key,
  kind text not null check (kind in ('channel', 'dm'))
);

create table public.channels (
  id              text primary key references public.conversations (id) on delete cascade,
  name            text not null,
  description     text not null default '',
  is_private      boolean not null default false,
  is_team         boolean not null default false,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

create table public.channel_members (
  channel_id text not null references public.channels (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  level      text not null default 'editor' check (level in ('viewer', 'editor')),
  primary key (channel_id, user_id)
);

create table public.dms (
  id         text primary key references public.conversations (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.dm_members (
  dm_id   text not null references public.dms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (dm_id, user_id)
);

create table public.messages (
  id              text primary key,
  conversation_id text not null references public.conversations (id) on delete cascade,
  author_id       uuid references public.profiles (id) on delete set null,
  content         text not null default '',
  created_at      timestamptz not null default now(),
  edited_at       timestamptz
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

create table public.reactions (
  message_id text not null references public.messages (id) on delete cascade,
  emoji      text not null,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  primary key (message_id, emoji, user_id)
);

-- SECURITY DEFINER: called from policies on the very tables it reads.
-- Without this, channel_members' policy recurses into itself.
create or replace function public.can_see_conversation(conv_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when public.has_permission('members.manage') then true
      when exists (select 1 from public.channels c
                    where c.id = conv_id and c.is_private = false) then true
      when exists (select 1 from public.channel_members m
                    where m.channel_id = conv_id and m.user_id = auth.uid()) then true
      when exists (select 1 from public.dm_members d
                    where d.dm_id = conv_id and d.user_id = auth.uid()) then true
      else false
    end;
$$;

alter table public.conversations   enable row level security;
alter table public.channels        enable row level security;
alter table public.channel_members enable row level security;
alter table public.dms             enable row level security;
alter table public.dm_members      enable row level security;
alter table public.messages        enable row level security;
alter table public.reactions       enable row level security;

create policy conversations_read on public.conversations
  for select to authenticated using (public.can_see_conversation(id));

create policy channels_read on public.channels
  for select to authenticated using (public.can_see_conversation(id));

create policy channels_insert on public.channels
  for insert to authenticated with check (public.has_permission('channel.create'));

create policy channels_update on public.channels
  for update to authenticated
  using (public.can_see_conversation(id) and public.has_permission('channel.create'))
  with check (public.has_permission('channel.create'));

create policy channels_delete on public.channels
  for delete to authenticated
  using (public.has_permission('channel.delete') and is_team = false);

create policy conversations_write on public.conversations
  for all to authenticated
  using (public.has_permission('channel.create') or public.has_permission('message.send'))
  with check (public.has_permission('channel.create') or public.has_permission('message.send'));

create policy channel_members_read on public.channel_members
  for select to authenticated using (public.can_see_conversation(channel_id));

create policy channel_members_write on public.channel_members
  for all to authenticated
  using (public.has_permission('channel.create') or public.has_permission('members.manage'))
  with check (public.has_permission('channel.create') or public.has_permission('members.manage'));

create policy dms_read on public.dms
  for select to authenticated using (public.can_see_conversation(id));

create policy dms_insert on public.dms
  for insert to authenticated with check (public.has_permission('message.send'));

create policy dm_members_read on public.dm_members
  for select to authenticated using (public.can_see_conversation(dm_id));

create policy dm_members_insert on public.dm_members
  for insert to authenticated with check (public.has_permission('message.send'));

create policy messages_read on public.messages
  for select to authenticated using (public.can_see_conversation(conversation_id));

create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.has_permission('message.send')
    and public.can_see_conversation(conversation_id)
  );

-- Mirrors lib/store.tsx:671 — you may only edit your own message.
create policy messages_update on public.messages
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- Mirrors canDeleteMessage, lib/store.tsx:1089.
create policy messages_delete on public.messages
  for delete to authenticated
  using (author_id = auth.uid() or public.has_permission('message.deleteAny'));

create policy reactions_read on public.reactions
  for select to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id and public.can_see_conversation(m.conversation_id)));

create policy reactions_write on public.reactions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

- [ ] **Step 2: Extend the workspace helper**

Append to `tests/helpers/workspace.ts`:

```ts
/** Creates the conversations row and its channel row together. */
export async function createChannel(opts: {
  id: string;
  name: string;
  isPrivate: boolean;
  createdBy: string;
}): Promise<void> {
  const conv = await serviceClient
    .from("conversations").insert({ id: opts.id, kind: "channel" });
  if (conv.error) throw new Error(`createChannel conversation failed: ${conv.error.message}`);

  const channel = await serviceClient.from("channels").insert({
    id: opts.id,
    name: opts.name,
    description: "",
    is_private: opts.isPrivate,
    is_team: false,
    created_by: opts.createdBy,
  });
  if (channel.error) throw new Error(`createChannel failed: ${channel.error.message}`);
}

export async function addChannelMember(
  channelId: string,
  userId: string,
  level: "viewer" | "editor"
): Promise<void> {
  const { error } = await serviceClient
    .from("channel_members").insert({ channel_id: channelId, user_id: userId, level });
  if (error) throw new Error(`addChannelMember failed: ${error.message}`);
}
```

- [ ] **Step 3: Write the failing RLS test**

Create `tests/rls/conversations.test.ts`.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addChannelMember, createChannel, seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const publicChannel = `c_pub_${stamp}`;
const privateChannel = `c_priv_${stamp}`;
const emails = {
  admin: `cadmin-${stamp}@lumina.test`,
  insider: `cin-${stamp}@lumina.test`,
  outsider: `cout-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada", handle: `cada${stamp}`, roleId: "admin",
  });
  ids.insider = await createTestUser({
    email: emails.insider, password: TEST_PASSWORD,
    name: "Ivy", handle: `civy${stamp}`, roleId: "member",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Otto", handle: `cotto${stamp}`, roleId: "member",
  });
  await createChannel({ id: publicChannel, name: "general", isPrivate: false, createdBy: ids.admin });
  await createChannel({ id: privateChannel, name: "leadership", isPrivate: true, createdBy: ids.admin });
  await addChannelMember(privateChannel, ids.insider, "editor");
  await serviceClient.from("messages").insert({
    id: `m_secret_${stamp}`, conversation_id: privateChannel,
    author_id: ids.insider, content: "salary review notes",
  });
});

afterAll(async () => {
  await serviceClient.from("conversations").delete().in("id", [publicChannel, privateChannel]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("conversation RLS", () => {
  it("shows a public channel to any member", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("channels").select("id").eq("id", publicChannel);
    expect(data).toHaveLength(1);
  });

  it("hides a private channel from a non-member", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("channels").select("id").eq("id", privateChannel);
    expect(data).toHaveLength(0);
  });

  it("shows a private channel to its member", async () => {
    const client = await signInAs(emails.insider, TEST_PASSWORD);
    const { data } = await client.from("channels").select("id").eq("id", privateChannel);
    expect(data).toHaveLength(1);
  });

  it("shows a private channel to an admin via members.manage", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    const { data } = await client.from("channels").select("id").eq("id", privateChannel);
    expect(data).toHaveLength(1);
  });

  it("withholds private-channel messages from a non-member", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client
      .from("messages").select("id,content").eq("conversation_id", privateChannel);
    expect(data).toHaveLength(0);
  });

  it("denies a non-member posting into a private channel", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("messages").insert({
      id: `m_intrude_${stamp}`, conversation_id: privateChannel,
      author_id: ids.outsider, content: "hello?",
    });
    expect(error).not.toBeNull();
  });

  it("denies posting under someone else's name", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("messages").insert({
      id: `m_forge_${stamp}`, conversation_id: publicChannel,
      author_id: ids.admin, content: "forged",
    });
    expect(error).not.toBeNull();
  });

  it("denies editing another person's message", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    await client.from("messages").update({ content: "tampered" }).eq("id", `m_secret_${stamp}`);
    const { data } = await serviceClient
      .from("messages").select("content").eq("id", `m_secret_${stamp}`).single();
    expect(data?.content).toBe("salary review notes");
  });

  it("lets an admin delete anyone's message via message.deleteAny", async () => {
    const id = `m_del_${stamp}`;
    await serviceClient.from("messages").insert({
      id, conversation_id: publicChannel, author_id: ids.outsider, content: "spam",
    });
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    await client.from("messages").delete().eq("id", id);
    const { data } = await serviceClient.from("messages").select("id").eq("id", id);
    expect(data).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/rls/conversations.test.ts`
Expected: FAIL in `beforeAll` — `relation "public.conversations" does not exist`.

- [ ] **Step 5: Push and regenerate**

```bash
npm run db:push
npm run db:types
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/rls/conversations.test.ts`
Expected: PASS, 9 tests. A hang or `stack depth limit exceeded` means a policy helper lost its `SECURITY DEFINER` — check `can_see_conversation`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/ lib/database.types.ts tests/rls/conversations.test.ts tests/helpers/workspace.ts
git commit -m "feat: conversation schema with RLS

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Projects and tasks

**Files:**
- Create: `supabase/migrations/20260906000300_projects.sql`
- Create: `tests/rls/projects.test.ts`
- Modify: `tests/helpers/workspace.ts`
- Modify: `lib/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: `has_permission`, `profiles`.
- Produces:
  - SQL: `public.projects`, `public.project_members`, `public.tasks`, `public.can_see_project(project_id text) returns boolean`, `public.project_is_viewer_only(project_id text) returns boolean`.
  - `tests/helpers/workspace.ts` gains `createProject(opts: { id: string; name: string; restricted: boolean; createdBy: string }): Promise<void>` and `addProjectMember(projectId: string, userId: string, level: "viewer" | "editor"): Promise<void>`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260906000300_projects.sql`.

```sql
create table public.projects (
  id          text primary key,
  name        text not null,
  description text not null default '',
  emoji       text not null default '📁',
  color       text not null default '#7c3aed',
  priority    text not null default 'medium' check (priority in ('high','medium','low')),
  restricted  boolean not null default false,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.project_members (
  project_id text not null references public.projects (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  level      text not null default 'editor' check (level in ('viewer','editor')),
  primary key (project_id, user_id)
);

create table public.tasks (
  id               text primary key,
  project_id       text not null references public.projects (id) on delete cascade,
  title            text not null,
  description      text not null default '',
  status           text not null default 'backlog'
                     check (status in ('backlog','todo','in-progress','in-review','done')),
  priority         text not null default 'medium' check (priority in ('high','medium','low')),
  assignee_id      uuid references public.profiles (id) on delete set null,
  due_date         timestamptz,
  start_time       text,
  duration_minutes integer,
  reminder_minutes integer,
  labels           text[] not null default '{}',
  position         integer not null default 0,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now()
);

create index tasks_project_status_idx on public.tasks (project_id, status, position);

create or replace function public.can_see_project(proj_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when public.has_permission('members.manage') then true
      when exists (select 1 from public.projects p
                    where p.id = proj_id and p.restricted = false) then true
      when exists (select 1 from public.project_members m
                    where m.project_id = proj_id and m.user_id = auth.uid()) then true
      else false
    end;
$$;

-- Mirrors projectIsViewerOnly, lib/store.tsx:200-204.
create or replace function public.project_is_viewer_only(proj_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when public.has_permission('members.manage') then false
      when not exists (select 1 from public.projects p
                        where p.id = proj_id and p.restricted = true) then false
      else not exists (select 1 from public.project_members m
                        where m.project_id = proj_id
                          and m.user_id = auth.uid()
                          and m.level = 'editor')
    end;
$$;

alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks           enable row level security;

create policy projects_read on public.projects
  for select to authenticated using (public.can_see_project(id));

create policy projects_insert on public.projects
  for insert to authenticated with check (public.has_permission('project.create'));

create policy projects_update on public.projects
  for update to authenticated
  using (public.has_permission('project.create')
         and public.can_see_project(id)
         and not public.project_is_viewer_only(id))
  with check (public.has_permission('project.create'));

create policy projects_delete on public.projects
  for delete to authenticated using (public.has_permission('project.delete'));

create policy project_members_read on public.project_members
  for select to authenticated using (public.can_see_project(project_id));

create policy project_members_write on public.project_members
  for all to authenticated
  using (public.has_permission('project.create') or public.has_permission('members.manage'))
  with check (public.has_permission('project.create') or public.has_permission('members.manage'));

create policy tasks_read on public.tasks
  for select to authenticated using (public.can_see_project(project_id));

create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (public.has_permission('task.create')
              and public.can_see_project(project_id)
              and not public.project_is_viewer_only(project_id));

create policy tasks_update on public.tasks
  for update to authenticated
  using (public.has_permission('task.edit')
         and public.can_see_project(project_id)
         and not public.project_is_viewer_only(project_id))
  with check (public.can_see_project(project_id));

create policy tasks_delete on public.tasks
  for delete to authenticated
  using (public.has_permission('task.delete')
         and public.can_see_project(project_id)
         and not public.project_is_viewer_only(project_id));
```

- [ ] **Step 2: Extend the workspace helper**

Append to `tests/helpers/workspace.ts`:

```ts
export async function createProject(opts: {
  id: string;
  name: string;
  restricted: boolean;
  createdBy: string;
}): Promise<void> {
  const { error } = await serviceClient.from("projects").insert({
    id: opts.id,
    name: opts.name,
    description: "",
    emoji: "🎨",
    color: "#7c3aed",
    priority: "medium",
    restricted: opts.restricted,
    created_by: opts.createdBy,
  });
  if (error) throw new Error(`createProject failed: ${error.message}`);
}

export async function addProjectMember(
  projectId: string,
  userId: string,
  level: "viewer" | "editor"
): Promise<void> {
  const { error } = await serviceClient
    .from("project_members").insert({ project_id: projectId, user_id: userId, level });
  if (error) throw new Error(`addProjectMember failed: ${error.message}`);
}
```

- [ ] **Step 3: Write the failing RLS test**

Create `tests/rls/projects.test.ts`.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addProjectMember, createProject, seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const openProject = `p_open_${stamp}`;
const secretProject = `p_secret_${stamp}`;
const emails = {
  admin: `padmin-${stamp}@lumina.test`,
  editor: `ped-${stamp}@lumina.test`,
  viewer: `pview-${stamp}@lumina.test`,
  outsider: `pout-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada", handle: `pada${stamp}`, roleId: "admin",
  });
  ids.editor = await createTestUser({
    email: emails.editor, password: TEST_PASSWORD,
    name: "Eve", handle: `peve${stamp}`, roleId: "member",
  });
  ids.viewer = await createTestUser({
    email: emails.viewer, password: TEST_PASSWORD,
    name: "Vic", handle: `pvic${stamp}`, roleId: "member",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Otto", handle: `potto${stamp}`, roleId: "member",
  });
  await createProject({ id: openProject, name: "Website", restricted: false, createdBy: ids.admin });
  await createProject({ id: secretProject, name: "Acquisition", restricted: true, createdBy: ids.admin });
  await addProjectMember(secretProject, ids.editor, "editor");
  await addProjectMember(secretProject, ids.viewer, "viewer");
  await serviceClient.from("tasks").insert({
    id: `t_secret_${stamp}`, project_id: secretProject,
    title: "Draft the offer", created_by: ids.admin, position: 0,
  });
});

afterAll(async () => {
  await serviceClient.from("projects").delete().in("id", [openProject, secretProject]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("project RLS", () => {
  it("hides a restricted project from a non-member", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("projects").select("id").eq("id", secretProject);
    expect(data).toHaveLength(0);
  });

  it("withholds its tasks from a non-member too", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("tasks").select("id,title").eq("project_id", secretProject);
    expect(data).toHaveLength(0);
  });

  it("shows a restricted project to an invited editor", async () => {
    const client = await signInAs(emails.editor, TEST_PASSWORD);
    const { data } = await client.from("projects").select("id").eq("id", secretProject);
    expect(data).toHaveLength(1);
  });

  it("lets an invited editor create a task", async () => {
    const client = await signInAs(emails.editor, TEST_PASSWORD);
    const id = `t_ok_${stamp}`;
    const { error } = await client.from("tasks").insert({
      id, project_id: secretProject, title: "Editor task", created_by: ids.editor, position: 1,
    });
    expect(error).toBeNull();
    await serviceClient.from("tasks").delete().eq("id", id);
  });

  it("denies a viewer creating a task despite seeing the project", async () => {
    const client = await signInAs(emails.viewer, TEST_PASSWORD);
    const { data: visible } = await client.from("projects").select("id").eq("id", secretProject);
    expect(visible).toHaveLength(1);

    const { error } = await client.from("tasks").insert({
      id: `t_viewer_${stamp}`, project_id: secretProject,
      title: "Viewer task", created_by: ids.viewer, position: 2,
    });
    expect(error).not.toBeNull();
  });

  it("denies a viewer editing an existing task", async () => {
    const client = await signInAs(emails.viewer, TEST_PASSWORD);
    await client.from("tasks").update({ title: "Tampered" }).eq("id", `t_secret_${stamp}`);
    const { data } = await serviceClient
      .from("tasks").select("title").eq("id", `t_secret_${stamp}`).single();
    expect(data?.title).toBe("Draft the offer");
  });

  it("denies a member deleting a project without project.delete", async () => {
    const client = await signInAs(emails.editor, TEST_PASSWORD);
    await client.from("projects").delete().eq("id", openProject);
    const { data } = await serviceClient.from("projects").select("id").eq("id", openProject);
    expect(data).toHaveLength(1);
  });

  it("shows every project to an admin", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    const { data } = await client
      .from("projects").select("id").in("id", [openProject, secretProject]);
    expect(data).toHaveLength(2);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/rls/projects.test.ts`
Expected: FAIL in `beforeAll` — `relation "public.projects" does not exist`.

- [ ] **Step 5: Push and regenerate**

```bash
npm run db:push
npm run db:types
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/rls/projects.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/ lib/database.types.ts tests/rls/projects.test.ts tests/helpers/workspace.ts
git commit -m "feat: project and task schema with RLS

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Attachments, read state, and activities

Files stop being base64 blobs and become rows pointing at Storage paths. `read_state` replaces the shared `lastRead` map so read positions stop leaking between users.

**Files:**
- Create: `supabase/migrations/20260906000400_attachments.sql`
- Create: `tests/rls/attachments.test.ts`
- Modify: `lib/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: `can_see_project`, `can_see_conversation`, `profiles`.
- Produces: SQL `public.attachments`, `public.project_attachments`, `public.task_attachments`, `public.message_attachments`, `public.read_state`, `public.activities`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260906000400_attachments.sql`. `storage_path` replaces `dataUrl`; the bytes land in Storage in Plan 3, so this table only records metadata.

```sql
create table public.attachments (
  id           text primary key,
  storage_path text not null,
  name         text not null,
  size         bigint not null default 0,
  mime         text not null default '',
  uploaded_by  uuid references public.profiles (id) on delete set null,
  uploaded_at  timestamptz not null default now(),
  edited_by    uuid references public.profiles (id) on delete set null,
  edited_at    timestamptz
);

create table public.project_attachments (
  project_id    text not null references public.projects (id) on delete cascade,
  attachment_id text not null references public.attachments (id) on delete cascade,
  primary key (project_id, attachment_id)
);

create table public.task_attachments (
  task_id       text not null references public.tasks (id) on delete cascade,
  attachment_id text not null references public.attachments (id) on delete cascade,
  primary key (task_id, attachment_id)
);

create table public.message_attachments (
  message_id        text not null references public.messages (id) on delete cascade,
  attachment_id     text not null references public.attachments (id) on delete cascade,
  source_project_id text references public.projects (id) on delete set null,
  primary key (message_id, attachment_id)
);

-- Replaces AppState.lastRead, which exposed everyone's read positions to everyone.
create table public.read_state (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  conversation_id text not null references public.conversations (id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (user_id, conversation_id)
);

create table public.activities (
  id       text primary key,
  ts       timestamptz not null default now(),
  actor_id uuid references public.profiles (id) on delete set null,
  text     text not null,
  kind     text not null check (kind in ('task','message','channel','member','project'))
);

create index activities_ts_idx on public.activities (ts desc);

-- An attachment is visible when anything it is attached to is visible.
create or replace function public.can_see_attachment(att_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from public.project_attachments pa
             where pa.attachment_id = att_id and public.can_see_project(pa.project_id))
    or exists (select 1 from public.task_attachments ta
                join public.tasks t on t.id = ta.task_id
               where ta.attachment_id = att_id and public.can_see_project(t.project_id))
    or exists (select 1 from public.message_attachments ma
                join public.messages m on m.id = ma.message_id
               where ma.attachment_id = att_id
                 and public.can_see_conversation(m.conversation_id))
    -- A freshly uploaded row is visible to its uploader before it is linked.
    or exists (select 1 from public.attachments a
               where a.id = att_id and a.uploaded_by = auth.uid());
$$;

alter table public.attachments         enable row level security;
alter table public.project_attachments enable row level security;
alter table public.task_attachments    enable row level security;
alter table public.message_attachments enable row level security;
alter table public.read_state          enable row level security;
alter table public.activities          enable row level security;

create policy attachments_read on public.attachments
  for select to authenticated using (public.can_see_attachment(id));

create policy attachments_insert on public.attachments
  for insert to authenticated with check (uploaded_by = auth.uid());

create policy attachments_update on public.attachments
  for update to authenticated
  using (public.can_see_attachment(id) and public.has_permission('project.create'))
  with check (public.has_permission('project.create'));

create policy attachments_delete on public.attachments
  for delete to authenticated
  using (uploaded_by = auth.uid() or public.has_permission('project.delete'));

create policy project_attachments_read on public.project_attachments
  for select to authenticated using (public.can_see_project(project_id));

create policy project_attachments_write on public.project_attachments
  for all to authenticated
  using (public.has_permission('project.create')
         and not public.project_is_viewer_only(project_id))
  with check (public.has_permission('project.create')
              and not public.project_is_viewer_only(project_id));

create policy task_attachments_read on public.task_attachments
  for select to authenticated
  using (exists (select 1 from public.tasks t
                  where t.id = task_id and public.can_see_project(t.project_id)));

create policy task_attachments_write on public.task_attachments
  for all to authenticated
  using (public.has_permission('task.edit'))
  with check (public.has_permission('task.edit'));

create policy message_attachments_read on public.message_attachments
  for select to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id and public.can_see_conversation(m.conversation_id)));

create policy message_attachments_write on public.message_attachments
  for all to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id and m.author_id = auth.uid()))
  with check (exists (select 1 from public.messages m
                       where m.id = message_id and m.author_id = auth.uid()));

-- Read positions are private, full stop.
create policy read_state_own on public.read_state
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy activities_read on public.activities
  for select to authenticated using (true);

create policy activities_insert on public.activities
  for insert to authenticated with check (actor_id = auth.uid());
```

- [ ] **Step 2: Write the failing RLS test**

Create `tests/rls/attachments.test.ts`.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { createProject, seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const secretProject = `p_att_${stamp}`;
const attachmentId = `att_${stamp}`;
const emails = {
  owner: `aown-${stamp}@lumina.test`,
  outsider: `aout-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedRoles();
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ada", handle: `aada${stamp}`, roleId: "admin",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Otto", handle: `aotto${stamp}`, roleId: "member",
  });
  await createProject({ id: secretProject, name: "Board deck", restricted: true, createdBy: ids.owner });
  await serviceClient.from("attachments").insert({
    id: attachmentId, storage_path: `projects/${secretProject}/${attachmentId}`,
    name: "board-deck.xlsx", size: 4096,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    uploaded_by: ids.owner,
  });
  await serviceClient.from("project_attachments")
    .insert({ project_id: secretProject, attachment_id: attachmentId });
});

afterAll(async () => {
  await serviceClient.from("attachments").delete().eq("id", attachmentId);
  await serviceClient.from("projects").delete().eq("id", secretProject);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("attachment and read-state RLS", () => {
  it("hides an attachment on a restricted project from a non-member", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("attachments").select("id,name").eq("id", attachmentId);
    expect(data).toHaveLength(0);
  });

  it("shows it to someone who can see the project", async () => {
    const client = await signInAs(emails.owner, TEST_PASSWORD);
    const { data } = await client.from("attachments").select("id,name").eq("id", attachmentId);
    expect(data).toHaveLength(1);
    expect(data?.[0]?.name).toBe("board-deck.xlsx");
  });

  it("keeps one user's read state invisible to another", async () => {
    const conv = `c_read_${stamp}`;
    await serviceClient.from("conversations").insert({ id: conv, kind: "channel" });
    await serviceClient.from("channels")
      .insert({ id: conv, name: "readtest", is_private: false, created_by: ids.owner });
    await serviceClient.from("read_state")
      .insert({ user_id: ids.owner, conversation_id: conv });

    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { data } = await client.from("read_state").select("user_id").eq("conversation_id", conv);
    expect(data).toHaveLength(0);

    await serviceClient.from("conversations").delete().eq("id", conv);
  });

  it("denies writing read state on someone else's behalf", async () => {
    const conv = `c_read2_${stamp}`;
    await serviceClient.from("conversations").insert({ id: conv, kind: "channel" });
    await serviceClient.from("channels")
      .insert({ id: conv, name: "readtest2", is_private: false, created_by: ids.owner });

    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("read_state")
      .insert({ user_id: ids.owner, conversation_id: conv });
    expect(error).not.toBeNull();

    await serviceClient.from("conversations").delete().eq("id", conv);
  });

  it("denies logging activity under another user's name", async () => {
    const client = await signInAs(emails.outsider, TEST_PASSWORD);
    const { error } = await client.from("activities").insert({
      id: `a_forge_${stamp}`, actor_id: ids.owner, text: "did something", kind: "project",
    });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/rls/attachments.test.ts`
Expected: FAIL in `beforeAll` — `relation "public.attachments" does not exist`.

- [ ] **Step 4: Push and regenerate**

```bash
npm run db:push
npm run db:types
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/rls/attachments.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/ lib/database.types.ts tests/rls/attachments.test.ts
git commit -m "feat: attachment, read-state and activity schema with RLS

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Business invariants

Four rules that RLS cannot express, ported from the store so the database enforces them no matter what the client does.

**Files:**
- Create: `supabase/migrations/20260906000500_invariants.sql`
- Create: `tests/rls/invariants.test.ts`
- Modify: `lib/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: everything from Tasks 4-7.
- Produces: SQL triggers `roles_block_delete_with_members`, `profiles_block_last_admin`, `channel_members_ensure_creator`, `project_members_ensure_creator`, and the RPC `public.move_task(p_task_id text, p_status text, p_index integer) returns void`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260906000500_invariants.sql`.

```sql
-- Invariant 1 — a role with members cannot be deleted (lib/store.tsx:546).
create or replace function public.block_role_delete_with_members()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.profiles where role_id = old.id) then
    raise exception 'Role "%" still has members', old.name;
  end if;
  if old.is_system then
    raise exception 'Built-in roles cannot be deleted';
  end if;
  return old;
end;
$$;

create trigger roles_block_delete_with_members
  before delete on public.roles
  for each row execute function public.block_role_delete_with_members();

-- Invariant 2 — the last admin cannot be demoted or removed (lib/store.tsx:428-434).
create or replace function public.block_last_admin_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_count integer;
begin
  if tg_op = 'UPDATE' and new.role_id = 'admin' then
    return new;
  end if;
  if old.role_id <> 'admin' then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  select count(*) into admin_count from public.profiles where role_id = 'admin';
  if admin_count <= 1 then
    raise exception 'The last admin cannot be demoted or removed';
  end if;
  return case tg_op when 'DELETE' then old else new end;
end;
$$;

create trigger profiles_block_last_admin
  before update or delete on public.profiles
  for each row execute function public.block_last_admin_removal();

-- Invariant 3 — a creator is always kept as an editor (ensureEditor, lib/store.tsx:228-233).
create or replace function public.ensure_channel_creator_editor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  creator uuid;
begin
  select created_by into creator from public.channels where id = old.channel_id;
  if creator is not null and old.user_id = creator then
    raise exception 'The channel creator cannot be removed from its members';
  end if;
  return old;
end;
$$;

create trigger channel_members_ensure_creator
  before delete on public.channel_members
  for each row execute function public.ensure_channel_creator_editor();

create or replace function public.ensure_project_creator_editor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  creator uuid;
begin
  select created_by into creator from public.projects where id = old.project_id;
  if creator is not null and old.user_id = creator then
    raise exception 'The project creator cannot be removed from its members';
  end if;
  return old;
end;
$$;

create trigger project_members_ensure_creator
  before delete on public.project_members
  for each row execute function public.ensure_project_creator_editor();

-- Invariant 4 — moving a task renumbers its whole destination column atomically
-- (moveTask, lib/store.tsx:977-1010). SECURITY INVOKER so RLS still applies.
create or replace function public.move_task(
  p_task_id text,
  p_status  text,
  p_index   integer
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_project text;
  v_from    text;
begin
  select project_id, status into v_project, v_from
    from public.tasks where id = p_task_id;
  if v_project is null then
    raise exception 'Task % not found or not visible', p_task_id;
  end if;

  update public.tasks set status = p_status where id = p_task_id;

  -- Renumber the destination column, opening a slot at p_index for the moved task.
  -- Integer arithmetic throughout: assigning a fraction to an integer column would
  -- be rounded by Postgres and silently lose the intended position.
  with others as (
    select id, row_number() over (order by position, created_at) - 1 as rn
      from public.tasks
     where project_id = v_project and status = p_status and id <> p_task_id
  ),
  final as (
    select id, case when rn < p_index then rn else rn + 1 end as new_pos from others
    union all
    select p_task_id, least(greatest(p_index, 0), (select count(*)::int from others))
  )
  update public.tasks t
     set position = final.new_pos
    from final
   where t.id = final.id;

  -- Close the gap the task left behind in its old column.
  if v_from is distinct from p_status then
    with ordered as (
      select id, row_number() over (order by position, created_at) - 1 as new_pos
        from public.tasks
       where project_id = v_project and status = v_from
    )
    update public.tasks t
       set position = ordered.new_pos
      from ordered
     where t.id = ordered.id;
  end if;
end;
$$;
```

Both columns end as a dense `0..n-1` sequence. `least(greatest(p_index, 0), count)` clamps an out-of-range index to the end of the column rather than leaving a hole.

- [ ] **Step 2: Write the failing test**

Create `tests/rls/invariants.test.ts`.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { createProject, seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const project = `p_inv_${stamp}`;
const emails = { admin: `iadmin-${stamp}@lumina.test`, member: `imem-${stamp}@lumina.test` };
const ids: Record<string, string> = {};
const taskIds = [`t_a_${stamp}`, `t_b_${stamp}`, `t_c_${stamp}`];

beforeAll(async () => {
  await seedRoles();
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada", handle: `iada${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo", handle: `imo${stamp}`, roleId: "member",
  });
  await createProject({ id: project, name: "Invariants", restricted: false, createdBy: ids.admin });
  await serviceClient.from("tasks").insert(
    taskIds.map((id, i) => ({
      id, project_id: project, title: `Task ${i}`,
      status: "todo", created_by: ids.admin, position: i,
    }))
  );
});

afterAll(async () => {
  await serviceClient.from("projects").delete().eq("id", project);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("business invariants", () => {
  it("refuses to delete a role that still has members", async () => {
    const roleId = `r_pop_${stamp}`;
    await serviceClient.from("roles").insert({
      id: roleId, name: "Populated", description: "", color: "#000", permissions: [],
    });
    await serviceClient.from("profiles").update({ role_id: roleId }).eq("id", ids.member);

    const { error } = await serviceClient.from("roles").delete().eq("id", roleId);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/still has members/i);

    await serviceClient.from("profiles").update({ role_id: "member" }).eq("id", ids.member);
    await serviceClient.from("roles").delete().eq("id", roleId);
  });

  it("refuses to delete a built-in role", async () => {
    const { error } = await serviceClient.from("roles").delete().eq("id", "guest");
    expect(error).not.toBeNull();
  });

  it("refuses to demote the last admin", async () => {
    const { data: admins } = await serviceClient
      .from("profiles").select("id").eq("role_id", "admin");
    // Other suites may leave admins behind; only assert when ours is the only one.
    if ((admins ?? []).length === 1) {
      const { error } = await serviceClient
        .from("profiles").update({ role_id: "member" }).eq("id", ids.admin);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/last admin/i);
    } else {
      const second = await createTestUser({
        email: `iextra-${stamp}@lumina.test`, password: TEST_PASSWORD,
        name: "Extra", handle: `iex${stamp}`, roleId: "admin",
      });
      await serviceClient.from("profiles").update({ role_id: "member" }).eq("id", second);
      await deleteTestUser(second);
      expect(true).toBe(true);
    }
  });

  it("refuses to remove a project's creator from its members", async () => {
    await serviceClient.from("project_members")
      .insert({ project_id: project, user_id: ids.admin, level: "editor" });
    const { error } = await serviceClient
      .from("project_members").delete()
      .eq("project_id", project).eq("user_id", ids.admin);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/creator/i);
  });

  it("renumbers a column densely when a task moves within it", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    const { error } = await client.rpc("move_task", {
      p_task_id: taskIds[2], p_status: "todo", p_index: 0,
    });
    expect(error).toBeNull();

    const { data } = await serviceClient
      .from("tasks").select("id,position").eq("project_id", project)
      .eq("status", "todo").order("position");
    expect(data?.map((t) => t.id)).toEqual([taskIds[2], taskIds[0], taskIds[1]]);
    expect(data?.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it("closes the gap in the source column when a task moves out", async () => {
    const client = await signInAs(emails.admin, TEST_PASSWORD);
    await client.rpc("move_task", { p_task_id: taskIds[0], p_status: "done", p_index: 0 });

    const { data: todo } = await serviceClient
      .from("tasks").select("id,position").eq("project_id", project)
      .eq("status", "todo").order("position");
    expect(todo?.map((t) => t.position)).toEqual([0, 1]);

    const { data: done } = await serviceClient
      .from("tasks").select("id,position").eq("project_id", project).eq("status", "done");
    expect(done?.[0]?.position).toBe(0);
  });

  it("denies move_task on a project the caller cannot see", async () => {
    const hidden = `p_hidden_${stamp}`;
    await createProject({ id: hidden, name: "Hidden", restricted: true, createdBy: ids.admin });
    const hiddenTask = `t_hidden_${stamp}`;
    await serviceClient.from("tasks").insert({
      id: hiddenTask, project_id: hidden, title: "Secret",
      status: "todo", created_by: ids.admin, position: 0,
    });

    const client = await signInAs(emails.member, TEST_PASSWORD);
    const { error } = await client.rpc("move_task", {
      p_task_id: hiddenTask, p_status: "done", p_index: 0,
    });
    expect(error).not.toBeNull();

    await serviceClient.from("projects").delete().eq("id", hidden);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/rls/invariants.test.ts`
Expected: FAIL — the delete succeeds where the test expects an error, and `move_task` is not a known function.

- [ ] **Step 4: Push and regenerate**

```bash
npm run db:push
npm run db:types
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/rls/invariants.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all green. The full RLS suite takes 30-60s because every call is a network round trip to the dev project.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/ lib/database.types.ts tests/rls/invariants.test.ts
git commit -m "feat: enforce business invariants in the database

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Definition of done

- `npm run typecheck && npm run lint && npm test && npm run build` all pass locally and in CI.
- Every table in the spec exists in `lumina-dev` with RLS enabled and no table readable by an unauthenticated client.
- 39 tests pass, covering each spec-named leak path: private channels, restricted projects, DMs you are not in, other users' read state, and role mutation — each asserting the denial explicitly, not merely an empty result.
- The shipped app is byte-for-byte unchanged in behaviour: it still runs on localStorage, and `tomit1980.github.io/lumina` still works exactly as before.
- No secret is committed: `git log -p | grep -i service_role` returns nothing.

## What this plan deliberately does not do

Plan 2 swaps `lib/auth.tsx` and `lib/store.tsx` onto Supabase and strips the demo affordances. Plan 3 adds Realtime, presence, and Storage. Plan 4 is the production cutover. Until Plan 2 lands, the schema built here is exercised only by tests — that is intentional, so a policy mistake is caught before any real data depends on it.
