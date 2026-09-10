/**
 * The write path for the two tables that decide what everybody else may do —
 * `roles` and `profiles.role_id` (store-swap Task 8). `SupabaseBackend`
 * delegates `setUserRole`, `createRole`, `updateRole`, `setRolePermission` and
 * `deleteRole` here, the same way it delegates chat to `./chat`, channels and
 * projects to `./workspace`, and the board to `./tasks`.
 *
 * Everything the earlier files established still holds (a filtered-away write
 * is a failure and not a success; the store has already patched the screen;
 * race-prone decisions belong to the server). Four rules are specific to this
 * file, and each is a privilege bug rather than a glitch when it is got wrong.
 *
 * **1. Guard and policy must name the same permission.** Task 7 shipped a
 * `move_task` RPC whose UPDATEs ran under a policy demanding `task.edit` while
 * the store guarded `task.move`: a role holding move-but-not-edit got a clean
 * success having moved nothing. Every write below was checked against the
 * policy that actually gates it, and the comparison is in
 * `.superpowers/sdd/2026-09-08-store-swap/task-8-report.md`. Four of the five
 * match exactly — `roles_write` (20260906000100_identity.sql) is
 * `has_permission('members.manage')` in both USING and WITH CHECK, which is the
 * store's guard for all five actions.
 *
 * `setUserRole` is the one that does not, and it diverges the *loose* way:
 * `profiles` carries two permissive UPDATE policies, and permissive policies
 * are OR-ed. `profiles_admin_write` demands `members.manage`; `profiles_
 * update_self` demands only `id = auth.uid()`. So the server does **not**
 * require `members.manage` for a self-targeted row — what stops a member
 * promoting themselves is the `profiles_block_self_role_change` trigger, not
 * RLS. The trigger closes it completely (any `role_id` change to your own row
 * raises), but "the only thing between a member and the admin role is one
 * trigger" is worth stating out loud, and `setUserRole` below re-imposes the
 * missing half explicitly so this backend's requirement equals the store's
 * guard rather than merely ending in the same place.
 *
 * **2. One statement per write, because the caller can be editing their own
 * powers.** Task 6's rule was that `RETURNING` applies the SELECT policy to the
 * row as the scan finds it; the general form is that a write which narrows the
 * caller's own access must not be followed by another statement that needs it.
 * `roles` is the sharpest possible case: `roles_write`'s USING is
 * `has_permission('members.manage')`, and the row being updated may be the
 * caller's own role. Splitting `updateRole` into "the scalar fields, then the
 * permissions" would let the permissions statement revoke `members.manage` and
 * the next statement be filtered to zero rows — half-applied, and reported as a
 * permission error. So the patch is assembled into exactly one UPDATE.
 *
 * The `RETURNING`s themselves are safe here, by Task 7's discriminator: is any
 * column being *written* an input to the table's SELECT policy? `roles_read` is
 * `using (true)` and `profiles_read` is `using (true)` — no column feeds
 * either — so unlike `is_private`/`restricted` in `./workspace.ts`, reading
 * these rows back cannot fail because of what was just written to them.
 *
 * **3. The invariants live in the database; this file does not re-derive
 * them.** `profiles_block_self_role_change` (20260906000100) and
 * `block_last_admin_removal` / `block_role_delete_with_members`
 * (20260906000500) are triggers, so they hold against anything that reaches
 * Postgres. The store keeps its own copies as an instant, offline-quality
 * refusal; the code below neither duplicates nor second-guesses them — it lets
 * the trigger raise and reports the reason it gave ("You cannot change your own
 * role", "The last admin cannot be demoted or removed", "Role \"X\" still has
 * members"), which is better wording than anything reconstructed from a count.
 *
 * **4. What the database does NOT protect: `locked`.** `roles_write` has no
 * opinion on `is_system` or `locked`, and no trigger covers UPDATE, so the
 * Admin role's permissions are editable by anyone holding `members.manage` if
 * they go around this backend. That is not a privilege escalation — a caller
 * with `members.manage` can already mint a role holding everything — but it is
 * a one-way lockout (revoke `members.manage` from Admin and nobody can ever
 * grant it back). The store refuses it, and `readRole` below refuses it again
 * so the rule survives a caller that skips the UI. A trigger would be the real
 * fix; it is recorded in the task report as a follow-up rather than smuggled in
 * here, since this task owns no migration.
 */
import { fail, requireRows } from "./result";
import { DEFAULT_ROLE_RANK } from "../../permissions";
import { toRole } from "./mapping";
import type { LuminaClient } from "./client";
import type { RolePatch } from "../types";
import type { Permission, RoleDef } from "../../types";

