// Controller probe for public.task_collaborators (20260907000600).
//
// Independent of the vitest suite on purpose: it signs in as a real anon
// client and ATTACKS the table rather than describing it. The seven probes in
// .superpowers/sdd/2026-09-06-lumina-backend-foundation/*_probe.mjs caught 13
// holes the suites had missed; this one follows attachment_probe.mjs's shape.
//
// Two rules learned the hard way, both enforced below:
//   * `.select("*", { head: true })` WITHOUT `count` returns error === null
//     even for a table that does not exist. Every read assertion here uses
//     `{ count: "exact", head: true }` and inspects `count`, and probe 0 runs
//     that exact query against a table name that cannot exist, so a run in
//     which the technique has silently stopped working FAILS instead of
//     passing vacuously.
//   * Every denial is paired with a positive control on the same table, the
//     same query shape and the same client, so "denied" is never confused
//     with "the query never worked".
//
// Sign-ins are memoised: Supabase rate-limits repeated signInWithPassword.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.test.local", quiet: true });
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-7c1d";
const OPEN = `p_col_open_${stamp}`;
const SECRET = `p_col_secret_${stamp}`;
const LONE = `p_col_lone_${stamp}`;
const T_OPEN = `t_col_open_${stamp}`;
const T_SECRET = `t_col_secret_${stamp}`;
const T_LONE = `t_col_lone_${stamp}`;
const ids = {};
const clients = {};
let failures = 0;
let checks = 0;

const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};

