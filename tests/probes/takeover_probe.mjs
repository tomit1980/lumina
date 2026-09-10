// Does setting created_by to yourself grant ownership? The reviewer found this
// for projects; the same shape exists in channels_update, whose WITH CHECK is
// evaluated against the NEW row. Also tests task re-parenting into a project
// where the actor is merely a viewer.
import { createClient } from "@supabase/supabase-js";

// Loads the env file and decides dev-vs-production. See ./_target.mjs.
import "./_target.mjs";
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-7c1d";
const CH = `c_take_${stamp}`;
const PROJ_A = `p_take_a_${stamp}`;
const PROJ_B = `p_take_b_${stamp}`;
const ids = {};
let failures = 0;
let checks = 0;
const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};
const mkUser = async (who, roleId) => {
  const email = `take-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Record before the profile step: if that throws, the finally block
  // must still be able to delete this auth user.
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `tk${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  ids[who] = data.user.id;
};
const signIn = async (who) => {
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: `take-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  return c;
};

try {
  await mkUser("owner", "admin");
  await mkUser("mallory", "member");   // 5 perms: no project.create, no channel.delete
  // Must NOT be an admin: members.manage makes project_is_viewer_only() return
  // false by design (admins bypass viewer-only, matching projectAccessLevel in
  // the app), so an admin re-parenting a task is correct behaviour, not a hole.
  // The member role has task.edit and task.move, which is all this needs.
  await mkUser("pm", "member");

  // --- CHANNEL takeover: a public channel owned by someone else
  await svc.from("conversations").insert({ id: CH, kind: "channel" });
  await svc.from("channels").insert({
    id: CH, name: "public-take", description: "", is_private: false,
    is_team: false, created_by: ids.owner,
  });

  const mal = await signIn("mallory");
  const chTake = await mal.from("channels")
    .update({ created_by: ids.mallory, name: "seized" }).eq("id", CH);
  const { data: chAfter } = await svc.from("channels")
    .select("created_by,name").eq("id", CH).single();
  check("member cannot seize a channel by setting created_by to themselves",
    chAfter?.created_by === ids.owner,
    `created_by=${chAfter?.created_by === ids.mallory ? "MALLORY (SEIZED)" : "owner"}, name="${chAfter?.name}"${chTake.error ? "" : " (no error raised)"}`);

  // --- PROJECT takeover: an open project owned by someone else
  await svc.from("projects").insert({
    id: PROJ_A, name: "Open A", description: "", emoji: "📁", color: "#000",
    priority: "medium", restricted: false, created_by: ids.owner,
  });
  const projTake = await mal.from("projects")
    .update({ created_by: ids.mallory }).eq("id", PROJ_A);
  const { data: pAfter } = await svc.from("projects")
    .select("created_by").eq("id", PROJ_A).single();
  check("member cannot seize a project by setting created_by to themselves",
    pAfter?.created_by === ids.owner,
    `created_by=${pAfter?.created_by === ids.mallory ? "MALLORY (SEIZED)" : "owner"}${projTake.error ? "" : " (no error raised)"}`);

  // If the seizure worked, the payoff is unconditional member management:
  if (pAfter?.created_by === ids.mallory) {
    const escalate = await mal.from("project_members")
      .insert({ project_id: PROJ_A, user_id: ids.mallory, level: "editor" });
    check("  -> and cannot then grant themselves membership", escalate.error !== null,
      escalate.error?.code ?? "NO ERROR — FULL ESCALATION");
  }

  // --- TASK RE-PARENTING into a project where the actor is only a viewer
  await svc.from("projects").insert({
    id: PROJ_B, name: "Restricted B", description: "", emoji: "🔒", color: "#000",
    priority: "high", restricted: true, created_by: ids.owner,
  });
  // pm is a VIEWER on restricted B, and an EDITOR on open A — so they may edit
  // A's tasks, and must not be able to move one into B.
  await svc.from("project_members").insert([
    { project_id: PROJ_B, user_id: ids.pm, level: "viewer" },
    { project_id: PROJ_A, user_id: ids.pm, level: "editor" },
  ]);
  await svc.from("tasks").insert({
    id: `t_take_${stamp}`, project_id: PROJ_A, title: "movable", description: "",
    status: "todo", priority: "low", created_by: ids.owner, position: 0,
  });

  const pmc = await signIn("pm");
  const reparent = await pmc.from("tasks")
    .update({ project_id: PROJ_B }).eq("id", `t_take_${stamp}`);
  const { data: tAfter } = await svc.from("tasks")
    .select("project_id").eq("id", `t_take_${stamp}`).single();
  check("cannot re-parent a task into a project where you are only a viewer",
    tAfter?.project_id === PROJ_A,
    `project_id=${tAfter?.project_id === PROJ_B ? "MOVED INTO RESTRICTED B" : "still A"}${reparent.error ? "" : " (no error raised)"}`);
} catch (err) {
  // A throw here means the checks below never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing — which is exactly what happened when the
  // profile-on-signup trigger started colliding with these fixtures.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  await svc.from("projects").delete().in("id", [PROJ_A, PROJ_B]);
  await svc.from("conversations").delete().eq("id", CH);
  for (const id of Object.values(ids)) await svc.auth.admin.deleteUser(id);
  const { data } = await svc.auth.admin.listUsers({ perPage: 100 });
  console.log(`\ncleanup: ${data.users.length} users remain (expect 0)`);
  // A probe that asserted nothing must not report success. This is not
  // hypothetical: on 2026-09-08 a new database trigger made every probe's
  // setup throw, and all seven printed PASSED having checked nothing.
  if (checks === 0) {
    failures++;
    console.log("\n*** NO CHECKS RAN — this probe asserted nothing ***");
  }
  console.log(failures === 0 ? "\nALL TAKEOVER PROBES PASSED" : `\n${failures} TAKEOVER PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