/**
 * The role row, refusing the two states the store refuses.
 *
 * `locked` is the Admin role: locked roles hold every permission by definition,
 * so editing one can only take powers away, and the one power it could take is
 * the ability to give it back (see rule 4 in the file header). `missing` is a
 * role that is not there — RLS cannot hide it (`roles_read` is `using (true)`),
 * so absent really does mean deleted, and reporting it as such beats an UPDATE
 * that matches nothing.
 *
 * Read as one statement so the caller's own `members.manage` cannot be revoked
 * between this and the write it precedes: there is nothing to revoke it yet.
 */
async function readRole(
  client: LuminaClient,
  roleId: string,
  what: string
): Promise<{ locked: boolean; is_system: boolean; permissions: string[]; name: string }> {
  const { data, error } = await client
    .from("roles")
    .select("name,permissions,is_system,locked")
    .eq("id", roleId)
    .maybeSingle();
  if (error) fail(what, error);
  if (!data) throw new Error(`${what} failed: that role no longer exists`);
  if (data.locked) {
    throw new Error(`${what} failed: ${data.name} is a locked role and can't be changed`);
  }
  return data;
}

/**
 * One UPDATE on `profiles`, plus the capability check RLS does not make.
 *
 * The check is the interesting half. `profiles` has two permissive UPDATE
 * policies and Postgres OR-s them, so `profiles_update_self` (`id =
 * auth.uid()`) lets a caller with no permissions at all reach this UPDATE for
 * their own row. Three things can then happen, and none of them is an
 * escalation: a *different* user's row is filtered away by
 * `profiles_admin_write` (zero rows, refused below); their own row with a
 * *different* role raises in `profiles_block_self_role_change`; their own row
 * with the role they already have changes nothing — and quietly *succeeds*.
 * That last one is a lie of exactly the shape this project has removed seven
 * times: `setUserRole` resolving means "the role was set", and for a caller who
 * may not set roles it must not resolve at all.
 *
 * So `members.manage` is asked for explicitly, and the two requests are issued
 * CONCURRENTLY rather than in sequence — the same trade `./tasks.ts`'s
 * `moveTask` makes, and safe for the same reason: in every branch where the
 * answer is `false`, the UPDATE either matched nothing or was rejected by the
 * trigger, so there is never a landed change left behind by the refusal.
 *
 * No last-admin or self-role arithmetic here. Both are triggers
 * (20260906000100 / 20260906000500), they fire for the service key as readily
 * as for a session, and their messages say more than a re-derived count could.
 */
export async function setUserRole(
  client: LuminaClient,
  userId: string,
  roleId: string
): Promise<void> {
  const what = "changing that person's role";

  const [updated, allowed] = await Promise.all([
    client.from("profiles").update({ role_id: roleId }).eq("id", userId).select("id"),
    client.rpc("has_permission", { perm: "members.manage" }),
  ]);

  // The database's own reason first, deliberately. A trigger that raised —
  // "You cannot change your own role", "The last admin cannot be demoted or
  // removed" — says something specific and true, and reporting the generic
  // permission verdict over the top of it would both mislead the user and make
  // the invariant unobservable from the app path: a test could no longer tell a
  // working trigger from this pre-check answering first.
  if (updated.error) fail(what, updated.error);
  if (allowed.error) fail(what, allowed.error);
  if (allowed.data !== true) {
    throw new Error(`${what} failed: your role can't manage members`);
  }
  requireRows(what, "you don't have permission to change this person's role", updated);
}

/**
 * One INSERT, read back so the store adopts the stored row rather than the one
 * it optimistically drew.
 *
 * `is_system` and `locked` are written as literal `false` instead of being
 * taken from the `RoleDef`. The store never sets either (`createRole` builds
 * the role from a `RoleInput` that has no such fields), but `Backend.
 * createRole` takes a whole `RoleDef` where both are optional, and a role that
 * arrived with `is_system: true` would be permanently undeletable —
 * `block_role_delete_with_members` refuses built-ins outright, with no way back
 * short of the service key. Forcing them closes that off at the only place it
 * could ever be opened.
 *
 * `.select()` is safe: `roles_read` is `using (true)`, so no column written
 * above is an input to the policy the RETURNING is evaluated under.
 */
