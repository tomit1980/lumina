// Controller probe for supabase/migrations/20260908000800_store_swap.sql —
// the profile-on-signup trigger, find_or_create_dm, the task position default,
// toggle_reaction, and profiles.mfa_required.
//
// Independent of the vitest suite on purpose: it signs in as a real client and
// ATTACKS the new surface rather than describing it. Follows
// collaborator_probe.mjs's shape, including the two rules this project learned
// the hard way:
//
//   * `.select("*", { head: true })` returns error === null for a table that
//     does NOT exist, and `{ count: "exact" }` does not fix that — a head
//     request against a missing table still comes back error=null, count=null,
//     status=204. Only a BODY select surfaces PGRST205. So the discriminator
//     is `count` being a NUMBER, and nothing here ever writes `count ?? 0`,
//     which would launder a vacuous null into a passing zero. Probe 0 pins all
//     of that down before anything is measured with it.
//   * Every denial is paired with a positive control on the same surface, the
//     same shape and the same client, so "denied" is never confused with "the
//     call never worked".
//
// Sign-ins are memoised: Supabase rate-limits repeated signInWithPassword.
import { createClient } from "@supabase/supabase-js";

// Loads the env file and decides dev-vs-production. See ./_target.mjs.
import "./_target.mjs";
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-5b2e";
const OPEN = `p_ss_open_${stamp}`;
const SECRET = `p_ss_secret_${stamp}`;
const PUB = `c_ss_pub_${stamp}`;
const PRIV = `c_ss_priv_${stamp}`;
const M_OPEN = `m_ss_open_${stamp}`;
const M_SECRET = `m_ss_secret_${stamp}`;
const ids = {};
const clients = {};
const madeDms = new Set();
let failures = 0;
let checks = 0;

const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};

