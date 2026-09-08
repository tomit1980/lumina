// Do the invariants hold against a real CLIENT — the only attacker that matters?
// Task 8 added a session_user='supabase_auth_admin' bypass to the last-admin
// trigger so auth-user deletion can cascade. This checks that bypass is not
// reachable from an ordinary signed-in session.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.test.local", quiet: true });
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-7c1d";
const PROJ = `p_inv_${stamp}`;
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
  const email = `inv-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Record before the profile step: if that throws, the finally block
  // must still be able to delete this auth user.
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `iv${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  ids[who] = data.user.id;
};
const as = async (who) => {
  if (clients[who]) return clients[who];
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: `inv-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  clients[who] = c;
  return c;
};

try {
  await mkUser("boss", "admin");
  await mkUser("second", "admin");
  await mkUser("plain", "member");

  const boss = await as("boss");
  const plain = await as("plain");

  // --- an ordinary member must not touch roles at all
  const demote = await plain.from("profiles").update({ role_id: "guest" }).eq("id", ids.boss);
  const { data: bossRole } = await svc.from("profiles").select("role_id").eq("id", ids.boss).single();
  check("a member cannot demote an admin", bossRole?.role_id === "admin",
    `role is "${bossRole?.role_id}"${demote.error ? "" : " (no error raised)"}`);

  const selfPromote = await plain.from("profiles").update({ role_id: "admin" }).eq("id", ids.plain);
  const { data: plainRole } = await svc.from("profiles").select("role_id").eq("id", ids.plain).single();
  check("a member cannot promote themselves to admin", plainRole?.role_id === "member",
    `role is "${plainRole?.role_id}"${selfPromote.error ? "" : " (no error raised)"}`);

  // --- an admin cannot change their OWN role, by design (store.tsx:420)
  const selfDemote = await boss.from("profiles").update({ role_id: "member" }).eq("id", ids.boss);
  const { data: afterSelf } = await svc.from("profiles").select("role_id").eq("id", ids.boss).single();
  check("an admin cannot change their own role", afterSelf?.role_id === "admin",
    `${selfDemote.error ? "blocked: " + selfDemote.error.code : "NO ERROR RAISED"}`);

  // --- last-admin protection, from a client session
  await svc.from("profiles").update({ role_id: "member" }).eq("id", ids.second);
  const { data: admins } = await svc.from("profiles").select("id").eq("role_id", "admin");
  const onlyBoss = (admins ?? []).length === 1 && admins[0].id === ids.boss;
  console.log(`      (there ${onlyBoss ? "is exactly one admin" : `are ${(admins ?? []).length} admins`} in the project now)`);

  if (onlyBoss) {
    const second = await as("second");
    const killLast = await second.from("profiles").update({ role_id: "member" }).eq("id", ids.boss);
    const { data: stillAdmin } = await svc.from("profiles")
      .select("role_id").eq("id", ids.boss).single();
    check("the last admin cannot be demoted from a client session",
      stillAdmin?.role_id === "admin",
      `${killLast.error ? "blocked: " + killLast.error.code : "NO ERROR RAISED"}`);

    // The service role must ALSO be blocked on a direct demote — the bypass
    // Task 8 added is meant to cover only auth-service cascade deletes.
    const svcDemote = await svc.from("profiles").update({ role_id: "member" }).eq("id", ids.boss);
    const { data: afterSvc } = await svc.from("profiles")
      .select("role_id").eq("id", ids.boss).single();
    check("even the service role cannot directly demote the last admin",
      afterSvc?.role_id === "admin",
      `${svcDemote.error ? "blocked: " + svcDemote.error.code : "NO ERROR RAISED"}`);
  }

  // --- a role with members cannot be deleted
  const roleId = `r_inv_${stamp}`;
  await svc.from("roles").insert({
    id: roleId, name: "Probe Role", description: "", color: "#000",
    permissions: ["message.send"], is_system: false, locked: false,
  });
  await svc.from("profiles").update({ role_id: roleId }).eq("id", ids.plain);
  const delRole = await svc.from("roles").delete().eq("id", roleId);
  const { data: roleStill } = await svc.from("roles").select("id").eq("id", roleId);
  check("a role with members cannot be deleted", (roleStill ?? []).length === 1,
    delRole.error ? `blocked: ${delRole.error.message.slice(0, 40)}` : "NO ERROR RAISED");
  await svc.from("profiles").update({ role_id: "member" }).eq("id", ids.plain);
  await svc.from("roles").delete().eq("id", roleId);

  // --- deleting a project must still cascade its members (invariant must not
  //     make the parent undeletable)
  await svc.from("projects").insert({
    id: PROJ, name: "Inv", description: "", emoji: "📁", color: "#000",
    priority: "low", restricted: false, created_by: ids.boss,
  });
  await svc.from("project_members")
    .insert({ project_id: PROJ, user_id: ids.boss, level: "editor" });
  const dropProj = await svc.from("projects").delete().eq("id", PROJ);
  const { data: projStill } = await svc.from("projects").select("id").eq("id", PROJ);
  check("deleting a project still cascades past the creator-editor invariant",
    (projStill ?? []).length === 0,
    dropProj.error ? `BLOCKED: ${dropProj.error.message.slice(0, 60)}` : "deleted");
} catch (err) {
  // A throw here means the checks below never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing — which is exactly what happened when the
  // profile-on-signup trigger started colliding with these fixtures.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  await svc.from("projects").delete().eq("id", PROJ);
  for (const id of Object.values(ids)) await svc.auth.admin.deleteUser(id);
  const { data } = await svc.auth.admin.listUsers({ perPage: 100 });
  console.log(`\ncleanup: ${data.users.length} users remain (expect 0)`);
  console.log(failures === 0 ? "\nALL INVARIANT PROBES PASSED" : `\n${failures} INVARIANT PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