export async function createRole(client: LuminaClient, role: RoleDef): Promise<RoleDef> {
  const what = "creating that role";

  const { data, error } = await client
    .from("roles")
    .insert({
      id: role.id,
      name: role.name,
      description: role.description,
      color: role.color,
      permissions: role.permissions,
      is_system: false,
      locked: false,
      // Forced, like the two flags above, and for the same reason: a
      // caller-supplied rank is an escalation attempt. The trigger refuses
      // anything at or above the creator's own rank anyway — this just means
      // the refusal never has to fire on the app's own path.
      rank: role.rank ?? DEFAULT_ROLE_RANK,
    })
    .select("*");
  if (error) fail(what, error);
  const created = data?.[0];
  if (!created) {
    throw new Error(`${what} failed: you don't have permission to create roles`);
  }
  return toRole(created);
}

/**
 * The whole patch in ONE UPDATE — see rule 2 in the file header. The
 * permissions array travels with the name, the description and the colour
 * precisely so that a caller editing their own role cannot revoke
 * `members.manage` in a first statement and then be refused by `roles_write` in
 * a second, leaving the role half-changed and the failure misattributed.
 *
 * The pre-read is what refuses a locked role, since the database will not.
 */
export async function updateRole(
  client: LuminaClient,
  roleId: string,
  patch: RolePatch
): Promise<void> {
  const what = "updating that role";
  await readRole(client, roleId, what);

  // Spread rather than assignment so the object's inferred type stays exactly
  // the columns being written — PostgREST's generated `Update` type rejects a
  // `Record<string, unknown>`, and a mistyped key would otherwise compile and
  // update nothing.
  const row = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.permissions !== undefined ? { permissions: patch.permissions } : {}),
  };
  // An empty patch is a no-op, not a write: PostgREST rejects an UPDATE with no
  // columns outright, and there is nothing to report a failure about.
  if (Object.keys(row).length === 0) return;

  requireRows(
    what,
    "you don't have permission to change roles",
    await client.from("roles").update(row).eq("id", roleId).select("id")
  );
}

/**
 * One permission on or off, computed from the row that is actually stored
 * rather than from the array the client happened to be holding — the store's
 * optimistic copy can be a hydrate behind, and writing it back would silently
 * reinstate whatever somebody else has changed since.
 *
 * A caveat worth naming rather than hiding: this is a read-modify-write on a
 * single `text[]` column, so two admins toggling *different* permissions on the
 * same role within one round trip still end with the later write's array, and
 * the earlier toggle is lost. Closing that needs the toggle to happen inside
 * Postgres (`array_append`/`array_remove` in an RPC, the way `toggle_reaction`
 * and `move_task` handle their own races); this task owns no migration, so it
 * is recorded in the task report as a follow-up instead of being papered over
 * with a client-side compare-and-set that would report a lost update as a
 * permission error. The window is one request wide on a screen only admins can
 * open.
 *
 * The write is idempotent by construction — `enabled` names the state wanted,
 * not a flip — so re-sending it after a concurrent identical change is a no-op
 * rather than an inversion.
 */
export async function setRolePermission(
  client: LuminaClient,
  roleId: string,
  permission: Permission,
  enabled: boolean
): Promise<void> {
  const what = "changing what that role can do";
  const role = await readRole(client, roleId, what);

  const permissions = enabled
    ? [...new Set([...role.permissions, permission])]
    : role.permissions.filter((p) => p !== permission);

  requireRows(
    what,
    "you don't have permission to change roles",
    await client.from("roles").update({ permissions }).eq("id", roleId).select("id")
  );
}

/**
 * One DELETE. The two reasons a delete is refused are both the database's to
 * give: `block_role_delete_with_members` (20260906000500_invariants.sql) raises
 * `Role "X" still has members` while anybody still holds the role, and
 * `Built-in roles cannot be deleted` for a seeded one — and `profiles.role_id`
 * carries `on delete restrict` underneath it as a second floor. Neither is
 * re-derived here; `fail` passes the trigger's own wording through.
 *
 * The pre-read still runs, for `locked` alone (rule 4). Every locked role this
 * app ships is also `is_system`, so the trigger already covers today's data —
 * the check is here so the backend's rule and the store's rule stay the same
 * sentence rather than agreeing by coincidence.
 *
 * The `deleted the X role` feed line this produces IS persistable, unlike the
 * project and channel deletes in `./workspace.ts`: it is workspace-wide, so
 * both scope foreign keys are null and there is no cascade to outrun. Nothing
 * here arranges that — `commit` in lib/store.tsx diffs the patch and logs it.
 */
export async function deleteRole(client: LuminaClient, roleId: string): Promise<void> {
  const what = "deleting that role";
  const role = await readRole(client, roleId, what);
  if (role.is_system) {
    throw new Error(`${what} failed: ${role.name} is a built-in role and can't be deleted`);
  }

  requireRows(
    what,
    "you don't have permission to delete roles",
    await client.from("roles").delete().eq("id", roleId).select("id")
  );
}
