# Lumina security rules

Lumina is a **static Next.js export** served from a public URL, talking straight
to Supabase. There is no application server. Two consequences drive every rule
below: anything the bundle holds, its reader holds; and **RLS is the only
boundary** — a check that exists only in `lib/store.tsx`, `lib/permissions.ts`
or a component is cosmetic.

## Keys and clients

- `NEXT_PUBLIC_SUPABASE_ANON_KEY` in source, env files or the bundle is
  **intentional** — it is the publishable key and grants nothing on its own.
  Do not report it as a hardcoded secret.
- The **secret / service-role key must never appear** under `app/`,
  `components/`, `lib/`, in any `NEXT_PUBLIC_*` name, or in a client-reachable
  module. Only `supabase/functions/**` (and the operator scripts
  `scripts/sweep-orphaned-attachments.mjs`, `tests/rls/*`, which read it from
  the environment) may use it. A service-role client reachable from the browser
  graph is **critical**.
- The browser gets its client from `lib/supabase.ts` / `lib/backend/supabase/client.ts`
  only. A new `createClient(...)` elsewhere in client code is a finding.

## Edge functions

Authority is re-derived from the caller's **token**, never from the request
body — the pattern in `supabase/functions/create-user/index.ts`: resolve the
user via `caller.auth.getUser()`, read their role from `profiles`, check the
permission, then act with the admin client. A function that trusts a
body-supplied `userId`, `roleId`, `role` or permission list as its authority is
an **auth bypass**, even when the UI only shows the button to admins.

## RLS and SQL

- Every new table or column holding workspace data needs its own policies
  **and** must join **both** sign-in gates: `session_is_assured()`
  (`20260910004000`) and `password_is_current()` (`20260912000200`). A table
  outside the first is readable by a password-only `aal1` session on a
  two-factor account; outside the second, by whoever holds the password an
  admin handed out and the user never replaced. Treat either as **high**.
  `public.gate_coverage()` answers which tables are outside; it is asserted by
  `tests/rls/gate-coverage.test.ts`, so a missing policy fails the suite rather
  than waiting for an audit.
- A **`security definer` function is a hole in every restrictive policy** — RLS
  is not consulted inside one. A new definer function that writes must check
  `session_is_assured()` and `password_is_current()` itself, the way
  `find_or_create_dm` does. Prefer `security invoker` (as
  `create_project_with_tasks` does) whenever the function does not need to
  escape RLS.
- Widen nothing by restatement. New cross-cutting rules go in **restrictive**
  policies that AND onto the existing ones; copying existing predicates into a
  new policy is the drift shape this repo has already been burned by (Task 6).
- New `security definer` functions must pin `set search_path` (`''` or
  `public`, matching neighbours), `revoke all ... from public`, and grant
  execute explicitly. A definer function with an unpinned search_path is
  **high**.
- Role writes must not escape `enforce_role_rank` / `roles_block_locked_update`:
  a caller can never grant a permission they do not hold, nor write a role whose
  `rank` is **strictly above** their own. Peer-rank and self-edits are allowed
  on purpose (`20260910007000`) — do not report those as escalation.
- `created_by` / `uploaded_by` are frozen by trigger. A client-supplied value
  for either is a finding.

## Storage

Object keys are the **attachment id alone** — never a project id, user id or
file name, because a signed URL exposes its own path to anyone it is forwarded
to. Storage policies must **call** `can_see_attachment()` / `attachment_of_object()`
rather than re-deriving visibility.

## Rendering

Any `dangerouslySetInnerHTML` or `innerHTML` must be fed from
`DOMPurify.sanitize` with remote-resource and target hardening, as in
`components/documents/markdown-editor.tsx`. Markdown, `.docx` and spreadsheet
import paths all count as untrusted input.

## Known boundaries — not new findings

- The `local` backend (`lib/backend/local.ts`, `lib/totp.ts`) verifies
  credentials client-side for the browser-only demo. That is documented and
  deliberate. A **new** client-side check of a real credential is still a
  finding.
- `tests/probes/*` and `tests/rls/*` deliberately attempt unauthorized reads
  and hold test credentials. Do not report the attack itself as a vulnerability.
