import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseBackend } from "@/lib/backend/supabase";
import type { AppState } from "@/lib/types";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addProjectMember, createProject, removeProjectMember, seedRoles } from "../helpers/workspace";

// Task 6 — the same question every prior task asked of the query path, asked
// of the LIVE path: does revoked access actually go away for a client that
// is already connected, or does a live feed let it linger?
//
// Everything before this task made the app RECEIVE changes from the server.
// That creates a new way to be wrong: a connected client could keep showing
// a restricted project's data after membership ends, and worse, it would
// look current rather than obviously stale. This is proven here, not
// assumed — against the real dev database, with two real users, exactly the
// way `SupabaseBackend.hydrate()` is called on reconnect (Task 5's "reload
// what was missed").
//
// ONE client, reused before and after the revocation (`clientFor` memoises
// by email — see tests/helpers/supabase.ts). That is deliberate: proving the
// SAME authenticated session loses access on its next request is what shows
// row-level security is re-evaluated live rather than baked into a session
// or a client-side cache. Re-signing-in fresh after the revocation would
// prove nothing about a client that was already connected when access was
// pulled.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const project = `p_rt_revoke_${stamp}`;
const task = `t_rt_revoke_${stamp}`;

const emails = {
  owner: `rtrvowner-${stamp}@lumina.test`,
  member: `rtrvmember-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

/** What the app itself would hold on a reload — the exact call Task 5 makes
 *  on reconnect. */
async function hydrateAs(email: string): Promise<AppState> {
  const client = await clientFor(email);
  return new SupabaseBackend(client).hydrate();
}

beforeAll(async () => {
  await seedRoles();

  // Plain Member, not admin: members.manage would short-circuit
  // can_see_project and make the "loses it" half of this test pass for the
  // wrong reason — bypassing the very membership check under test.
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Rana", handle: `rtrvowner${stamp}`, roleId: "admin",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Milo", handle: `rtrvmember${stamp}`, roleId: "member",
  });

  await createProject({
    id: project, name: "Live Restricted Project", restricted: true, createdBy: ids.owner,
  });
  await addProjectMember(project, ids.member, "editor");
  await serviceClient.from("tasks").insert({
    id: task, project_id: project, title: "Live restricted task",
    created_by: ids.owner, position: 0,
  });

  // Warm the session before the timed assertions below — signInAs's
  // rate-limit backoff can span far longer than a single test's allowance.
  await clientFor(emails.member);
});

afterAll(async () => {
  await serviceClient.from("projects").delete().eq("id", project);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("revocation reaches an already-connected client", () => {
  it("a member removed from a restricted project loses it — and its tasks — on the next reload", async () => {
    // --- POSITIVE CONTROL --------------------------------------------
    // While still a member, a fresh hydrate() shows the restricted project
    // and its task. Without this, a hydrate() that silently threw away
    // every row (or a member who never actually held access in the first
    // place) would make the negative below pass for a reason that has
    // nothing to do with revocation — exactly the trap this plan has
    // already caught five other tests in.
    const before = await hydrateAs(emails.member);
    expect(before.projects.map((p) => p.id)).toContain(project);
    const beforeProject = before.projects.find((p) => p.id === project)!;
    expect(beforeProject.restricted).toBe(true);
    expect(before.tasks.map((t) => t.id)).toContain(task);

    // --- REVOCATION -----------------------------------------------------
    // The owner removes the member's project_members row — "someone with an
    // open browser is removed from a restricted project" from the brief.
    await removeProjectMember(project, ids.member);

    // --- NEGATIVE ---------------------------------------------------------
    // The SAME client (its cached session, unchanged) reloads. The project,
    // and every task scoped to it, must be gone: a live feed must not
    // preserve stale access.
    const after = await hydrateAs(emails.member);
    expect(after.projects.map((p) => p.id)).not.toContain(project);
    expect(after.tasks.map((t) => t.id)).not.toContain(task);
    expect(after.tasks.filter((t) => t.projectId === project)).toHaveLength(0);
  });
});
