// Controller-written probe for the holes the first probe did not cover:
// DM gate-crashing, channel management by a non-manager, the reaction oracle,
// and channel creation under someone else's identity.
import { createClient } from "@supabase/supabase-js";

// Loads the env file and decides dev-vs-production. See ./_target.mjs.
import "./_target.mjs";
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-7c1d";
const DM = `d_probe_${stamp}`;
const PRIV = `c_probe2_${stamp}`;
const SECRET = "PRIVATE DM CONTENT - TWO PEOPLE ONLY";
const ids = {};
let failures = 0;
let checks = 0;
const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};

const mkUser = async (who, roleId = "member") => {
  const email = `dmprobe-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Record before the profile step: if that throws, the finally block
  // must still be able to delete this auth user.
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `dmp${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  ids[who] = data.user.id;
  return data.user.id;
};
const signIn = async (who) => {
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: `dmprobe-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  return c;
};

try {
  await mkUser("alice");
  await mkUser("bob");
  await mkUser("mallory");

  // A private DM between alice and bob, with a secret in it.
  await svc.from("conversations").insert({ id: DM, kind: "dm" });
  await svc.from("dms").insert({ id: DM });
  await svc.from("dm_members").insert([
    { dm_id: DM, user_id: ids.alice },
    { dm_id: DM, user_id: ids.bob },
  ]);
  const m = await svc.from("messages").insert({
    id: `m_dm_${stamp}`, conversation_id: DM, author_id: ids.alice, content: SECRET,
  });
  if (m.error) throw new Error(`seed dm message: ${m.error.message}`);

  const mal = await signIn("mallory");

  // --- DM gate-crashing, the hole my own SQL failed to close
  const join = await mal.from("dm_members").insert({ dm_id: DM, user_id: ids.mallory });
  check("outsider cannot insert themselves into someone else's DM",
    join.error !== null, join.error?.code ?? "NO ERROR RAISED — JOINED THE DM");

  const stillHidden = await mal.from("messages").select("content").eq("conversation_id", DM);
  const leaked = (stillHidden.data ?? []).some((r) => (r.content ?? "").includes(SECRET));
  check("outsider still cannot read the DM's messages", !leaked,
    `${(stillHidden.data ?? []).length} row(s) visible`);

  const allMsgs = await mal.from("messages").select("content");
  check("DM secret absent from an unfiltered message scan",
    !(allMsgs.data ?? []).some((r) => (r.content ?? "").includes(SECRET)),
    `scanned ${(allMsgs.data ?? []).length}`);

  const dmRow = await mal.from("dms").select("id").eq("id", DM);
  check("outsider cannot see the DM row", (dmRow.data ?? []).length === 0);

  const dmMem = await mal.from("dm_members").select("user_id").eq("dm_id", DM);
  check("outsider cannot enumerate DM participants", (dmMem.data ?? []).length === 0);

  // --- the reaction oracle
  const react = await mal.from("reactions").insert({
    message_id: `m_dm_${stamp}`, emoji: "👀", user_id: ids.mallory,
  });
  check("outsider cannot react to a message they cannot see",
    react.error !== null, react.error?.code ?? "NO ERROR RAISED");

  // --- channel management by a plain member who is not the creator
  await svc.from("conversations").insert({ id: PRIV, kind: "channel" });
  await svc.from("channels").insert({
    id: PRIV, name: "public-probe", description: "", is_private: false,
    is_team: false, created_by: ids.alice,
  });
  const rename = await mal.from("channels").update({ name: "hijacked" }).eq("id", PRIV);
  const { data: afterRename } = await svc.from("channels").select("name").eq("id", PRIV).single();
  check("non-creator member cannot rename a channel", afterRename?.name === "public-probe",
    `name is now "${afterRename?.name}"${rename.error ? "" : " (no error raised)"}`);

  const privatise = await mal.from("channels").update({ is_private: true }).eq("id", PRIV);
  const { data: afterPriv } = await svc.from("channels").select("is_private").eq("id", PRIV).single();
  check("non-creator member cannot re-privatise a channel", afterPriv?.is_private === false,
    `is_private=${afterPriv?.is_private}${privatise.error ? "" : " (no error raised)"}`);

  // --- channel creation under someone else's identity
  const spoofId = `c_spoof_${stamp}`;
  await mal.from("conversations").insert({ id: spoofId, kind: "channel" });
  const spoof = await mal.from("channels").insert({
    id: spoofId, name: "spoofed", description: "", is_private: false,
    is_team: false, created_by: ids.alice,
  });
  check("member cannot create a channel attributed to someone else",
    spoof.error !== null, spoof.error?.code ?? "NO ERROR RAISED");
  await svc.from("conversations").delete().eq("id", spoofId);

  // --- and the legitimate parties must still work
  const ali = await signIn("alice");
  const aliRead = await ali.from("messages").select("content").eq("conversation_id", DM);
  check("alice CAN still read her own DM",
    (aliRead.data ?? []).length === 1 && aliRead.data[0].content === SECRET);
} catch (err) {
  // A throw here means the checks below never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing — which is exactly what happened when the
  // profile-on-signup trigger started colliding with these fixtures.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  await svc.from("conversations").delete().in("id", [DM, PRIV]);
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
  console.log(failures === 0 ? "\nALL DM PROBES PASSED" : `\n${failures} DM PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
