// Controller-written probe for the project/task policies. Attacks the live
// database directly rather than trusting the task's own suite.
import { createClient } from "@supabase/supabase-js";

// Loads the env file and decides dev-vs-production. See ./_target.mjs.
import "./_target.mjs";
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-7c1d";
const SECRET_PROJ = `p_probe_secret_${stamp}`;
const OPEN_PROJ = `p_probe_open_${stamp}`;
const SECRET_TASK_TITLE = `ACQUISITION TERMS ${stamp}`;
const ids = {};
let failures = 0;
let checks = 0;
const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};

const mkUser = async (who, roleId) => {
  const email = `pprobe-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Record before the profile step: if that throws, the finally block
  // must still be able to delete this auth user.
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `pp${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  ids[who] = data.user.id;
};
const signIn = async (who) => {
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: `pprobe-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  return c;
};

try {
  await mkUser("owner", "admin");
  await mkUser("editor", "member");
  await mkUser("viewer", "member");
  await mkUser("outsider", "member");

  // An OPEN project everyone can see — the positive control that proves the
  // query mechanism works, so an empty result later means denial, not breakage.
  await svc.from("projects").insert({
    id: OPEN_PROJ, name: "Open", description: "", emoji: "📁", color: "#000",
    priority: "medium", restricted: false, created_by: ids.owner,
  });
  // A RESTRICTED project with one editor, one viewer, and a secret task.
  await svc.from("projects").insert({
    id: SECRET_PROJ, name: "Acquisition", description: "", emoji: "🔒", color: "#000",
    priority: "high", restricted: true, created_by: ids.owner,
  });
  await svc.from("project_members").insert([
    { project_id: SECRET_PROJ, user_id: ids.editor, level: "editor" },
    { project_id: SECRET_PROJ, user_id: ids.viewer, level: "viewer" },
  ]);
  const t = await svc.from("tasks").insert({
    id: `t_probe_${stamp}`, project_id: SECRET_PROJ, title: SECRET_TASK_TITLE,
    description: "", status: "todo", priority: "high", created_by: ids.owner, position: 0,
  });
  if (t.error) throw new Error(`seed task: ${t.error.message}`);

  // ---------- OUTSIDER ----------
  const out = await signIn("outsider");
  const ctrl = await out.from("projects").select("id").eq("id", OPEN_PROJ);
  check("positive control: outsider CAN see the open project", (ctrl.data ?? []).length === 1);

  const sec = await out.from("projects").select("id,name").eq("id", SECRET_PROJ);
  check("outsider cannot see the restricted project", (sec.data ?? []).length === 0);

  const allProj = await out.from("projects").select("id");
  check("restricted project absent from an unfiltered list",
    !(allProj.data ?? []).some((p) => p.id === SECRET_PROJ), `sees ${(allProj.data ?? []).length}`);

  const secTasks = await out.from("tasks").select("id,title");
  check("secret task absent from an UNFILTERED task scan",
    !(secTasks.data ?? []).some((r) => (r.title ?? "").includes(SECRET_TASK_TITLE)),
    `scanned ${(secTasks.data ?? []).length}`);

  const mem = await out.from("project_members").select("user_id").eq("project_id", SECRET_PROJ);
  check("outsider cannot enumerate the restricted project's members",
    (mem.data ?? []).length === 0);

  const selfJoin = await out.from("project_members").insert({
    project_id: SECRET_PROJ, user_id: ids.outsider, level: "editor",
  });
  check("outsider cannot insert themselves as a project member",
    selfJoin.error !== null, selfJoin.error?.code ?? "NO ERROR RAISED — JOINED");

  const stillHidden = await out.from("tasks").select("title").eq("project_id", SECRET_PROJ);
  check("outsider still cannot read its tasks after the join attempt",
    (stillHidden.data ?? []).length === 0);

  const spoof = await out.from("projects").insert({
    id: `p_spoof_${stamp}`, name: "spoof", description: "", emoji: "📁", color: "#000",
    priority: "low", restricted: false, created_by: ids.owner,
  });
  check("member cannot create a project attributed to someone else",
    spoof.error !== null, spoof.error?.code ?? "NO ERROR RAISED");

  // ---------- VIEWER (can see, must not write) ----------
  const view = await signIn("viewer");
  const vSee = await view.from("tasks").select("title").eq("project_id", SECRET_PROJ);
  check("viewer CAN read the restricted project's tasks", (vSee.data ?? []).length === 1);

  const vCreate = await view.from("tasks").insert({
    id: `t_viewer_${stamp}`, project_id: SECRET_PROJ, title: "viewer task",
    description: "", status: "todo", priority: "low", created_by: ids.viewer, position: 1,
  });
  check("viewer cannot create a task", vCreate.error !== null,
    vCreate.error?.code ?? "NO ERROR RAISED");

  await view.from("tasks").update({ title: "tampered" }).eq("id", `t_probe_${stamp}`);
  const { data: afterEdit } = await svc.from("tasks").select("title").eq("id", `t_probe_${stamp}`).single();
  check("viewer cannot edit an existing task", afterEdit?.title === SECRET_TASK_TITLE,
    `title is "${afterEdit?.title}"`);

  await view.from("tasks").delete().eq("id", `t_probe_${stamp}`);
  const { data: afterDel } = await svc.from("tasks").select("id").eq("id", `t_probe_${stamp}`);
  check("viewer cannot delete a task", (afterDel ?? []).length === 1);

  await view.from("projects").update({ name: "hijacked" }).eq("id", SECRET_PROJ);
  const { data: afterProj } = await svc.from("projects").select("name").eq("id", SECRET_PROJ).single();
  check("viewer cannot rename the project", afterProj?.name === "Acquisition",
    `name is "${afterProj?.name}"`);

  const vPromote = await view.from("project_members")
    .update({ level: "editor" }).eq("project_id", SECRET_PROJ).eq("user_id", ids.viewer);
  const { data: lvl } = await svc.from("project_members")
    .select("level").eq("project_id", SECRET_PROJ).eq("user_id", ids.viewer).single();
  check("viewer cannot promote themselves to editor", lvl?.level === "viewer",
    `level is "${lvl?.level}"${vPromote.error ? "" : " (no error raised)"}`);

  // ---------- EDITOR (must still work) ----------
  const ed = await signIn("editor");
  const eCreate = await ed.from("tasks").insert({
    id: `t_editor_${stamp}`, project_id: SECRET_PROJ, title: "editor task",
    description: "", status: "todo", priority: "low", created_by: ids.editor, position: 2,
  });
  check("invited editor CAN create a task (policy is not just denying everyone)",
    eCreate.error === null, eCreate.error?.message ?? "ok");
} catch (err) {
  // A throw here means the checks below never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing — which is exactly what happened when the
  // profile-on-signup trigger started colliding with these fixtures.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  await svc.from("projects").delete().in("id", [SECRET_PROJ, OPEN_PROJ, `p_spoof_${stamp}`]);
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
  console.log(failures === 0 ? "\nALL PROJECT PROBES PASSED" : `\n${failures} PROJECT PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
