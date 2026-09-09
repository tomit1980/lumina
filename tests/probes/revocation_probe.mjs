// Does access actually END when membership ends? The suites all test the
// "never had access" case; this tests the "had it, lost it" case.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.test.local", quiet: true });
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-7c1d";
const PROJ = `p_rev_${stamp}`;
const CH = `c_rev_${stamp}`;
const ATT = `att_rev_${stamp}`;
const FILE = `confidential-${stamp}.pdf`;
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
  const email = `rev-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Record before the profile step: if that throws, the finally block
  // must still be able to delete this auth user.
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `rv${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  ids[who] = data.user.id;
};
const as = async (who) => {
  if (clients[who]) return clients[who];
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: `rev-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  clients[who] = c;
  return c;
};

try {
  await mkUser("owner", "admin");
  await mkUser("leaver", "member");

  // Restricted project; leaver is an editor and uploads a file to it.
  await svc.from("projects").insert({
    id: PROJ, name: "Confidential", description: "", emoji: "🔒", color: "#000",
    priority: "high", restricted: true, created_by: ids.owner,
  });
  await svc.from("project_members")
    .insert({ project_id: PROJ, user_id: ids.leaver, level: "editor" });
  await svc.from("attachments").insert({
    id: ATT, storage_path: `projects/${PROJ}/${ATT}`, name: FILE,
    size: 100, mime: "application/pdf", uploaded_by: ids.leaver,
  });
  await svc.from("project_attachments").insert({ project_id: PROJ, attachment_id: ATT });

  const leaver = await as("leaver");
  const before = await leaver.from("attachments").select("id,name,storage_path").eq("id", ATT);
  check("baseline: while a member, the uploader CAN see their attachment",
    (before.data ?? []).length === 1);

  // --- revoke membership ---
  const del = await svc.from("project_members")
    .delete().eq("project_id", PROJ).eq("user_id", ids.leaver);
  if (del.error) throw new Error(`revoke: ${del.error.message}`);

  const proj = await leaver.from("projects").select("id").eq("id", PROJ);
  check("after removal, the project itself is hidden", (proj.data ?? []).length === 0);

  const after = await leaver.from("attachments").select("id,name,storage_path").eq("id", ATT);
  check("after removal, the uploader can NO LONGER see the attachment row",
    (after.data ?? []).length === 0,
    (after.data ?? []).length
      ? `STILL VISIBLE: name="${after.data[0].name}" path="${after.data[0].storage_path}"`
      : "hidden");

  const link = await leaver.from("project_attachments")
    .select("attachment_id").eq("project_id", PROJ);
  check("after removal, the project's attachment links are hidden",
    (link.data ?? []).length === 0);

  // --- can a project.create holder plant permanent access by rewriting uploaded_by?
  const owner = await as("owner");
  const steal = await owner.from("attachments")
    .update({ uploaded_by: ids.owner }).eq("id", ATT);
  const { data: nowOwned } = await svc.from("attachments")
    .select("uploaded_by").eq("id", ATT).single();
  check("uploaded_by cannot be rewritten to mint permanent access",
    nowOwned?.uploaded_by === ids.leaver,
    nowOwned?.uploaded_by === ids.owner
      ? "REWRITTEN to the caller"
      : `unchanged${steal.error ? "" : " (no error raised)"}`);

  // --- message attachments: does leaving a private channel end link access?
  await svc.from("conversations").insert({ id: CH, kind: "channel" });
  await svc.from("channels").insert({
    id: CH, name: "rev-private", description: "", is_private: true,
    is_team: false, created_by: ids.owner,
  });
  await svc.from("channel_members").insert([
    { channel_id: CH, user_id: ids.owner, level: "editor" },
    { channel_id: CH, user_id: ids.leaver, level: "editor" },
  ]);
  await svc.from("messages").insert({
    id: `m_rev_${stamp}`, conversation_id: CH, author_id: ids.leaver, content: "mine",
  });
  await svc.from("channel_members")
    .delete().eq("channel_id", CH).eq("user_id", ids.leaver);

  const msgs = await leaver.from("messages").select("id").eq("conversation_id", CH);
  check("after leaving a private channel, its messages are hidden",
    (msgs.data ?? []).length === 0);

  const plant = await leaver.from("message_attachments")
    .insert({ message_id: `m_rev_${stamp}`, attachment_id: ATT });
  check("after leaving, cannot still attach files to your old messages there",
    plant.error !== null, plant.error?.code ?? "NO ERROR RAISED");
} catch (err) {
  // A throw here means the checks below never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing — which is exactly what happened when the
  // profile-on-signup trigger started colliding with these fixtures.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  await svc.from("projects").delete().eq("id", PROJ);
  await svc.from("conversations").delete().eq("id", CH);
  await svc.from("attachments").delete().eq("id", ATT);
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
  console.log(failures === 0 ? "\nALL REVOCATION PROBES PASSED" : `\n${failures} REVOCATION PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
