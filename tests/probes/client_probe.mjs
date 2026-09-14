// The client case record, attacked from an ordinary browser.
//
// WHY THIS RECORD GETS ITS OWN PROBE. Everything else in Lumina is work: a
// task title leaking is embarrassing. This table holds a named person's date
// of birth, home address, diagnosis, super-fund member number and - encrypted
// elsewhere, pointed at from here - the password to their fund's member
// portal. Those five facts together are enough to impersonate somebody to the
// institution holding their retirement savings.
//
// The suites for this feature were written by whoever wrote the feature, and
// share its blind spots. That is the standing reason these probes exist; it is
// a better reason here than anywhere else in the directory.
//
// EVERY CHECK IS MADE FROM A REAL SESSION with the publishable key that ships
// in the bundle - never through the service client, which bypasses RLS. The
// service client here only plants fixtures and cleans them up.
import { createClient } from "@supabase/supabase-js";

// Loads the env file and decides dev-vs-production. See ./_target.mjs.
import "./_target.mjs";
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-7c1d";
const PROJ = `p_cli_${stamp}`;
const OTHER = `p_cli_other_${stamp}`;

/** The facts an attacker would be after. Distinctive strings, so a substring
 *  search over a whole response body is a meaningful assertion. */
const DOB = "1968-03-02";
const DIAGNOSIS = `Stage 3 renal failure ${stamp}`;
const MEMBER = `AS-SECRET-${stamp}`;
const PORTAL_PASSWORD = `portal-pw-${stamp}-Xy9`;

const ids = {};
const clients = {};
let failures = 0;
let checks = 0;
const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};
/** A fixture write that must land. Not a check - if the setup for a check
 *  fails silently, the check that follows asserts nothing. */
const must = (label, { error }) => {
  if (error) throw new Error(`${label}: ${error.message}`);
};
const mkUser = async (who, roleId) => {
  const email = `cli-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `cl${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
};
const as = async (who) => {
  if (clients[who]) return clients[who];
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({
    email: `cli-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  // The socket carries its own authorization, separately from the REST client.
  // Without this the channel still reports SUBSCRIBED and then delivers
  // nothing forever, which would make every silence below meaningless.
  await c.realtime.setAuth(data.session.access_token);
  clients[who] = c;
  return c;
};

const channels = [];

/** Subscribe `who` to every change in `public` - the shape the app itself
 *  uses - and return the array their socket fills. */
const socket = async (who) => {
  const c = await as(who);
  const received = [];
  const ch = c
    .channel(`cli_rt_${who}_${stamp}`)
    .on("postgres_changes", { event: "*", schema: "public" }, (p) => received.push(p));
  channels.push({ client: c, ch });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${who} never subscribed`)), 10_000);
    ch.subscribe((status, err) => {
      if (status === "SUBSCRIBED") { clearTimeout(timer); res(); }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        rej(new Error(`${who} subscribe status ${status}: ${err?.message ?? ""}`));
      }
    });
  });
  return received;
};

/** Poll to a wall-clock deadline, returning the instant the predicate holds.
 *  Never a fixed wait followed by an assertion. */
const waitFor = async (label, predicate, deadlineMs = 20_000) => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`  (deadline reached waiting for: ${label})`);
  return false;
};

/** Every value in a payload, flattened, so a leak check can search the data
 *  and not merely the row ids. */
const blob = (p) => JSON.stringify([p.new ?? {}, p.old ?? {}]);
const clientRows = (list, project) =>
  list.filter((p) => p.table === "project_client_info" && (p.new?.project_id ?? p.old?.project_id) === project);