const mkUser = async (who, roleId) => {
  const email = `col-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Record before the profile step: if that throws, the finally block
  // must still be able to delete this auth user.
  ids[who] = data.user.id;
  // upsert, not insert: handle_new_user (20260908000800_store_swap.sql) now
  // creates the profile the instant the auth user exists, so a plain insert
  // collides on the primary key. The upsert overwrites the trigger's derived
  // name/handle/role with this fixture's chosen ones, which is exactly what
  // tests/helpers/supabase.ts's createTestUser already does. No assertion in
  // this probe changes.
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `co${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  ids[who] = data.user.id;
};

const as = async (who) => {
  if (clients[who]) return clients[who];
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: `col-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  clients[who] = c;
  return c;
};

// Every read goes through here: count is the observable, never `error === null`.
const countOf = async (client, filter = (q) => q) =>
  filter(client.from("task_collaborators").select("*", { count: "exact", head: true }));

const rowExists = async (taskId, userId) => {
  const { data } = await svc.from("task_collaborators")
    .select("user_id").eq("task_id", taskId).eq("user_id", userId);
  return (data ?? []).length > 0;
};

try {
  // ------------------------------------------------------------------
  // Probe 0 — meta-control. Proves the measuring instrument discriminates
  // before anything is measured with it.
  //
  // progress.md's caution said `.select("*", { head: true })` WITHOUT `count`
  // returns error === null for a table that does not exist, and that passing
  // `{ count: "exact" }` was the fix. Measured here: that mitigation is NOT
  // sufficient. A head request against a missing table returns
  // error=null, count=null, status=204 WITH `count: "exact"` too — the count
  // option changes nothing. Only a body select (no head) surfaces PGRST205.
  //
  // So the real discriminator is that `count` comes back as a NUMBER only
  // from a table that actually exists and was actually queried; a bogus or
  // broken request yields null. Every assertion in this probe therefore
  // compares count strictly against a number (`=== 0`, `=== 1`) and never
  // coalesces with `?? 0`, which would silently convert a vacuous null into
  // a passing zero. These three checks pin all of that down.
  const bogusName = `table_that_does_not_exist_${stamp}`;
  const bogusHead = await svc.from(bogusName).select("*", { count: "exact", head: true });
  check("meta-control: a missing table yields count=null, NOT a number (the real trap)",
    bogusHead.count === null,
    `err=${bogusHead.error?.code ?? "null"} count=${bogusHead.count} status=${bogusHead.status}`);

  const bogusBody = await svc.from(bogusName).select("*");
  check("meta-control: ...and a BODY select does surface the missing table",
    bogusBody.error !== null, bogusBody.error?.code ?? "NO ERROR RAISED");

  const realHead = await svc.from("task_collaborators")
    .select("*", { count: "exact", head: true });
  check("meta-control: a real table yields a numeric count, so `=== 0` is a live assertion",
    typeof realHead.count === "number",
    `count=${realHead.count} status=${realHead.status}`);

  // ------------------------------------------------------------------
  // Fixtures. `attacker` and `insider` hold the seeded Member role
  // (task.edit, but NOT members.manage) — an admin would satisfy every
  // visibility gate trivially and the probe would prove nothing.
  await mkUser("owner", "admin");
  await mkUser("insider", "member");
  await mkUser("attacker", "member");
  await mkUser("victim", "member");
  await mkUser("lone", "member");

  await svc.from("projects").insert([
    { id: OPEN, name: "Open", description: "", emoji: "📁", color: "#000",
      priority: "medium", restricted: false, created_by: ids.owner },
    { id: SECRET, name: "Acquisition", description: "", emoji: "🔒", color: "#000",
      priority: "high", restricted: true, created_by: ids.owner },
    // Restricted, created by `lone`, and given NO members at all — the
    // creator-clause parity case from the ledger's Task 2 ruling.
    { id: LONE, name: "Solo", description: "", emoji: "🕵️", color: "#000",
      priority: "low", restricted: true, created_by: ids.lone },
  ]);
  await svc.from("project_members").insert([
    { project_id: SECRET, user_id: ids.insider, level: "editor" },
    { project_id: SECRET, user_id: ids.victim, level: "editor" },
  ]);
  await svc.from("tasks").insert([
    { id: T_OPEN, project_id: OPEN, title: "public work", description: "",
      status: "todo", priority: "medium", created_by: ids.owner, position: 0 },
    { id: T_SECRET, project_id: SECRET, title: "term sheet", description: "",
      status: "todo", priority: "high", assignee_id: ids.owner,
      created_by: ids.owner, position: 0 },
    { id: T_LONE, project_id: LONE, title: "solo work", description: "",
      status: "todo", priority: "low", created_by: ids.lone, position: 0 },
  ]);
  // The row the attacker must never learn about.
  const seed = await svc.from("task_collaborators")
    .insert({ task_id: T_SECRET, user_id: ids.victim });
  if (seed.error) throw new Error(`seed collaborator: ${seed.error.message}`);

  const atk = await as("attacker");
  const ins = await as("insider");

  // ------------------------------------------------------------------
  // Probe 1 — positive control. The attacker CAN see collaborator rows on a
  // project they are entitled to (open project). Without this, every zero
  // below could just mean the table is unreadable to everyone.
  const ctrlSeed = await svc.from("task_collaborators")
    .insert({ task_id: T_OPEN, user_id: ids.victim });
  if (ctrlSeed.error) throw new Error(`seed control collaborator: ${ctrlSeed.error.message}`);
  const ctrl = await countOf(atk, (q) => q.eq("task_id", T_OPEN));
  check("positive control: attacker CAN read a collaborator row on an open project",
    ctrl.error === null && ctrl.count === 1,
    `count=${ctrl.count} err=${ctrl.error?.code ?? "none"}`);

  // ------------------------------------------------------------------
  // Probe 2 — enumeration, targeted. The classic `for all` hole: a USING
  // clause of has_permission('task.edit') would hand every Member the whole
  // restricted project's roster.
  const targeted = await countOf(atk, (q) => q.eq("task_id", T_SECRET));
  check("attacker cannot count collaborator rows on a restricted project's task",
    targeted.count === 0, `count=${targeted.count}`);

  // ------------------------------------------------------------------
  // Probe 3 — enumeration, unfiltered sweep. Never naming the task at all.
  const sweep = await atk.from("task_collaborators").select("task_id,user_id");
  const leaked = (sweep.data ?? []).filter((r) => r.task_id === T_SECRET);
  check("attacker cannot find the row by sweeping the whole table",
    leaked.length === 0, `swept ${(sweep.data ?? []).length} row(s), ${leaked.length} leaked`);

  // Probe 3b — and cannot infer the victim's identity by filtering on it.
  const byUser = await countOf(atk, (q) => q.eq("user_id", ids.victim).eq("task_id", T_SECRET));
  check("attacker cannot confirm a specific person is on a hidden task",
    byUser.count === 0, `count=${byUser.count}`);

  // ------------------------------------------------------------------
  // Probe 4 — self-insertion into someone else's restricted task. The whole
  // point of the table: joining a task must not be a way to join a project.
  const selfAdd = await atk.from("task_collaborators")
    .insert({ task_id: T_SECRET, user_id: ids.attacker });
  check("attacker cannot add THEMSELVES to a restricted project's task",
    selfAdd.error !== null, selfAdd.error?.code ?? "NO ERROR RAISED");
  check("  ...and no row was planted",
    !(await rowExists(T_SECRET, ids.attacker)));

  // ------------------------------------------------------------------
  // Probe 5 — an insider smuggling an outsider in. The insider passes every
  // policy bar (task.edit, project visible, editor); only the invariant
  // trigger can stop this, and P0001 proves it is the trigger that did.
  const smuggle = await ins.from("task_collaborators")
    .insert({ task_id: T_SECRET, user_id: ids.attacker });
  check("insider cannot smuggle an outsider onto the task (trigger)",
    smuggle.error !== null && smuggle.error.code === "P0001",
    smuggle.error ? smuggle.error.code : "NO ERROR RAISED");
  check("  ...and no row was planted",
    !(await rowExists(T_SECRET, ids.attacker)));

  // Probe 5b — positive control for the SAME client and shape: the insider
  // CAN add someone who genuinely can see the project. Proves probe 5 is the
  // trigger firing, not a blanket write failure for this identity.
  const legit = await ins.from("task_collaborators")
    .insert({ task_id: T_SECRET, user_id: ids.insider });
  check("positive control: insider CAN add a visible person to the same task",
    legit.error === null, legit.error?.code ?? "ok");
  await svc.from("task_collaborators")
    .delete().eq("task_id", T_SECRET).eq("user_id", ids.insider);

  // ------------------------------------------------------------------
  // Probe 6 — adding the owner, who is by definition visible. Only the
  // owner/collaborator disjointness rule can refuse this one.
  const dupOwner = await ins.from("task_collaborators")
    .insert({ task_id: T_SECRET, user_id: ids.owner });
  check("insider cannot add the task's own owner as a collaborator",
    dupOwner.error !== null && dupOwner.error.code === "P0001",
    dupOwner.error ? dupOwner.error.code : "NO ERROR RAISED");
  check("  ...and no row was planted",
    !(await rowExists(T_SECRET, ids.owner)));

  // ------------------------------------------------------------------
  // Probe 7 — planting a row on a task in a project the attacker cannot see
  // at all, naming someone who CAN see it (the insider, deliberately: they
  // hold no row yet, so a refusal here cannot be a primary-key conflict
  // masquerading as authorisation). The trigger's visibility check passes for
  // this user, so ONLY the insert policy can refuse — which is exactly the
  // "policy, not just trigger" coverage the pair of probes 5/7 is for.
  const plant = await atk.from("task_collaborators")
    .insert({ task_id: T_SECRET, user_id: ids.insider });
  check("attacker cannot plant a row naming a legitimate member (policy, not trigger)",
    plant.error !== null && plant.error.code === "42501",
    plant.error ? plant.error.code : "NO ERROR RAISED");
  check("  ...and no row was planted",
    !(await rowExists(T_SECRET, ids.insider)));

  // ------------------------------------------------------------------
  // Probe 8 — deletion. Removing someone else's collaborator row is a write
  // the attacker must not have. A DELETE denied by USING reports no error,
  // so survival is the assertion.
  await atk.from("task_collaborators")
    .delete().eq("task_id", T_SECRET).eq("user_id", ids.victim);
  check("attacker cannot delete a collaborator row on a hidden task",
    await rowExists(T_SECRET, ids.victim));

  // ------------------------------------------------------------------
  // Probe 9 — there is deliberately no UPDATE policy, and this is why:
  // rewriting user_id in place would swap a legitimate collaborator for
  // anyone at all while only the pre-image was ever checked, bypassing the
  // insert trigger entirely (an outsider could be written straight in).
  // Attempted by the INSIDER, who holds every insert/delete right on this
  // task — so a refusal here can only be the missing update policy.
  await ins.from("task_collaborators")
    .update({ user_id: ids.attacker }).eq("task_id", T_SECRET).eq("user_id", ids.victim);
  const stayed = await rowExists(T_SECRET, ids.victim);
  const hijacked = await rowExists(T_SECRET, ids.attacker);
  check("no UPDATE path exists: the collaborator row still names the original person",
    stayed === true, `original row present=${stayed}`);
  check("  ...and the outsider was not written in by update",
    hijacked === false, `attacker row present=${hijacked}`);

  // ------------------------------------------------------------------
  // Probe 10 — anonymous. Both policies are `to authenticated`.
  const anon = createClient(URL, anonKey, { auth: { persistSession: false } });
  const anonRead = await countOf(anon, (q) => q.eq("task_id", T_OPEN));
  // Strictly `=== 0`, never `?? 0`: probe 0 showed a vacuous request returns
  // count=null, which `?? 0` would launder into a pass. The attacker's
  // count=1 on this same task and filter (probe 1) is the paired control
  // proving the row really is there to be leaked.
  check("anonymous client reads zero collaborator rows, open project included",
    anonRead.count === 0, `count=${anonRead.count}`);
  const anonWrite = await anon.from("task_collaborators")
    .insert({ task_id: T_OPEN, user_id: ids.owner });
  check("anonymous client cannot insert",
    anonWrite.error !== null, anonWrite.error?.code ?? "NO ERROR RAISED");

  // ------------------------------------------------------------------
  // Probe 11 — promotion invariant. Promoting a collaborator to owner must
  // strip their collaborator row, or they hold both roles at once.
  const promoted = await ins.from("tasks")
    .update({ assignee_id: ids.victim }).eq("id", T_SECRET);
  check("insider can promote a collaborator to owner (control)",
    promoted.error === null, promoted.error?.code ?? "ok");
  check("promotion removed the collaborator row (owner is never also a collaborator)",
    !(await rowExists(T_SECRET, ids.victim)));

  // ------------------------------------------------------------------
  // Probe 12 — creator parity (ledger ruling, Task 2). `lone` created a
  // restricted project and holds NO project_members row and NOT
  // members.manage: only the creator clause added to can_see_project /
  // user_can_see_project can make this work.
  const { data: loneMembers } = await svc.from("project_members")
    .select("user_id").eq("project_id", LONE);
  check("fixture check: the lone creator really has no membership row",
    (loneMembers ?? []).length === 0, `${(loneMembers ?? []).length} member row(s)`);

  const lone = await as("lone");
  const loneProj = await lone.from("projects")
    .select("*", { count: "exact", head: true }).eq("id", LONE);
  check("a restricted project's creator can read it with no membership row (can_see_project)",
    loneProj.count === 1, `count=${loneProj.count}`);

  // Boundary, probed BEFORE the row is seeded (it needs a task with no row
  // yet). Parity was required for VISIBILITY only: project_is_viewer_only is
  // untouched and has no creator clause — matching lib/store.tsx's
  // projectIsViewerOnly (lines 206-210) exactly — so a creator holding no
  // editor membership row still cannot WRITE. Widening that function would
  // loosen tasks_insert / tasks_update / task_attachments as well.
  //
  // The creator names THEMSELVES, deliberately: they clear the insert trigger
  // (visible, not the task's owner), so only the policy can refuse. A BEFORE
  // INSERT trigger runs BEFORE the RLS WITH CHECK is evaluated, so naming
  // someone the trigger rejects would raise P0001 and never reach the policy
  // — the assertion would then prove nothing about the policy at all.
  const loneWrite = await lone.from("task_collaborators")
    .insert({ task_id: T_LONE, user_id: ids.lone });
  check("creator visibility did NOT leak into write access (viewer-only holds)",
    loneWrite.error !== null && loneWrite.error.code === "42501",
    loneWrite.error ? loneWrite.error.code : "NO ERROR RAISED");

  // The trigger's own visibility check must nevertheless agree for a user
  // with no membership row: if user_can_see_project lacked the creator clause
  // this service-side seed would raise P0001 instead of succeeding.
  const loneSeed = await svc.from("task_collaborators")
    .insert({ task_id: T_LONE, user_id: ids.lone });
  check("...and user_can_see_project agrees inside the insert trigger",
    loneSeed.error === null, loneSeed.error?.message ?? "ok");

  const loneRead = await countOf(lone, (q) => q.eq("task_id", T_LONE));
  check("the creator can read that row through the RLS read policy",
    loneRead.count === 1, `count=${loneRead.count}`);

  const loneHidden = await countOf(atk, (q) => q.eq("task_id", T_LONE));
  check("negative control: the attacker still cannot see that project's rows",
    loneHidden.count === 0, `count=${loneHidden.count}`);
} catch (err) {
  // A throw here means the checks below never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing — which is exactly what happened when the
  // profile-on-signup trigger started colliding with these fixtures.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  await svc.from("projects").delete().in("id", [OPEN, SECRET, LONE]);
  for (const id of Object.values(ids)) await svc.auth.admin.deleteUser(id);
  const { data } = await svc.auth.admin.listUsers({ perPage: 100 });
  console.log(`\ncleanup: ${data.users.length} users remain (expect 0)`);
  console.log(failures === 0 ? "\nALL COLLABORATOR PROBES PASSED" : `\n${failures} COLLABORATOR PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