// upsert, not insert: handle_new_user (this migration) now creates the profile
// the instant the auth user exists, so a plain insert here would collide on the
// primary key. The upsert overwrites the trigger's derived name/handle/role
// with the fixture's chosen ones — exactly what tests/helpers/supabase.ts's
// createTestUser already does.
const mkUser = async (who, roleId) => {
  const email = `ss-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `ss${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  ids[who] = data.user.id;
};

const as = async (who) => {
  if (clients[who]) return clients[who];
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: `ss-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  clients[who] = c;
  return c;
};

const anon = createClient(URL, anonKey, { auth: { persistSession: false } });

const mfaOf = async (userId) => {
  const { data } = await svc.from("profiles").select("mfa_required").eq("id", userId).single();
  return data?.mfa_required;
};
const positionOf = async (taskId) => {
  const { data } = await svc.from("tasks").select("position").eq("id", taskId).single();
  return data?.position;
};
const reactionCount = async (messageId) => {
  const { data } = await svc.from("reactions").select("user_id").eq("message_id", messageId);
  return (data ?? []).length;
};

try {
  // ------------------------------------------------------------------
  // Probe 0 — meta-control. Proves the measuring instrument discriminates
  // before anything is measured with it.
  const bogusName = `table_that_does_not_exist_${stamp}`;
  const bogusHead = await svc.from(bogusName).select("*", { count: "exact", head: true });
  check("meta-control: a missing table yields count=null, NOT a number (the real trap)",
    bogusHead.count === null,
    `err=${bogusHead.error?.code ?? "null"} count=${bogusHead.count} status=${bogusHead.status}`);

  const bogusBody = await svc.from(bogusName).select("*");
  check("meta-control: ...and a BODY select does surface the missing table",
    bogusBody.error !== null, bogusBody.error?.code ?? "NO ERROR RAISED");

  const realHead = await svc.from("dms").select("*", { count: "exact", head: true });
  check("meta-control: a real table yields a numeric count, so `=== 0` is a live assertion",
    typeof realHead.count === "number", `count=${realHead.count} status=${realHead.status}`);

  const bogusRpc = await svc.rpc(`rpc_that_does_not_exist_${stamp}`, {});
  check("meta-control: a missing RPC errors, so `error !== null` on an RPC is a live assertion",
    bogusRpc.error !== null, bogusRpc.error?.code ?? "NO ERROR RAISED");

  // ------------------------------------------------------------------
  // Fixtures. attacker/victim/mate hold the seeded Member role (message.send,
  // task.create/edit, but NOT members.manage) — an admin would clear every
  // gate below trivially and the probe would prove nothing.
  await mkUser("owner", "admin");
  await mkUser("attacker", "member");
  await mkUser("victim", "member");
  await mkUser("mate", "member");

  await svc.from("projects").insert([
    { id: OPEN, name: "Open", description: "", emoji: "📁", color: "#000",
      priority: "medium", restricted: false, created_by: ids.owner },
    { id: SECRET, name: "Acquisition", description: "", emoji: "🔒", color: "#000",
      priority: "high", restricted: true, created_by: ids.owner },
  ]);
  await svc.from("conversations").insert([
    { id: PUB, kind: "channel" }, { id: PRIV, kind: "channel" },
  ]);
  await svc.from("channels").insert([
    { id: PUB, name: `ssopen${stamp}`, description: "", is_private: false,
      is_team: false, created_by: ids.owner },
    { id: PRIV, name: `ssshut${stamp}`, description: "", is_private: true,
      is_team: false, created_by: ids.owner },
  ]);
  const seedMessages = await svc.from("messages").insert([
    { id: M_OPEN, conversation_id: PUB, author_id: ids.owner, content: "ship it" },
    { id: M_SECRET, conversation_id: PRIV, author_id: ids.owner, content: "offer terms" },
  ]);
  if (seedMessages.error) throw new Error(`seed messages: ${seedMessages.error.message}`);

  const atk = await as("attacker");
  const vic = await as("victim");

  // ==================================================================
  // POSITIVE CONTROLS — the attacker is a real, working, signed-in user with
  // real powers. Without these, every denial below could just be a broken
  // client or a dead fixture.
  // ==================================================================
  const ctrlReact = await atk.rpc("toggle_reaction", { message_id: M_OPEN, emoji: "🎉" });
  check("positive control: attacker CAN toggle a reaction on a message they can see",
    ctrlReact.error === null && ctrlReact.data?.added === true,
    `err=${ctrlReact.error?.message ?? "none"} added=${ctrlReact.data?.added}`);
  check("  ...and the row really exists", (await reactionCount(M_OPEN)) === 1);
  await atk.rpc("toggle_reaction", { message_id: M_OPEN, emoji: "🎉" });
  check("  ...and toggling again removes it", (await reactionCount(M_OPEN)) === 0);

  const ctrlDm = await atk.rpc("find_or_create_dm", { other_user_id: ids.victim });
  check("positive control: attacker CAN open a DM with a visible teammate",
    ctrlDm.error === null && typeof ctrlDm.data === "string",
    `err=${ctrlDm.error?.message ?? "none"} id=${ctrlDm.data}`);
  if (ctrlDm.data) madeDms.add(ctrlDm.data);

  const ctrlTask = await atk.from("tasks").insert({
    id: `t_ss_ctrl_${stamp}`, project_id: OPEN, title: "Attacker's own task",
    status: "todo", created_by: ids.attacker,
  });
  check("positive control: attacker CAN create a task in a project they can see",
    ctrlTask.error === null, ctrlTask.error?.code ?? "ok");
  check("  ...and the position trigger filled it in with no client-side count",
    (await positionOf(`t_ss_ctrl_${stamp}`)) === 0,
    `position=${await positionOf(`t_ss_ctrl_${stamp}`)}`);

  const ctrlSelf = await atk.from("profiles").update({ title: "Probe" }).eq("id", ids.attacker);
  check("positive control: attacker CAN update their own profile row",
    ctrlSelf.error === null, ctrlSelf.error?.code ?? "ok");

  // ==================================================================
  // ATTACK 1 — find_or_create_dm.
  // ==================================================================
  const anonDm = await anon.rpc("find_or_create_dm", { other_user_id: ids.victim });
  check("anon cannot open a DM at all (auth.uid() is null)",
    anonDm.error !== null, anonDm.error?.message ?? "NO ERROR RAISED");

  const ghostDm = await atk.rpc("find_or_create_dm", {
    other_user_id: "00000000-0000-0000-0000-000000000000",
  });
  check("attacker cannot open a DM with a user they cannot see",
    ghostDm.error !== null && /not on this team/i.test(ghostDm.error.message),
    ghostDm.error?.message ?? "NO ERROR RAISED");

  const selfDm = await atk.rpc("find_or_create_dm", { other_user_id: ids.attacker });
  check("attacker cannot open a DM with themselves",
    selfDm.error !== null, selfDm.error?.message ?? "NO ERROR RAISED");

  // A DM between two OTHER people. The attacker must neither see it nor be
  // able to reach it by asking for the same pair.
  const othersDm = await vic.rpc("find_or_create_dm", { other_user_id: ids.mate });
  check("fixture check: victim opened a DM with mate",
    othersDm.error === null, othersDm.error?.message ?? "ok");
  if (othersDm.data) madeDms.add(othersDm.data);

  const peek = await atk.from("dms")
    .select("*", { count: "exact", head: true }).eq("id", othersDm.data);
  // Strictly `=== 0`, never `?? 0`: probe 0 showed a vacuous request returns
  // count=null. The victim's own read below is the paired control proving the
  // row is really there to be leaked.
  check("attacker cannot read someone else's DM row", peek.count === 0, `count=${peek.count}`);
  const peekControl = await vic.from("dms")
    .select("*", { count: "exact", head: true }).eq("id", othersDm.data);
  check("  ...paired control: its own member CAN read it",
    peekControl.count === 1, `count=${peekControl.count}`);

  const peekMembers = await atk.from("dm_members")
    .select("*", { count: "exact", head: true }).eq("dm_id", othersDm.data);
  check("attacker cannot enumerate someone else's DM membership",
    peekMembers.count === 0, `count=${peekMembers.count}`);

  // Race: five simultaneous calls for the same pair must still yield ONE DM.
  const burst = await Promise.all(
    Array.from({ length: 5 }, () => atk.rpc("find_or_create_dm", { other_user_id: ids.mate }))
  );
  const burstIds = new Set(burst.map((r) => r.data));
  burstIds.forEach((id) => id && madeDms.add(id));
  check("five racing find_or_create_dm calls yield exactly one DM",
    burst.every((r) => r.error === null) && burstIds.size === 1,
    `ids=${[...burstIds].join(",")} errs=${burst.map((r) => r.error?.code ?? "-").join(",")}`);

  // pair_key squatting: dms_insert lets any holder of message.send create a
  // dms row. If pair_key were client-supplied, an attacker could claim two
  // other people's key and permanently wedge their thread.
  const squatId = `d_squat_${stamp}`;
  await atk.from("conversations").insert({ id: squatId, kind: "dm" });
  const squat = await atk.from("dms").insert({
    id: squatId,
    pair_key: [ids.victim, ids.mate].sort().join(":"),
  });
  const { data: squatRow } = await svc.from("dms").select("pair_key").eq("id", squatId).single();
  check("a client-supplied pair_key is discarded, not stored (no DM squatting)",
    squat.error !== null || squatRow?.pair_key === null,
    `insertErr=${squat.error?.code ?? "none"} storedKey=${squatRow?.pair_key ?? "null"}`);
  await svc.from("conversations").delete().eq("id", squatId);

  // ==================================================================
  // ATTACK 2 — toggle_reaction.
  // ==================================================================
  const anonReact = await anon.rpc("toggle_reaction", { message_id: M_OPEN, emoji: "👀" });
  check("anon cannot react, even on a PUBLIC channel's message",
    anonReact.error !== null, anonReact.error?.message ?? "NO ERROR RAISED");
  check("  ...and nothing was written", (await reactionCount(M_OPEN)) === 0);

  const hiddenReact = await atk.rpc("toggle_reaction", { message_id: M_SECRET, emoji: "👀" });
  check("attacker cannot react to a message in a private channel they are not in",
    hiddenReact.error !== null && /not found or not visible/i.test(hiddenReact.error.message),
    hiddenReact.error?.message ?? "NO ERROR RAISED");
  check("  ...and nothing was written", (await reactionCount(M_SECRET)) === 0);

  // The refusal must not distinguish "hidden" from "nonexistent", or the RPC
  // is an oracle confirming a message id exists in a channel you cannot read.
  // Compared with each call's OWN id blanked out, since the id the caller
  // supplied is the one thing the message may legitimately echo back.
  const ghostId = `m_does_not_exist_${stamp}`;
  const ghostReact = await atk.rpc("toggle_reaction", { message_id: ghostId, emoji: "👀" });
  const blank = (message, id) => (message ?? "").split(id).join("<id>");
  check("a hidden message and a nonexistent one are refused identically (no oracle)",
    ghostReact.error !== null
      && blank(ghostReact.error.message, ghostId)
         === blank(hiddenReact.error?.message, M_SECRET),
    `hidden="${hiddenReact.error?.message}" ghost="${ghostReact.error?.message}"`);

  // ==================================================================
  // ATTACK 3 — mfa_required.
  // ==================================================================
  await svc.from("profiles").update({ mfa_required: true }).eq("id", ids.attacker);

  const clearSelf = await atk.from("profiles")
    .update({ mfa_required: false }).eq("id", ids.attacker);
  check("attacker cannot clear the 2FA requirement on THEMSELVES (trigger, not policy)",
    clearSelf.error !== null && clearSelf.error.code === "P0001",
    clearSelf.error ? clearSelf.error.code : "NO ERROR RAISED");
  check("  ...and the requirement still stands", (await mfaOf(ids.attacker)) === true,
    `mfa_required=${await mfaOf(ids.attacker)}`);

  // profiles_update_self ALLOWS the attacker's own row, so the refusal above
  // can only be the column guard. This proves the rest of the row still moves.
  const stillWritable = await atk.from("profiles")
    .update({ title: "Still writable" }).eq("id", ids.attacker);
  check("  ...paired control: the rest of their own row is still writable",
    stillWritable.error === null, stillWritable.error?.code ?? "ok");

  // A DENIED update reports no error (USING filters the row away), so survival
  // of the old value is the assertion here — never `error`.
  await atk.from("profiles").update({ mfa_required: true }).eq("id", ids.victim);
  check("attacker cannot impose a 2FA requirement on someone else",
    (await mfaOf(ids.victim)) === false, `victim mfa_required=${await mfaOf(ids.victim)}`);

  await anon.from("profiles").update({ mfa_required: true }).eq("id", ids.victim);
  check("anon cannot set it either", (await mfaOf(ids.victim)) === false);

  // Self-promotion is the obvious escalation: grant yourself members.manage,
  // then set the flag. block_self_role_change must stop step one.
  const promote = await atk.from("profiles").update({ role_id: "admin" }).eq("id", ids.attacker);
  check("attacker cannot promote themselves to admin to get around it",
    promote.error !== null, promote.error?.code ?? "NO ERROR RAISED");

  const own = await as("owner");
  const adminSet = await own.from("profiles").update({ mfa_required: true }).eq("id", ids.victim);
  check("paired control: a members.manage holder CAN set it",
    adminSet.error === null && (await mfaOf(ids.victim)) === true,
    `err=${adminSet.error?.code ?? "none"} value=${await mfaOf(ids.victim)}`);

  // ==================================================================
  // ATTACK 4 — forged task position.
  // ==================================================================
  const forged = `t_ss_forged_${stamp}`;
  const forgedInsert = await atk.from("tasks").insert({
    id: forged, project_id: OPEN, title: "Pinned to the top forever",
    status: "todo", created_by: ids.attacker, position: -1,
  });
  check("a task carrying the sentinel position is accepted (control for the next check)",
    forgedInsert.error === null, forgedInsert.error?.code ?? "ok");
  check("...but the sentinel is normalised away — it cannot be stored as -1",
    (await positionOf(forged)) === 1, `position=${await positionOf(forged)}`);

  // An explicit, legitimate position is still honoured — the trigger must not
  // be a blanket overwrite, or move_task's renumbering would be undone.
  const explicit = `t_ss_explicit_${stamp}`;
  await atk.from("tasks").insert({
    id: explicit, project_id: OPEN, title: "Top of the column",
    status: "todo", created_by: ids.attacker, position: 0,
  });
  check("an explicit position 0 is honoured, not treated as 'unset'",
    (await positionOf(explicit)) === 0, `position=${await positionOf(explicit)}`);

  // The position trigger is SECURITY DEFINER and runs BEFORE the RLS check —
  // it must not become a way into a project the caller cannot see.
  const intoSecret = await atk.from("tasks").insert({
    id: `t_ss_secret_${stamp}`, project_id: SECRET, title: "Planted",
    status: "todo", created_by: ids.attacker,
  });
  check("the position trigger is not a way into a project the attacker cannot see",
    intoSecret.error !== null && intoSecret.error.code === "42501",
    intoSecret.error ? intoSecret.error.code : "NO ERROR RAISED");

  const anonTask = await anon.from("tasks").insert({
    id: `t_ss_anon_${stamp}`, project_id: OPEN, title: "Anonymous", status: "todo",
  });
  check("anon cannot create a task at all",
    anonTask.error !== null, anonTask.error?.code ?? "NO ERROR RAISED");

  // ==================================================================
  // ATTACK 5 — the seeded structure.
  // ==================================================================
  const teamRead = await atk.from("channels")
    .select("*", { count: "exact", head: true }).eq("is_team", true);
  check("the seeded general channel is exactly one row and is visible to a member",
    teamRead.count === 1, `count=${teamRead.count}`);

  const secondTeam = `c_ss_team_${stamp}`;
  await atk.from("conversations").insert({ id: secondTeam, kind: "channel" });
  const dupTeam = await atk.from("channels").insert({
    id: secondTeam, name: "general-2", description: "", is_private: false,
    is_team: true, created_by: ids.attacker,
  });
  check("attacker cannot create a second team channel",
    dupTeam.error !== null, dupTeam.error?.code ?? "NO ERROR RAISED");
  await svc.from("conversations").delete().eq("id", secondTeam);

  await atk.from("channels").delete().eq("id", "c_general");
  const { count: generalStillThere } = await svc.from("channels")
    .select("*", { count: "exact", head: true }).eq("id", "c_general");
  check("attacker cannot delete the team channel",
    generalStillThere === 1, `count=${generalStillThere}`);

  // ==================================================================
  // ATTACK 6 — handle_new_user.
  // ==================================================================
  const newEmail = `ss-fresh-${stamp}@lumina.test`;
  const fresh = await svc.auth.admin.createUser({
    email: newEmail, password: pw, email_confirm: true,
  });
  if (fresh.error) throw new Error(`fresh user: ${fresh.error.message}`);
  ids.fresh = fresh.data.user.id;
  const { data: freshProfile } = await svc.from("profiles")
    .select("role_id,email,handle,mfa_required").eq("id", ids.fresh).single();
  check("a brand-new auth user gets a profile with no manual insert",
    freshProfile != null, JSON.stringify(freshProfile));
  check("  ...on the Member role, never admin",
    freshProfile?.role_id === "member", `role_id=${freshProfile?.role_id}`);
  check("  ...with 2FA not required by default",
    freshProfile?.mfa_required === false, `mfa_required=${freshProfile?.mfa_required}`);
  check("  ...and a handle derived from the email's local part",
    freshProfile?.handle === `ssfresh${stamp}`, `handle=${freshProfile?.handle}`);

  // The collision path: same local part, different domain.
  const twin = await svc.auth.admin.createUser({
    email: `ss-fresh-${stamp}@elsewhere.test`, password: pw, email_confirm: true,
  });
  if (twin.error) throw new Error(`twin user: ${twin.error.message}`);
  ids.twin = twin.data.user.id;
  const { data: twinProfile } = await svc.from("profiles")
    .select("handle").eq("id", ids.twin).single();
  check("a colliding handle is made unique rather than failing the sign-up",
    twinProfile != null && twinProfile.handle !== freshProfile?.handle,
    `first=${freshProfile?.handle} second=${twinProfile?.handle}`);
} finally {
  await svc.from("projects").delete().in("id", [OPEN, SECRET]);
  await svc.from("conversations").delete().in("id", [PUB, PRIV, ...madeDms]);
  for (const id of Object.values(ids)) await svc.auth.admin.deleteUser(id);
  const { data } = await svc.auth.admin.listUsers({ perPage: 100 });
  console.log(`\ncleanup: ${data.users.length} users remain (expect 0)`);
  const leftoverDms = await svc.from("dms").select("id");
  console.log(`cleanup: ${(leftoverDms.data ?? []).length} dms remain (expect 0)`);
  // A probe that asserted nothing must not report success. This is not
  // hypothetical: on 2026-09-08 a new database trigger made every probe's
  // setup throw, and all seven printed PASSED having checked nothing.
  if (checks === 0) {
    failures++;
    console.log("\n*** NO CHECKS RAN — this probe asserted nothing ***");
  }
  console.log(failures === 0 ? "\nALL STORE-SWAP PROBES PASSED" : `\n${failures} STORE-SWAP PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
