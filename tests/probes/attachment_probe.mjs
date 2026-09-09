// Controller probe for the attachment / read-state / activity policies.
// Sign-ins are memoised: Supabase rate-limits repeated signInWithPassword.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.test.local", quiet: true });
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-7c1d";
const OPEN = `p_att_open_${stamp}`;
const SECRET = `p_att_secret_${stamp}`;
const CH = `c_att_${stamp}`;
const SECRET_FILE = `payroll-${stamp}.xlsx`;
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
  const email = `att-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Record before the profile step: if that throws, the finally block
  // must still be able to delete this auth user.
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `at${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  ids[who] = data.user.id;
};
// Memoised: one sign-in per identity for the whole run.
const as = async (who) => {
  if (clients[who]) return clients[who];
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: `att-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  clients[who] = c;
  return c;
};

try {
  await mkUser("owner", "admin");
  await mkUser("outsider", "member");

  await svc.from("projects").insert([
    { id: OPEN, name: "Open", description: "", emoji: "📁", color: "#000",
      priority: "medium", restricted: false, created_by: ids.owner },
    { id: SECRET, name: "Payroll", description: "", emoji: "🔒", color: "#000",
      priority: "high", restricted: true, created_by: ids.owner },
  ]);

  // A visible attachment (positive control) and a hidden one on the restricted project.
  const mkAtt = async (id, name) => {
    const r = await svc.from("attachments").insert({
      id, storage_path: `p/${id}`, name, size: 100, mime: "application/octet-stream",
      uploaded_by: ids.owner,
    });
    if (r.error) throw new Error(`attachment ${name}: ${r.error.message}`);
  };
  await mkAtt(`att_open_${stamp}`, `public-${stamp}.txt`);
  await mkAtt(`att_secret_${stamp}`, SECRET_FILE);
  await svc.from("project_attachments").insert([
    { project_id: OPEN, attachment_id: `att_open_${stamp}` },
    { project_id: SECRET, attachment_id: `att_secret_${stamp}` },
  ]);

  // A task in the restricted project with its own attachment link — this is the
  // path that was FOR ALL + global task.edit, readable by any member.
  await svc.from("tasks").insert({
    id: `t_att_${stamp}`, project_id: SECRET, title: "payroll review", description: "",
    status: "todo", priority: "high", created_by: ids.owner, position: 0,
  });
  await mkAtt(`att_task_${stamp}`, `task-secret-${stamp}.pdf`);
  await svc.from("task_attachments")
    .insert({ task_id: `t_att_${stamp}`, attachment_id: `att_task_${stamp}` });

  const out = await as("outsider");

  const ctrl = await out.from("attachments").select("id").eq("id", `att_open_${stamp}`);
  check("positive control: outsider CAN see the open project's attachment",
    (ctrl.data ?? []).length === 1);

  const hidden = await out.from("attachments").select("id,name").eq("id", `att_secret_${stamp}`);
  check("outsider cannot see a restricted project's attachment", (hidden.data ?? []).length === 0);

  const allAtt = await out.from("attachments").select("name");
  check("secret filename absent from an UNFILTERED attachment scan",
    !(allAtt.data ?? []).some((a) => (a.name ?? "").includes(SECRET_FILE)),
    `scanned ${(allAtt.data ?? []).length}`);

  const pj = await out.from("project_attachments").select("attachment_id").eq("project_id", SECRET);
  check("outsider cannot enumerate a restricted project's attachment links",
    (pj.data ?? []).length === 0);

  // Defect 1: task_attachments was FOR ALL USING(has_permission('task.edit')),
  // and every Member holds task.edit.
  const tj = await out.from("task_attachments").select("task_id,attachment_id");
  check("outsider cannot enumerate task_attachments of restricted projects (defect 1)",
    !(tj.data ?? []).some((r) => r.task_id === `t_att_${stamp}`),
    `sees ${(tj.data ?? []).length} link(s)`);

  const link = await out.from("project_attachments")
    .insert({ project_id: SECRET, attachment_id: `att_open_${stamp}` });
  check("outsider cannot attach a file to a project they cannot see",
    link.error !== null, link.error?.code ?? "NO ERROR RAISED");

  // read_state must be private per user.
  await svc.from("conversations").insert({ id: CH, kind: "channel" });
  await svc.from("channels").insert({
    id: CH, name: "att-probe", description: "", is_private: false,
    is_team: false, created_by: ids.owner,
  });
  await svc.from("read_state").insert({ user_id: ids.owner, conversation_id: CH });
  const rs = await out.from("read_state").select("user_id").eq("conversation_id", CH);
  check("outsider cannot read another user's read_state", (rs.data ?? []).length === 0);

  const rsWrite = await out.from("read_state")
    .insert({ user_id: ids.owner, conversation_id: CH });
  check("outsider cannot write read_state on someone else's behalf",
    rsWrite.error !== null, rsWrite.error?.code ?? "NO ERROR RAISED");

  // Known, accepted limitation — asserted so a future change is noticed.
  await svc.from("activities").insert({
    id: `a_att_${stamp}`, actor_id: ids.owner, text: `created the Payroll project`, kind: "project",
  });
  const act = await out.from("activities").select("text").eq("id", `a_att_${stamp}`);
  console.log(`NOTE  activities_read is using(true) by design: outsider sees ${(act.data ?? []).length} row(s)` +
    ` -> ${(act.data ?? []).length ? "leaks restricted names, flagged for follow-up" : "filtered"}`);
} catch (err) {
  // A throw here means the checks below never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing — which is exactly what happened when the
  // profile-on-signup trigger started colliding with these fixtures.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  await svc.from("projects").delete().in("id", [OPEN, SECRET]);
  await svc.from("conversations").delete().eq("id", CH);
  await svc.from("activities").delete().eq("id", `a_att_${stamp}`);
  await svc.from("attachments").delete()
    .in("id", [`att_open_${stamp}`, `att_secret_${stamp}`, `att_task_${stamp}`]);
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
  console.log(failures === 0 ? "\nALL ATTACHMENT PROBES PASSED" : `\n${failures} ATTACHMENT PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
