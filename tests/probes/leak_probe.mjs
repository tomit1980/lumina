// Independent verification that a private channel is genuinely unreadable by a
// non-member at the API level — not merely hidden in the UI, and not relying on
// the task's own test suite. Written by the controller, not the implementer.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.test.local", quiet: true });
const URL = process.env.SUPABASE_URL;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const anonKey = process.env.SUPABASE_ANON_KEY;

const stamp = Date.now();
const PRIV = `c_probe_priv_${stamp}`;
const SECRET = "SALARY BANDS Q4 CONFIDENTIAL";
const pw = "probe-password-7c1d";
const ids = {};
let failures = 0;
let checks = 0;

const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};

try {
  // --- seed: two members, one private channel containing a secret message
  for (const who of ["insider", "outsider"]) {
    const { data, error } = await svc.auth.admin.createUser({
      email: `probe-${who}-${stamp}@lumina.test`, password: pw, email_confirm: true,
    });
    if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Record before the profile step: if that throws, the finally block
  // must still be able to delete this auth user.
  ids[who] = data.user.id;
    ids[who] = data.user.id;
    const p = await svc.from("profiles").upsert({
      id: data.user.id, email: `probe-${who}-${stamp}@lumina.test`,
      name: who, handle: `probe${who}${stamp}`, title: "", role_id: "member", color: "#000000",
    });
    if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  }

  await svc.from("conversations").insert({ id: PRIV, kind: "channel" });
  await svc.from("channels").insert({
    id: PRIV, name: "leadership-probe", description: "", is_private: true,
    is_team: false, created_by: ids.insider,
  });
  await svc.from("channel_members").insert({ channel_id: PRIV, user_id: ids.insider, level: "editor" });
  const msg = await svc.from("messages").insert({
    id: `m_probe_${stamp}`, conversation_id: PRIV, author_id: ids.insider, content: SECRET,
  });
  if (msg.error) throw new Error(`seed message: ${msg.error.message}`);

  // --- probe as the OUTSIDER, through the public key like a real client
  const out = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error: signInErr } = await out.auth.signInWithPassword({
    email: `probe-outsider-${stamp}@lumina.test`, password: pw,
  });
  if (signInErr) throw new Error(`outsider sign-in: ${signInErr.message}`);

  const ch = await out.from("channels").select("id,name").eq("id", PRIV);
  check("outsider cannot see the private channel by id", (ch.data ?? []).length === 0);

  const chAll = await out.from("channels").select("id,name");
  check("private channel absent from an unfiltered channel list",
    !(chAll.data ?? []).some((c) => c.id === PRIV),
    `sees ${(chAll.data ?? []).length} channel(s)`);

  const m = await out.from("messages").select("id,content").eq("conversation_id", PRIV);
  check("outsider cannot read its messages", (m.data ?? []).length === 0);

  const mAll = await out.from("messages").select("id,content");
  const leaked = (mAll.data ?? []).some((r) => (r.content ?? "").includes(SECRET));
  check("secret absent from an UNFILTERED message scan", !leaked,
    `scanned ${(mAll.data ?? []).length} message(s)`);

  const mem = await out.from("channel_members").select("user_id").eq("channel_id", PRIV);
  check("membership list not enumerable", (mem.data ?? []).length === 0);

  const conv = await out.from("conversations").select("id").eq("id", PRIV);
  check("parent conversation row hidden too", (conv.data ?? []).length === 0);

  const post = await out.from("messages").insert({
    id: `m_intrude_${stamp}`, conversation_id: PRIV, author_id: ids.outsider, content: "intrusion",
  });
  check("outsider cannot post into it", post.error !== null, post.error?.code ?? "NO ERROR RAISED");

  const join = await out.from("channel_members").insert({
    channel_id: PRIV, user_id: ids.outsider, level: "editor",
  });
  check("outsider cannot add themselves as a member", join.error !== null,
    join.error?.code ?? "NO ERROR RAISED");

  // --- and the INSIDER must still work, or the policy is merely broken
  const ins = createClient(URL, anonKey, { auth: { persistSession: false } });
  await ins.auth.signInWithPassword({ email: `probe-insider-${stamp}@lumina.test`, password: pw });
  const insMsg = await ins.from("messages").select("content").eq("conversation_id", PRIV);
  check("insider CAN still read the channel (policy is not just denying everyone)",
    (insMsg.data ?? []).length === 1 && insMsg.data[0].content === SECRET);

  // --- signed-out client sees nothing
  const anon = createClient(URL, anonKey, { auth: { persistSession: false } });
  const anonCh = await anon.from("channels").select("id");
  check("signed-out client sees no channels at all", (anonCh.data ?? []).length === 0);
} catch (err) {
  // A throw here means the checks below never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing — which is exactly what happened when the
  // profile-on-signup trigger started colliding with these fixtures.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  await svc.from("conversations").delete().eq("id", PRIV);
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
  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
