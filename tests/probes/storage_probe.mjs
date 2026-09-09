// Controller probe for the Storage buckets (store-swap Task 10).
//
// The claim under attack: a file's BYTES are reachable exactly when the
// project, task or message the file hangs off is. The RLS suite tests that
// through `SupabaseBackend`, which is the code that ships; this attacks the
// same buckets from outside it — an anonymous client and a signed-in nobody,
// the way a stranger with the publishable key and a browser console would.
//
// A private bucket left readable by default is the classic version of this
// mistake, and it would undo the leak-closing work of the last two days, so
// the anonymous half deliberately knocks on every door Storage has: the
// public object URL, a signed URL, a direct download, a bucket listing, a
// bucket enumeration, a guessed path, and an upload.
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
const OPEN = `p_stg_open_${stamp}`;
const SECRET = `p_stg_secret_${stamp}`;
const SECRET_FILE = `att_stg_secret_${stamp}`;
const OPEN_FILE = `att_stg_open_${stamp}`;
const BUCKETS = ["project-files", "task-files", "message-files"];
const SECRET_BYTES = `payroll-${stamp}`;

// Fixtures for the LINK LAUNDERING half (final-review.md findings 1 and 2):
// four destinations the outsider is genuinely allowed to write to, so that
// every refusal below is the *attachment* side of the policy talking rather
// than the destination side.
const OWNED = `p_stg_owned_${stamp}`; // a project the outsider CREATED (project_is_manageable)
const CH = `c_stg_ch_${stamp}`; // a public channel — message.send is all a Guest holds
const TASK = `t_stg_task_${stamp}`; // a task on the OPEN project (task.edit, visible, not viewer-only)
const MSG = `m_stg_msg_${stamp}`;
const DM_MSG = `m_stg_dm_${stamp}`;
let dmId = null;

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
  const email = `stg-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Recorded before the profile step: if that throws, the finally block must
  // still be able to delete this auth user.
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `sg${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
};