try {
  await mkUser("owner", "admin");
  await mkUser("editor", "member");
  await mkUser("viewer", "member");
  // NOT a stranger to the system: a full member, an editor on a DIFFERENT
  // case. This is the realistic attacker - a colleague, not an outsider.
  await mkUser("colleague", "member");

  for (const [id, name] of [[PROJ, "Reed case"], [OTHER, "Okafor case"]]) {
    const { error } = await svc.from("projects").insert({
      id, name, description: "", emoji: "🔒", color: "#000",
      priority: "high", restricted: true, created_by: ids.owner,
    });
    if (error) throw new Error(`project ${id}: ${error.message}`);
  }
  await svc.from("project_members").insert([
    { project_id: PROJ, user_id: ids.editor, level: "editor" },
    { project_id: PROJ, user_id: ids.viewer, level: "viewer" },
    { project_id: OTHER, user_id: ids.colleague, level: "editor" },
  ]);

  const seeded = await svc.from("project_client_info").insert({
    project_id: PROJ,
    full_name: "Dana Reed",
    date_of_birth: DOB,
    diagnosis: DIAGNOSIS,
    member_id: MEMBER,
    address: "12 Wattle St, Fitzroy VIC 3065",
    amount: 128450.5,
  });
  if (seeded.error) throw new Error(`seed record: ${seeded.error.message}`);
  await svc.from("project_client_documents").insert({
    project_id: PROJ, document_type: "certified_id", received: true,
  });

  const editor = await as("editor");
  const viewer = await as("viewer");
  const colleague = await as("colleague");

  // -------------------------------------------------------------------
  // Baseline, first: a probe whose fixtures never landed asserts nothing.
  // -------------------------------------------------------------------
  const base = await editor.from("project_client_info").select("*").eq("project_id", PROJ);
  check("baseline: the project's own editor CAN read the record",
    (base.data ?? []).length === 1 && base.data[0].diagnosis === DIAGNOSIS,
    (base.data ?? []).length ? "readable" : "NOTHING READ - fixtures may not exist");

  // -------------------------------------------------------------------
  // The colleague on another case
  // -------------------------------------------------------------------
  const byId = await colleague.from("project_client_info").select("*").eq("project_id", PROJ);
  check("a member on another case cannot read this one's record",
    (byId.data ?? []).length === 0,
    (byId.data ?? []).length ? `LEAKED: ${JSON.stringify(byId.data[0])}` : "hidden");

  // Asked WITHOUT a filter. A policy that returned every row would be invisible
  // to the check above, which names the id it expects to be refused.
  const sweep = await colleague.from("project_client_info").select("*");
  const body = JSON.stringify(sweep.data ?? []);
  check("an unfiltered sweep of the whole table returns none of this client",
    !body.includes(DIAGNOSIS) && !body.includes(MEMBER) && !body.includes(DOB) && !body.includes("Dana Reed"),
    body.includes(DIAGNOSIS) ? "DIAGNOSIS LEAKED IN A FULL-TABLE SELECT" : `${(sweep.data ?? []).length} row(s), none of them this one`);

  const docs = await colleague.from("project_client_documents").select("*");
  check("nor which of this client's documents have arrived",
    !JSON.stringify(docs.data ?? []).includes(PROJ),
    JSON.stringify(docs.data ?? []).includes(PROJ) ? "DOCUMENT STATUS LEAKED" : "hidden");

  // The join route. `select("*, projects(*)")` and its reverse are how an
  // embedded resource sometimes escapes a policy that guards the base table.
  const embed = await colleague.from("projects").select("*, project_client_info(*)");
  check("embedding the record through its project does not bypass the policy",
    !JSON.stringify(embed.data ?? []).includes(DIAGNOSIS),
    JSON.stringify(embed.data ?? []).includes(DIAGNOSIS) ? "LEAKED VIA EMBED" : "hidden");

  const write = await colleague.from("project_client_info")
    .update({ notes: "planted" }).eq("project_id", PROJ);
  const { data: afterWrite } = await svc.from("project_client_info")
    .select("notes").eq("project_id", PROJ).single();
  check("nor write to it",
    afterWrite.notes !== "planted",
    afterWrite.notes === "planted" ? "WROTE TO ANOTHER CASE'S RECORD" : `refused${write.error ? "" : " (silently)"}`);

  // -------------------------------------------------------------------
  // The viewer on this case: may read, may not change
  // -------------------------------------------------------------------
  const vRead = await viewer.from("project_client_info").select("full_name").eq("project_id", PROJ);
  check("baseline: a viewer on this case CAN read it", (vRead.data ?? []).length === 1);

  await viewer.from("project_client_info")
    .update({ full_name: "Changed By Viewer" }).eq("project_id", PROJ);
  const { data: afterViewer } = await svc.from("project_client_info")
    .select("full_name").eq("project_id", PROJ).single();
  check("a viewer cannot rewrite the record",
    afterViewer.full_name === "Dana Reed",
    afterViewer.full_name === "Changed By Viewer" ? "VIEWER REWROTE IT" : "unchanged");

  await viewer.from("project_client_documents").upsert(
    { project_id: PROJ, document_type: "bank_statement", received: true },
    { onConflict: "project_id,document_type" }
  );
  const { data: vDocs } = await svc.from("project_client_documents")
    .select("document_type").eq("project_id", PROJ).eq("document_type", "bank_statement");
  check("nor tick off a document", (vDocs ?? []).length === 0);

  // Creating the record on a case that has none is the same right as editing
  // one that does - and is the easier of the two to forget to gate.
  await viewer.from("project_client_info").insert({ project_id: OTHER, full_name: "Planted" });
  const { data: otherRow } = await svc.from("project_client_info")
    .select("full_name").eq("project_id", OTHER).maybeSingle();
  check("nor create a record on a case they cannot even see",
    !otherRow,
    otherRow ? "CREATED A RECORD ON A FOREIGN CASE" : "refused");

  // -------------------------------------------------------------------
  // The password
  // -------------------------------------------------------------------
  const set = await editor.rpc("set_client_password", {
    p_project_id: PROJ, p_value: PORTAL_PASSWORD,
  });
  check("baseline: the case's editor can store a portal password",
    set.error === null, set.error?.message ?? "stored");

  const row = await editor.from("project_client_info").select("*").eq("project_id", PROJ);
  check("the password is NOT on the row the browser fetches",
    !JSON.stringify(row.data ?? []).includes(PORTAL_PASSWORD),
    JSON.stringify(row.data ?? []).includes(PORTAL_PASSWORD) ? "PASSWORD IN THE ROW" : "only a pointer");

  // The whole hydrate, the way a real sign-in does it. If the value is
  // anywhere in what a browser receives, it is in that tab's memory.
  const everything = await Promise.all([
    editor.from("project_client_info").select("*"),
    editor.from("project_client_documents").select("*"),
    editor.from("projects").select("*"),
    editor.from("activities").select("*"),
  ]);
  const hydrateBody = JSON.stringify(everything.map((r) => r.data ?? []));
  check("nor anywhere in what a sign-in downloads",
    !hydrateBody.includes(PORTAL_PASSWORD),
    hydrateBody.includes(PORTAL_PASSWORD) ? "PASSWORD REACHED THE BROWSER" : "absent");

  const vReveal = await viewer.rpc("reveal_client_password", { p_project_id: PROJ });
  check("a viewer on this case cannot reveal it",
    vReveal.data === null && vReveal.error !== null,
    vReveal.data ? `REVEALED: ${vReveal.data}` : (vReveal.error?.message ?? ""));

  const cReveal = await colleague.rpc("reveal_client_password", { p_project_id: PROJ });
  check("nor can the member working another case",
    cReveal.data === null && cReveal.error !== null,
    cReveal.data ? `REVEALED: ${cReveal.data}` : (cReveal.error?.message ?? ""));

  // The two refusals must be indistinguishable from "no such project", or the
  // function tells an attacker which project ids are real.
  const ghost = await colleague.rpc("reveal_client_password", {
    p_project_id: `p_no_such_${stamp}`,
  });
  check("and a project that does not exist is refused in the same words",
    ghost.error?.message === cReveal.error?.message,
    `"${ghost.error?.message}" vs "${cReveal.error?.message}"`);

  const anon = createClient(URL, anonKey, { auth: { persistSession: false } });
  const aReveal = await anon.rpc("reveal_client_password", { p_project_id: PROJ });
  check("a signed-out caller cannot reveal it",
    aReveal.data === null && aReveal.error !== null,
    aReveal.data ? `REVEALED: ${aReveal.data}` : (aReveal.error?.message ?? ""));

  const aRead = await anon.from("project_client_info").select("*");
  check("nor read a single client record",
    (aRead.data ?? []).length === 0,
    (aRead.data ?? []).length ? "ANONYMOUS READ RETURNED ROWS" : "none");

  // The vault, reached directly. Not exposed to PostgREST at all - which is
  // the protection, and is worth asserting rather than assuming.
  const vault = await editor.schema("vault").from("decrypted_secrets").select("*");
  check("the vault itself is unreachable over the API",
    vault.error !== null && !JSON.stringify(vault.data ?? []).includes(PORTAL_PASSWORD),
    vault.error?.code ?? "NO ERROR RAISED");

  // -------------------------------------------------------------------
  // Looking leaves a mark
  // -------------------------------------------------------------------
  const before = await svc.from("activities").select("id").eq("project_id", PROJ);
  const ok = await editor.rpc("reveal_client_password", { p_project_id: PROJ });
  const after = await svc.from("activities").select("*").eq("project_id", PROJ);
  check("baseline: the editor's reveal returns the stored value",
    ok.data === PORTAL_PASSWORD, ok.error?.message ?? "returned");
  check("and a successful reveal is recorded, every time",
    (after.data ?? []).length === (before.data ?? []).length + 1,
    `${(before.data ?? []).length} -> ${(after.data ?? []).length} activity rows`);
  check("the record of it contains no part of the password",
    !JSON.stringify(after.data ?? []).includes(PORTAL_PASSWORD));

  // Somebody who could reveal it can also write to `activities` directly.
  // They must not be able to delete the line that says they looked.
  const line = (after.data ?? []).find((a) => a.text.includes("revealed"));
  await editor.from("activities").delete().eq("id", line.id);
  const { data: stillThere } = await svc.from("activities").select("id").eq("id", line.id);
  check("and the person who looked cannot delete their own audit line",
    (stillThere ?? []).length === 1,
    (stillThere ?? []).length ? "still there" : "AUDIT LINE DELETED BY THE VIEWER");

  await editor.from("activities").update({ text: "read the weather" }).eq("id", line.id);
  const { data: unedited } = await svc.from("activities").select("text").eq("id", line.id).single();
  check("nor rewrite it",
    unedited.text.includes("revealed"),
    unedited.text.includes("revealed") ? "unchanged" : "AUDIT LINE REWRITTEN");

  // -------------------------------------------------------------------
  // The live feed. Both client tables are in `supabase_realtime`, so a
  // colleague's edit refreshes the tab somebody else is looking at. That
  // publication is the whole of the wiring - which is exactly why it wants
  // a check that can fail. A table silently dropped from the publication by
  // a later migration breaks nothing loudly; the tab simply stops updating.
  //
  // TWO SOCKETS, for the reason realtime_probe.mjs gives: one subscriber
  // proves only that a socket is alive, and cannot tell "the rules withheld
  // it" from "the event was never produced". `colleague` - an editor on the
  // OTHER case - is the contrast.
  //
  // ORDERING, not elapsed time, is what makes the silences mean something.
  // The private write to PROJ commits BEFORE the visible write to OTHER.
  // Logical replication emits in commit order on one slot, so once the
  // colleague has received the OTHER event, the PROJ event has already been
  // past the filter and has either arrived or been dropped.
  // -------------------------------------------------------------------
  const editorFeed = await socket("editor");
  const colleagueFeed = await socket("colleague");

  // WARM UP BOTH SOCKETS FIRST, and do not proceed until each has actually
  // delivered something. `SUBSCRIBED` is the server accepting the join, not a
  // promise that the next commit is already being filtered for you: a write
  // issued in the moments after it can be missed. The first version of this
  // phase wrote immediately and failed once, then passed unchanged - which is
  // the signature of a race, and a probe that flakes is worse than no probe.
  //
  // Warming up on `projects` - not on the table under test - keeps this from
  // being the check itself. Each side warms on the case it is entitled to.
  const WARM = `rt-warm-${stamp}`;
  must("warm PROJ", await svc.from("projects").update({ description: WARM }).eq("id", PROJ));
  must("warm OTHER", await svc.from("projects").update({ description: WARM }).eq("id", OTHER));
  const warmed = (feed, project) => () =>
    feed.some((p) => p.table === "projects" && p.new?.id === project && p.new?.description === WARM);
  const bothWarm =
    await waitFor("the editor's socket to come alive", warmed(editorFeed, PROJ)) &&
    await waitFor("the colleague's socket to come alive", warmed(colleagueFeed, OTHER));
  check("both sockets are live before anything secret is written", bothWarm,
    bothWarm ? "warmed" : "A SOCKET NEVER WOKE - every silence below is meaningless");

  const MARK = `rt-mark-${stamp}`;
  must("private update", await svc.from("project_client_info")
    .update({ employer_name: MARK }).eq("project_id", PROJ));
  must("private document", await svc.from("project_client_documents")
    .upsert({ project_id: PROJ, document_type: "bank_statement", received: true },
      { onConflict: "project_id,document_type" }));
  // Commits after both of the above, and is the marker the colleague waits on.
  must("visible update", await svc.from("project_client_info")
    .upsert({ project_id: OTHER, employer_name: MARK }, { onConflict: "project_id" }));

  // What each socket actually received, always printed. A silence below is
  // only meaningful next to the tally that produced it.
  const tally = (feed) => feed.length === 0 ? "nothing"
    : [...new Set(feed.map((p) => `${p.eventType} ${p.table}`))].join(", ");

  const editorSaw = await waitFor("the editor's own case",
    () => clientRows(editorFeed, PROJ).some((p) => p.new?.employer_name === MARK));
  check("the case's editor is told when the client record changes", editorSaw,
    editorSaw ? "delivered" : "NO EVENT - is project_client_info still in the publication?");

  const editorSawDoc = await waitFor("the document tick",
    () => editorFeed.some((p) => p.table === "project_client_documents"
      && p.new?.project_id === PROJ && p.new?.document_type === "bank_statement"));
  check("and when a document is ticked off", editorSawDoc,
    editorSawDoc ? "delivered" : "NO EVENT - is project_client_documents still in the publication?");

  const colleagueAlive = await waitFor("the colleague's own case",
    () => clientRows(colleagueFeed, OTHER).some((p) => p.new?.employer_name === MARK));
  check("CONTROL: the colleague's socket receives THEIR case's record", colleagueAlive,
    colleagueAlive ? "delivered" : "SOCKET SILENT - the silences below prove nothing");

  // Only meaningful because the control above landed.
  const leaked = clientRows(colleagueFeed, PROJ);
  check("a colleague on another case is NOT told this client's record changed",
    bothWarm && colleagueAlive && leaked.length === 0,
    leaked.length ? `${leaked.length} EVENT(S) LEAKED` : "silent");

  // MARK is deliberately absent from this list: it is on the colleague's own
  // record too, so finding it proves nothing. These three are on PROJ alone.
  const colleagueBlob = colleagueFeed.map(blob).join("");
  const leakedFact = [DIAGNOSIS, MEMBER, DOB].find((fact) => colleagueBlob.includes(fact));
  check("and no part of this client's details reaches their socket",
    bothWarm && colleagueAlive && !leakedFact,
    leakedFact ? `LEAKED: ${leakedFact}` : "nothing");

  // The password lives in the vault, not on the row, so it cannot be in the
  // WAL. Asserted rather than assumed, on the socket entitled to everything.
  const editorBlob = editorFeed.map(blob).join("");
  check("the portal password is in no payload, not even the editor's",
    editorSaw && !editorBlob.includes(PORTAL_PASSWORD),
    editorBlob.includes(PORTAL_PASSWORD) ? "PASSWORD IN THE LIVE FEED" : "absent");

  console.log(`  editor socket    : ${tally(editorFeed)}`);
  console.log(`  colleague socket : ${tally(colleagueFeed)}`);
} catch (err) {
  // A throw here means the checks below never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  // Sockets first: an open channel holds the process alive past the exit.
  for (const { client, ch } of channels) {
    try { await client.removeChannel(ch); } catch { /* closing, not asserting */ }
  }

  // The projects cascade both client tables, and the delete trigger takes the
  // vault secret with them.
  await svc.from("projects").delete().in("id", [PROJ, OTHER]);
  for (const id of Object.values(ids)) await svc.auth.admin.deleteUser(id);

  // The ciphertext must not outlive the case. Asked through the audit
  // function, because `vault.secrets` is unreachable over the API even for the
  // service role - a direct query returns PGRST106 with `data: null`, which
  // reads as "no rows" and would make this check a lie.
  const { data: leftovers, error: auditError } = await svc.rpc("client_secret_ids");
  if (auditError) {
    failures++;
    console.log(`*** FAIL ***  could not audit the vault: ${auditError.message}`);
  } else {
    const orphans = (leftovers ?? []).filter((r) => !r.referenced);
    check("no client-password ciphertext is left orphaned in the vault",
      orphans.length === 0,
      orphans.length ? `${orphans.length} ORPHANED SECRET(S)` : "none");
  }

  const { data } = await svc.auth.admin.listUsers({ perPage: 100 });
  console.log(`\ncleanup: ${data.users.length} users remain (expect 0)`);
  if (checks === 0) {
    failures++;
    console.log("\n*** NO CHECKS RAN — this probe asserted nothing ***");
  }
  console.log(failures === 0 ? "\nALL CLIENT PROBES PASSED" : `\n${failures} CLIENT PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
