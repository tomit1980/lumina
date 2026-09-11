/**
 * A person's own details — name, handle, title — against Postgres.
 *
 * Separate from roles.ts, which owns the other `profiles` write (`role_id`)
 * and is about the role system rather than the person.
 *
 * TWO POLICIES ALLOW THIS AND NEITHER IS RESTATED HERE.
 * `profiles_update_self` grants a blanket UPDATE on your own row;
 * `profiles_admin_write` gives a `members.manage` holder everyone's
 * (20260906000100_identity.sql). Every trigger on the table is scoped to
 * `role_id`, `mfa_required` or `must_change_password` and returns NEW
 * untouched otherwise, so nothing guards these three columns. The store's
 * guard exists for the sentence; this is the rule.
 *
 * THE UNIQUE INDEX IS THE HANDLE RULE. `profiles.handle` is `not null unique`,
 * so a collision arrives as a raw 23505 whichever path takes it — the dialog,
 * a direct PostgREST call, or a race between two people claiming the same
 * handle in the same second. The store checks first for the message; only this
 * constraint can actually stop it.
 */
import { fail, requireRows } from "./result";
import type { LuminaClient } from "./client";
import type { ProfilePatch } from "../types";

export async function updateProfile(
  client: LuminaClient,
  userId: string,
  patch: ProfilePatch
): Promise<void> {
  const what = "saving those details";

  const { data, error } = await client
    .from("profiles")
    .update({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.handle !== undefined ? { handle: patch.handle } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    })
    .eq("id", userId)
    .select("id");

  // Translated where it is raised rather than in the dialog: this is the one
  // place that knows a 23505 on this table can only be the handle.
  if (error?.code === "23505") {
    throw new Error(`${what} failed: that handle is already taken`);
  }
  if (error) fail(what, error);

  // Zero rows with no error is a policy filtering the update out — the
  // false-success shape `requireRows` exists for. It is reachable here: a
  // member aiming at somebody else's row gets exactly this.
  requireRows(what, "you can only edit your own details", { data, error: null });
}