const as = async (who) => {
  if (clients[who]) return clients[who];
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: `stg-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  clients[who] = c;
  return c;
};

/** A fresh signed-OUT client. This is the attacker for most of what follows. */
const anon = () => createClient(URL, anonKey, { auth: { persistSession: false } });

try {
  await mkUser("owner", "admin");
  await mkUser("outsider", "member");

  await svc.from("projects").insert([
    { id: OPEN, name: "Open", description: "", emoji: "📁", color: "#000",
      priority: "medium", restricted: false, created_by: ids.owner },
    { id: SECRET, name: "Payroll", description: "", emoji: "🔒", color: "#000",
      priority: "high", restricted: true, created_by: ids.owner },
  ]);
  await svc.from("project_members").insert({ project_id: SECRET, user_id: ids.owner, level: "editor" });

  // The four destinations for the laundering attack. Seeded with the service
  // key on purpose: what is under test is whether the outsider may LINK a file
  // into these, not whether they may create them.
  await svc.from("projects").insert({
    id: OWNED, name: "Outsider's own", description: "", emoji: "📂", color: "#000",
    priority: "low", restricted: false, created_by: ids.outsider,
  });
  await svc.from("conversations").insert({ id: CH, kind: "channel" });
  await svc.from("channels").insert({
    id: CH, name: `stg-general-${stamp}`, description: "",
    is_private: false, is_team: false, created_by: ids.owner,
  });
  await svc.from("tasks").insert({
    id: TASK, project_id: OPEN, title: "Open task", created_by: ids.owner,
  });

  // Seeded through the OWNER's own client, not the service key: the upload
  // path is part of what is being probed, and a service-key upload would
  // bypass the very INSERT policy the "upload into someone else's project"
  // check below is about.
  const own = await as("owner");
  const seed = async (id, projectId, body) => {
    const row = await own.from("attachments").insert({
      id, storage_path: `project-files/${id}`, name: `${id}.txt`,
      size: body.length, mime: "text/plain", uploaded_by: ids.owner,
    });
    if (row.error) throw new Error(`attachments row ${id}: ${row.error.message}`);
    const put = await own.storage.from("project-files")
      .upload(id, new Blob([body], { type: "text/plain" }));
    if (put.error) throw new Error(`upload ${id}: ${put.error.message}`);
    const link = await own.from("project_attachments")
      .insert({ project_id: projectId, attachment_id: id });
    if (link.error) throw new Error(`link ${id}: ${link.error.message}`);
  };
  await seed(SECRET_FILE, SECRET, SECRET_BYTES);
  await seed(OPEN_FILE, OPEN, "public-bytes");

  // -------------------------------------------------------------------
  // POSITIVE CONTROL FIRST. Without it every "cannot reach the file"
  // below would also pass against a Storage service that was simply
  // broken, or a bucket that did not exist — which is precisely how
  // seven probes in this repo once reported success having asserted
  // nothing.
  // -------------------------------------------------------------------
  const ctrl = await own.storage.from("project-files").createSignedUrl(SECRET_FILE, 60);
  const ctrlBody = ctrl.data ? await (await fetch(ctrl.data.signedUrl)).text() : "";
  check("positive control: the owner CAN sign and fetch the restricted file",
    ctrl.error === null && ctrlBody === SECRET_BYTES,
    ctrl.error?.message ?? `body=${ctrlBody.slice(0, 24)}`);

  // -------------------------------------------------------------------
  // ANONYMOUS. Every door Storage has.
  // -------------------------------------------------------------------
  const a = anon();

  const pub = await fetch(`${URL}/storage/v1/object/public/project-files/${SECRET_FILE}`);
  check("anon: the public object URL does not serve a private bucket",
    pub.status >= 400, `HTTP ${pub.status}`);

  const anonSign = await a.storage.from("project-files").createSignedUrl(SECRET_FILE, 60);
  check("anon: cannot mint a signed URL", anonSign.data === null,
    anonSign.error?.message ?? "*** URL ISSUED ***");

  const anonGet = await a.storage.from("project-files").download(SECRET_FILE);
  check("anon: cannot download the object directly", anonGet.data === null,
    anonGet.error?.message ?? "*** BYTES RETURNED ***");

  const anonBuckets = await a.storage.listBuckets();
  check("anon: cannot enumerate the buckets",
    (anonBuckets.data ?? []).length === 0,
    `saw ${(anonBuckets.data ?? []).length}`);

  // GUESSING A PATH. The object key IS the attachment id, so this is the
  // attack the naming scheme has to survive: try the real id in every
  // bucket, and try a plausible id that does not exist, and confirm the
  // two are indistinguishable (no existence oracle).
  for (const bucket of BUCKETS) {
    const guess = await a.storage.from(bucket).download(SECRET_FILE);
    check(`anon: guessing the real path in ${bucket} gets nothing`,
      guess.data === null, guess.error?.message ?? "*** BYTES RETURNED ***");
  }
  const real = await a.storage.from("project-files").download(SECRET_FILE);
  const fake = await a.storage.from("project-files").download(`att_stg_nope_${stamp}`);
  check("anon: a real path and a made-up one answer identically (no existence oracle)",
    (real.error?.message ?? "") === (fake.error?.message ?? ""),
    `${real.error?.message} vs ${fake.error?.message}`);

  for (const bucket of BUCKETS) {
    const listed = await a.storage.from(bucket).list();
    check(`anon: cannot list ${bucket}`, (listed.data ?? []).length === 0,
      `saw ${(listed.data ?? []).length}`);
  }

  const anonPut = await a.storage.from("project-files")
    .upload(`att_stg_anon_${stamp}`, new Blob(["forged"]));
  check("anon: cannot upload into a bucket at all",
    anonPut.error !== null, anonPut.error?.message ?? "*** UPLOAD ACCEPTED ***");

  const anonRow = await a.from("attachments").insert({
    id: `att_stg_anon_${stamp}`, storage_path: `project-files/att_stg_anon_${stamp}`,
    name: "forged.txt", size: 1, mime: "text/plain", uploaded_by: ids.owner,
  });
  check("anon: cannot create the attachments row an upload would need",
    anonRow.error !== null, anonRow.error?.code ?? "*** ROW ACCEPTED ***");

  // -------------------------------------------------------------------
  // A SIGNED-IN NOBODY. The more interesting attacker: a real member of
  // the workspace who is not a member of this project.
  // -------------------------------------------------------------------
  const out = await as("outsider");

  const outCtrl = await out.storage.from("project-files").createSignedUrl(OPEN_FILE, 60);
  check("positive control: the outsider CAN sign a file on an OPEN project",
    outCtrl.error === null, outCtrl.error?.message ?? "OK");

  const outSign = await out.storage.from("project-files").createSignedUrl(SECRET_FILE, 60);
  check("outsider: cannot sign a file on a project they cannot see",
    outSign.data === null, outSign.error?.message ?? "*** URL ISSUED ***");

  const outGet = await out.storage.from("project-files").download(SECRET_FILE);
  check("outsider: cannot download it either",
    outGet.data === null, outGet.error?.message ?? "*** BYTES RETURNED ***");

  const outList = await out.storage.from("project-files").list();
  check("outsider: the restricted file is absent from an UNFILTERED bucket listing",
    !(outList.data ?? []).some((o) => o.name === SECRET_FILE),
    `scanned ${(outList.data ?? []).length}`);
  check("outsider: the same listing DOES show the open project's file",
    (outList.data ?? []).some((o) => o.name === OPEN_FILE),
    `scanned ${(outList.data ?? []).length}`);

  // UPLOAD INTO SOMEONE ELSE'S PROJECT, three ways.
  const outPut = await out.storage.from("project-files")
    .upload(SECRET_FILE, new Blob(["forged"]), { upsert: true });
  check("outsider: cannot overwrite a file behind a row they do not own",
    outPut.error !== null, outPut.error?.message ?? "*** OVERWRITE ACCEPTED ***");

  const outNew = await out.storage.from("project-files")
    .upload(`att_stg_new_${stamp}`, new Blob(["forged"]));
  check("outsider: cannot upload to a path with no attachments row behind it",
    outNew.error !== null, outNew.error?.message ?? "*** UPLOAD ACCEPTED ***");

  const outLink = await out.from("project_attachments")
    .insert({ project_id: SECRET, attachment_id: OPEN_FILE });
  check("outsider: cannot link an existing file into a project they cannot see",
    outLink.error !== null, outLink.error?.code ?? "*** LINK ACCEPTED ***");

  // -------------------------------------------------------------------
  // LINK LAUNDERING — final-review.md findings 1 and 2.
  //
  // Every check above asks "given these links, who can read?". This asks the
  // question nobody had asked: **who can create a link?** The three
  // `*_attachments_insert` policies used to gate only on the DESTINATION (do
  // you own this message / can you manage this project / may you edit this
  // task) and said nothing about the attachment being linked — so anyone
  // holding `message.send`, which is the ONLY permission a Guest holds, could
  // name a known attachment id, link it to a message of their own, and have
  // `can_see_attachment` answer "yes, it is on a message you can see". That
  // laundered visibility reaches `attachment_objects_read`, and therefore the
  // bytes in a private bucket. Demonstrated live on 2026-09-09; 7 of these
  // checks failed and the secret bytes were served.
  //
  // The attacker here is deliberately allowed to write to all four
  // destinations, so a refusal can only be the attachment half of the policy.
  // Each negative is paired with the SAME insert for a file the outsider CAN
  // see: a policy that had simply started refusing every link would fail those
  // instead of passing these.
  // -------------------------------------------------------------------
  const post = await out.from("messages")
    .insert({ id: MSG, conversation_id: CH, author_id: ids.outsider, content: "hi" })
    .select("id");
  check("attack step 1: the outsider CAN post in a channel they can see",
    post.error === null && (post.data ?? []).length === 1, post.error?.message ?? "OK");

  const launder = await out.from("message_attachments")
    .insert({ message_id: MSG, attachment_id: SECRET_FILE });
  check("ATTACK BLOCKED: cannot link a file they cannot see to their own message",
    launder.error !== null, launder.error?.code ?? "*** LINK ACCEPTED ***");

  const launderOk = await out.from("message_attachments")
    .insert({ message_id: MSG, attachment_id: OPEN_FILE });
  check("positive control: the SAME insert succeeds for a file they can see",
    launderOk.error === null, launderOk.error?.message ?? "OK");

  // The DM variant is the worst case: a thread nobody else ever reads, so the
  // laundering link is invisible to every administrator as well.
  const dm = await out.rpc("find_or_create_dm", { other_user_id: ids.owner });
  dmId = dm.data ?? null;
  check("attack step 2: the outsider CAN open a DM of their own",
    dm.error === null && typeof dmId === "string", dm.error?.message ?? dmId);

  const dmPost = dmId
    ? await out.from("messages")
        .insert({ id: DM_MSG, conversation_id: dmId, author_id: ids.outsider, content: "x" })
        .select("id")
    : { error: new Error("no dm"), data: [] };
  check("attack step 3: and post in it",
    dmPost.error === null && (dmPost.data ?? []).length === 1, dmPost.error?.message ?? "OK");

  const dmLaunder = await out.from("message_attachments")
    .insert({ message_id: DM_MSG, attachment_id: SECRET_FILE });
  check("ATTACK BLOCKED (DM): cannot link the file to a message only they can see",
    dmLaunder.error !== null, dmLaunder.error?.code ?? "*** LINK ACCEPTED ***");

  const dmOk = await out.from("message_attachments")
    .insert({ message_id: DM_MSG, attachment_id: OPEN_FILE });
  check("positive control (DM): the same insert succeeds for a visible file",
    dmOk.error === null, dmOk.error?.message ?? "OK");

  const projLaunder = await out.from("project_attachments")
    .insert({ project_id: OWNED, attachment_id: SECRET_FILE });
  check("ATTACK BLOCKED (project): cannot link the file into a project they CREATED",
    projLaunder.error !== null, projLaunder.error?.code ?? "*** LINK ACCEPTED ***");

  const projOk = await out.from("project_attachments")
    .insert({ project_id: OWNED, attachment_id: OPEN_FILE });
  check("positive control (project): the same insert succeeds for a visible file",
    projOk.error === null, projOk.error?.message ?? "OK");

  const taskLaunder = await out.from("task_attachments")
    .insert({ task_id: TASK, attachment_id: SECRET_FILE });
  check("ATTACK BLOCKED (task): cannot link the file onto a task they may edit",
    taskLaunder.error !== null, taskLaunder.error?.code ?? "*** LINK ACCEPTED ***");

  const taskOk = await out.from("task_attachments")
    .insert({ task_id: TASK, attachment_id: OPEN_FILE });
  check("positive control (task): the same insert succeeds for a visible file",
    taskOk.error === null, taskOk.error?.message ?? "OK");

  // The payoff. These are the four checks that actually failed on 2026-09-09.
  const laundered = await out.from("attachments").select("id,name").eq("id", SECRET_FILE);
  check("after every attempt: the outsider still cannot read the attachments row",
    (laundered.data ?? []).length === 0,
    (laundered.data ?? []).length ? `*** ROW LEAKED: ${laundered.data[0].name} ***` : "0 rows");

  const afterSign = await out.storage.from("project-files").createSignedUrl(SECRET_FILE, 60);
  check("after every attempt: still cannot mint a signed URL",
    afterSign.data === null, afterSign.error?.message ?? "*** URL ISSUED ***");

  const servedBody = afterSign.data
    ? await (await fetch(afterSign.data.signedUrl)).text()
    : "";
  check("after every attempt: the secret bytes were NOT served",
    servedBody !== SECRET_BYTES,
    servedBody ? `*** BYTES: ${servedBody.slice(0, 24)} ***` : "nothing served");

  const afterGet = await out.storage.from("project-files").download(SECRET_FILE);
  check("after every attempt: cannot download the object directly",
    afterGet.data === null, afterGet.error?.message ?? "*** BYTES RETURNED ***");

  // DELETE. storage-api reports a filtered-away delete as `error: null` and
  // an EMPTY array, so the assertion is about the array AND the survival of
  // the bytes, never about the error alone.
  const outDel = await out.storage.from("project-files").remove([SECRET_FILE]);
  const stillThere = await own.storage.from("project-files").download(SECRET_FILE);
  check("outsider: a delete removes nothing, and the bytes survive",
    (outDel.data ?? []).length === 0 && stillThere.data !== null,
    `removed ${(outDel.data ?? []).length}; survives=${stillThere.data !== null}`);

  // -------------------------------------------------------------------
  // Task 8's open item, folded into this task's migration: the locked
  // Admin role. Not a Storage rule, but the same shape of attack — a raw
  // call from a client that skips the app.
  // -------------------------------------------------------------------
  const lock = await own.from("roles").update({ description: "edited" }).eq("id", "admin").select("id");
  check("admin: a raw edit of the LOCKED Admin role is refused by the database",
    lock.error !== null && /locked/i.test(lock.error?.message ?? ""),
    lock.error?.message ?? `*** ${lock.data?.length ?? 0} ROW(S) UPDATED ***`);

  const unlocked = await own.from("roles")
    .update({ description: "Day-to-day access: chat, create channels, and work with tasks." })
    .eq("id", "member").select("id");
  check("positive control: the same admin CAN still edit an unlocked role",
    unlocked.error === null && (unlocked.data ?? []).length === 1,
    unlocked.error?.message ?? "OK");
} catch (err) {
  // A throw here means the checks below it never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  for (const bucket of BUCKETS) {
    await svc.storage.from(bucket).remove([
      SECRET_FILE, OPEN_FILE, `att_stg_anon_${stamp}`, `att_stg_new_${stamp}`,
    ]);
  }
  // Conversations first: messages, dm_members and every message_attachments
  // link the laundering section created cascade from them.
  await svc.from("conversations").delete().in("id", dmId ? [CH, dmId] : [CH]);
  await svc.from("projects").delete().in("id", [OPEN, SECRET, OWNED]);
  await svc.from("attachments").delete().in("id", [
    SECRET_FILE, OPEN_FILE, `att_stg_anon_${stamp}`, `att_stg_new_${stamp}`,
  ]);
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
  console.log(
    failures === 0
      ? `\nALL STORAGE PROBES PASSED (${checks} checks)`
      : `\n${failures} STORAGE PROBE(S) FAILED (${checks} checks)`
  );
  process.exit(failures === 0 ? 0 : 1);
}
