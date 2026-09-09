// Controller probe for the live-updates publication (realtime Task 1).
//
// The claim under attack: putting a table into `supabase_realtime` does NOT
// widen who can read it — a change event is delivered to a subscriber only if
// that subscriber could have SELECTed the row. Every policy in this schema is
// `to authenticated` and scoped, so if that claim holds, an outsider's socket
// must stay silent for a private channel, someone else's DM, a restricted
// project, a scoped activity and another user's read position.
//
// This is the task that gates the rest of the plan: Task 3 wires these events
// into `AppState`, and a browser that receives a payload has the payload
// whatever the renderer does with it. So the question is answered empirically
// here, against the real dev database, before anything is built on the answer.
//
// TWO SUBSCRIBERS, on purpose. A single positive control proves only that the
// outsider's socket is alive; it cannot tell "the rules withheld it" from "the
// event was never produced at all". The `owner` socket — an admin, entitled to
// every secret fixture — closes that gap. A negative then means precisely: the
// same event was delivered to an entitled subscriber and withheld from the
// outsider. That contrast is what establishes that row-level security filters
// change events, rather than assuming it from silence.
//
// NO SLEEPS. `subscribe()` races a 10s rejection deadline; delivery is awaited
// by polling a predicate to a wall-clock deadline, returning the instant it
// holds. Nothing waits a fixed duration and then asserts.
//
// ORDERING is what makes the negatives non-vacuous, not elapsed time. Every
// secret write commits BEFORE every visible write. Postgres logical replication
// emits in commit order on one slot, so once the outsider receives the LAST
// visible marker, every phase-A event has already been through the filter and
// has either arrived or been dropped. The owner socket independently confirms
// those phase-A events were produced at all.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.test.local", quiet: true });
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-7c1d";

// A marker that appears ONLY inside private message content, so checks 11 and
// 12 can scan whole payloads for field-level disclosure rather than only ids.
const SECRET_MARK = `PAYROLL-SECRET-${stamp}`;

const PRIV = `c_rt_priv_${stamp}`; // private channel, outsider not a member
const OPEN = `c_rt_open_${stamp}`; // public channel, everyone may read
const DM = `c_rt_dm_${stamp}`; // owner <-> third, outsider not party
const PRIV_MSG = `m_rt_priv_${stamp}`;
const DM_MSG = `m_rt_dm_${stamp}`;
const OPEN_MSG = `m_rt_open_${stamp}`;
const SECRET_PROJ = `p_rt_secret_${stamp}`;
const SECRET_TASK = `t_rt_secret_${stamp}`;
const SECRET_ACT = `a_rt_secret_${stamp}`;

const ids = {};
const clients = {};
const channels = [];
let failures = 0;
let checks = 0;
const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};

const mkUser = async (who, roleId) => {
  const email = `rt-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  // Recorded before the profile step: if that throws, the finally block must
  // still be able to delete this auth user.
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `rt${who}${stamp}`,
    title: "", role_id: roleId, color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
};

/** Sign in AND hand the socket the access token — an unauthenticated socket
 *  passes every negative below while proving nothing. */
const as = async (who) => {
  if (clients[who]) return clients[who];
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({
    email: `rt-${who}-${stamp}@lumina.test`, password: pw,
  });
  if (error) throw new Error(`sign-in ${who}: ${error.message}`);
  await c.realtime.setAuth(data.session.access_token);
  clients[who] = c;
  return c;
};

/** Subscribe `who` to every change event in `public`, exactly the shape Task 3
 *  will use. Rejects on a deadline rather than hanging forever. */
const subscribe = async (who) => {
  const c = await as(who);
  const received = [];
  const ch = c
    .channel(`probe_rt_${who}_${stamp}`)
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

/** Poll a predicate to a wall-clock deadline. Returns the instant it holds;
 *  reports false if the deadline passes. Never a fixed wait-then-assert. */
const waitFor = async (label, predicate, deadlineMs = 20_000) => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`  (deadline reached waiting for: ${label})`);
  return false;
};

const must = (label, { error }) => {
  if (error) throw new Error(`${label}: ${error.message}`);
};

/** Every payload field, flattened, so a leak check can look at values not just ids. */
const blob = (p) => JSON.stringify([p.new ?? {}, p.old ?? {}]);
const touches = (list, id) => list.some((p) => p.new?.id === id);
const anyRef = (list, id) => list.some((p) => p.new?.id === id || p.old?.id === id);

try {
  await mkUser("owner", "admin"); // members.manage -> entitled to everything
  await mkUser("outsider", "member"); // the attacker: no members.manage
  await mkUser("third", "member"); // the owner's DM partner

  // ---------------------------------------------------------------
  // Both sockets go up BEFORE any fixture write, so every write below
  // is an observable event rather than pre-existing state.
  // ---------------------------------------------------------------
  const seenByOutsider = await subscribe("outsider");
  const seenByOwner = await subscribe("owner");
  console.log("both sockets SUBSCRIBED\n");

  // ---------------------------------------------------------------
  // PHASE A — the secrets. All commit before any visible write.
  // Written with the service key on purpose: what is under test is the
  // broadcast filter, and a service-key write produces the WAL event
  // with no client-side gating to muddy the result.
  // ---------------------------------------------------------------
  must("conversations priv", await svc.from("conversations").insert({ id: PRIV, kind: "channel" }));
  must("channels priv", await svc.from("channels").insert({
    id: PRIV, name: `rt-priv-${stamp}`, description: "",
    is_private: true, is_team: false, created_by: ids.owner,
  }));
  must("channel_members priv", await svc.from("channel_members").insert({
    channel_id: PRIV, user_id: ids.owner, level: "editor",
  }));
  must("private message", await svc.from("messages").insert({
    id: PRIV_MSG, conversation_id: PRIV, author_id: ids.owner,
    content: `private channel ${SECRET_MARK}`,
  }));

  must("conversations dm", await svc.from("conversations").insert({ id: DM, kind: "dm" }));
  must("dms", await svc.from("dms").insert({ id: DM }));
  must("dm_members", await svc.from("dm_members").insert([
    { dm_id: DM, user_id: ids.owner }, { dm_id: DM, user_id: ids.third },
  ]));
  must("dm message", await svc.from("messages").insert({
    id: DM_MSG, conversation_id: DM, author_id: ids.owner,
    content: `dm ${SECRET_MARK}`,
  }));
  await waitFor("owner: dm message INSERT",
    () => seenByOwner.some((p) => p.eventType === "INSERT" && p.new?.id === DM_MSG));

  must("restricted project", await svc.from("projects").insert({
    id: SECRET_PROJ, name: "Payroll", description: "", emoji: "🔒", color: "#000",
    priority: "high", restricted: true, created_by: ids.owner,
  }));
  must("project_members", await svc.from("project_members").insert({
    project_id: SECRET_PROJ, user_id: ids.owner, level: "editor",
  }));
  must("restricted task", await svc.from("tasks").insert({
    id: SECRET_TASK, project_id: SECRET_PROJ, title: `task ${SECRET_MARK}`,
    created_by: ids.owner,
  }));
  await waitFor("owner: restricted task INSERT",
    () => seenByOwner.some((p) => p.eventType === "INSERT" && p.new?.id === SECRET_TASK));

  // Scoped to the restricted project: activities_read filters on project_id.
  must("scoped activity", await svc.from("activities").insert({
    id: SECRET_ACT, actor_id: ids.owner, text: `activity ${SECRET_MARK}`,
    kind: "project", project_id: SECRET_PROJ,
  }));
  await waitFor("owner: scoped activity INSERT",
    () => seenByOwner.some((p) => p.eventType === "INSERT" && p.new?.id === SECRET_ACT));

  // read_state_own is the strictest policy in the schema: user_id = auth.uid().
  // Composite PK (user_id, conversation_id) and NO id column, so it is matched
  // on the pair, never on `new.id`.
  must("third read_state", await svc.from("read_state").insert({
    user_id: ids.third, conversation_id: PRIV,
  }));

  // UPDATE then DELETE of the private message — the two event types a
  // publication-level filter is most likely to get wrong.
  //
  // EACH IS CONFIRMED ON THE ENTITLED SOCKET BEFORE THE NEXT IS ISSUED, and
  // that is not politeness. Measured on dev while writing this probe: Realtime
  // polls the WAL on an interval, and if a row is inserted-or-updated and then
  // deleted before the next poll, the INSERT/UPDATE events for it are dropped
  // for EVERY subscriber while the DELETE still goes out. A probe that fired
  // all three writes back-to-back therefore asserted "the outsider received no
  // UPDATE carrying the secret" about an UPDATE event that was never produced
  // — a vacuous negative that passes no matter how broken the filter is.
  // Waiting for the owner to see each event is what proves it existed.
  await waitFor("owner: private message INSERT",
    () => seenByOwner.some((p) => p.eventType === "INSERT" && p.new?.id === PRIV_MSG));

  must("private message UPDATE", await svc.from("messages")
    .update({ content: `private EDITED ${SECRET_MARK}` }).eq("id", PRIV_MSG));
  await waitFor("owner: private message UPDATE",
    () => seenByOwner.some((p) => p.eventType === "UPDATE" && p.new?.id === PRIV_MSG));

  must("private message DELETE", await svc.from("messages").delete().eq("id", PRIV_MSG));
  await waitFor("owner: private message DELETE",
    () => seenByOwner.some((p) => p.eventType === "DELETE" && p.old?.id === PRIV_MSG));

  // ---------------------------------------------------------------
  // PHASE B — what the outsider IS entitled to. Commits strictly after
  // every secret above, so its arrival proves phase A has been decided.
  // ---------------------------------------------------------------
  must("conversations open", await svc.from("conversations").insert({ id: OPEN, kind: "channel" }));
  must("channels open", await svc.from("channels").insert({
    id: OPEN, name: `rt-open-${stamp}`, description: "",
    is_private: false, is_team: false, created_by: ids.owner,
  }));
  must("open message", await svc.from("messages").insert({
    id: OPEN_MSG, conversation_id: OPEN, author_id: ids.owner, content: "public hello",
  }));
  must("outsider read_state", await svc.from("read_state").insert({
    user_id: ids.outsider, conversation_id: OPEN,
  }));
  // Same per-event confirmation as phase A, for the same reason.
  await waitFor("outsider: open message INSERT",
    () => seenByOutsider.some((p) => p.eventType === "INSERT" && p.new?.id === OPEN_MSG));

  must("open message UPDATE", await svc.from("messages")
    .update({ content: "public hello EDITED" }).eq("id", OPEN_MSG));
  await waitFor("outsider: open message UPDATE",
    () => seenByOutsider.some((p) => p.eventType === "UPDATE" && p.new?.id === OPEN_MSG));

  must("open message DELETE", await svc.from("messages").delete().eq("id", OPEN_MSG));
  // The last visible marker. Once it lands, commit order guarantees every
  // phase-A event has already been through the filter.
  await waitFor("outsider: open message DELETE (last marker)",
    () => seenByOutsider.some((p) => p.eventType === "DELETE" && p.old?.id === OPEN_MSG));

  console.log(`\noutsider socket received ${seenByOutsider.length} event(s)`);
  console.log(`owner    socket received ${seenByOwner.length} event(s)\n`);

  // ---------------------------------------------------------------
  // POSITIVE CONTROLS. Without these, a socket that silently failed to
  // connect passes every negative below.
  // ---------------------------------------------------------------
  check("positive control: outsider receives the open-channel message INSERT",
    seenByOutsider.some((p) => p.eventType === "INSERT" && p.new?.id === OPEN_MSG),
    `${seenByOutsider.length} events seen`);

  check("positive control: the ENTITLED owner DOES receive the private message INSERT",
    seenByOwner.some((p) => p.eventType === "INSERT" && p.new?.id === PRIV_MSG),
    `${seenByOwner.length} events seen`);

  // Matched on the composite PK: read_state has no `id` column.
  check("positive control: outsider receives their OWN read_state INSERT (filtering is per-table)",
    seenByOutsider.some((p) => p.table === "read_state" && p.eventType === "INSERT"
      && p.new?.user_id === ids.outsider && p.new?.conversation_id === OPEN),
    "own read position");

  check("positive control: outsider receives the open message UPDATE",
    seenByOutsider.some((p) => p.eventType === "UPDATE" && p.new?.id === OPEN_MSG),
    "UPDATE events do arrive");

  // NOTE: passes under EITHER outcome — the outsider is entitled to this row.
  // It is a clean control for "DELETEs arrive at all", which is what keeps
  // the ACCEPTED LIMITATION pin below from being vacuous.
  check("positive control: outsider receives the open message DELETE",
    seenByOutsider.some((p) => p.eventType === "DELETE" && p.old?.id === OPEN_MSG),
    "DELETE events do arrive");

  // CONTROLS THAT KEEP THE UPDATE NEGATIVE AND THE DELETE PIN NON-VACUOUS.
  // Without these, "the outsider received no private UPDATE" or "the
  // outsider's DELETE receipt is bounded" would also pass if the event had
  // never been produced — which, as the comment in phase A records, is a
  // state this database can genuinely be in.
  check("control for check 11: the private message UPDATE was produced at all (owner saw it)",
    seenByOwner.some((p) => p.eventType === "UPDATE" && p.new?.id === PRIV_MSG),
    "entitled subscriber received it");

  check("control for the ACCEPTED LIMITATION pin: the private message DELETE was produced at all (owner saw it)",
    seenByOwner.some((p) => p.eventType === "DELETE" && p.old?.id === PRIV_MSG),
    "entitled subscriber received it");

  // CONTROLS THAT KEEP THE REMAINING THREE NEGATIVES BELOW NON-VACUOUS. Same
  // reasoning as the two controls immediately above: without proof the owner
  // (entitled to every secret fixture) actually received each of these, "the
  // outsider received none of it" could equally mean "it was withheld" or
  // "it was never produced" — and those are not the same finding.
  check("control: the DM message was produced at all (owner saw it)",
    seenByOwner.some((p) => p.eventType === "INSERT" && p.new?.id === DM_MSG),
    "entitled subscriber received it");

  check("control: the restricted task was produced at all (owner saw it)",
    seenByOwner.some((p) => p.eventType === "INSERT" && p.new?.id === SECRET_TASK),
    "entitled subscriber received it");

  check("control: the scoped activity was produced at all (owner saw it)",
    seenByOwner.some((p) => p.eventType === "INSERT" && p.new?.id === SECRET_ACT),
    "entitled subscriber received it");

  // ---------------------------------------------------------------
  // NEGATIVES REQUIRED BY THE BRIEF.
  // ---------------------------------------------------------------
  check("outsider receives NO message from a private channel",
    !touches(seenByOutsider, PRIV_MSG), "private channel message");

  check("outsider receives NO message from another pair's DM",
    !touches(seenByOutsider, DM_MSG), "DM message");

  check("outsider receives NO task from a restricted project",
    !touches(seenByOutsider, SECRET_TASK), "restricted task");

  check("outsider receives NO activity scoped to a project they cannot see",
    !touches(seenByOutsider, SECRET_ACT), "scoped activity");

  // ---------------------------------------------------------------
  // EXTENDED NEGATIVES — same subscription, no extra cost, covering the
  // published tables carrying the strictest policies.
  // ---------------------------------------------------------------
  check("outsider receives NO read_state row belonging to another user",
    !seenByOutsider.some((p) => p.table === "read_state"
      && (p.new?.user_id === ids.third || p.old?.user_id === ids.third)),
    "another user's read position");

  const leakedUpdate = seenByOutsider.filter(
    (p) => p.eventType === "UPDATE" && blob(p).includes(SECRET_MARK));
  check("outsider receives NO UPDATE payload carrying private message content",
    leakedUpdate.length === 0,
    leakedUpdate.length ? `*** ${leakedUpdate.map((p) => p.table).join(",")} ***` : "none");

  // ACCEPTED LIMITATION — NOT AN OVERSIGHT. THIS IS A PIN, NOT A FEATURE TEST.
  //
  // Row-level security filters INSERT and UPDATE change events (proved above)
  // but NOT DELETE: an outsider's socket receives the DELETE for a message in
  // a private channel they cannot see and are not a member of. `replica
  // identity full` does not widen this — it was expected to turn a bare-key
  // delete into a full-row disclosure, but empirically it does not: the
  // Realtime platform truncates `postgres_changes` DELETE payloads to the
  // identity columns for EVERY subscriber, entitled or not (see the owner's
  // own DELETE payload in the diagnostic dump below — equally bare).
  //
  // WHAT LEAKS: the row's primary key only, e.g. `old: {"id": "m_rt_..."}`.
  // An outsider learns that a message with that id existed in some channel
  // and was deleted, and — since ids are generated client-side here —
  // potentially something about the id-generation scheme.
  // WHAT DOES NOT LEAK: message content, channel id, project, author, or any
  // other column. No `new` row is ever attached to a DELETE either.
  //
  // WHY ACCEPTED (decision recorded 2026-09-09): every signed-in user in this
  // workspace is a colleague on the SAME team; the leaked id is opaque and
  // cannot be linked to a channel, project, or author; no content escapes.
  // The alternative — a tombstone table plus triggers on all twelve published
  // tables, replacing DELETE with RLS-filtered synthetic INSERTs — was priced
  // and declined as disproportionate to a bare-id disclosure.
  //
  // WHAT WOULD MAKE THIS UNACCEPTABLE: this workspace hosting more than one
  // team. At that point an opaque id is no longer harmless — cross-team
  // existence disclosure is exactly what row-level security exists to
  // prevent — and this decision must be revisited (build the tombstone /
  // scoped-broadcast alternative that was declined here).
  //
  // WHAT THIS CHECK ASSERTS: not "there is no leak" (there is, durably, until
  // the platform changes) but that the leak stays BOUNDED to the primary key.
  // It reads every DELETE payload the outsider actually received for the
  // private message and requires AT LEAST ONE to have arrived, AND each
  // one's `old` to contain the `id` field and NOTHING else. Widen the
  // disclosure — e.g. a future platform version starts including other
  // columns in a DELETE payload — and this goes RED.
  //
  // The `.length > 0 &&` guard is load-bearing, not decorative: `.every()`
  // on an empty array returns `true`, so without it, a run in which the
  // outsider's DELETE never arrived at all would report this pin as PASSING
  // — the same vacuous-negative shape this file already fixed once for the
  // UPDATE/DELETE ordering above. An empty `outsiderPrivDeletes` is NOT a
  // stronger, better-secured outcome to shrug past: it means DELETE events
  // stopped being published to this socket, which is itself a reportable
  // change to the very disclosure this check exists to keep bounded — so it
  // FAILS the check, loudly, rather than passing by default. (The companion
  // positive controls above — "outsider receives the open message DELETE"
  // and "control for the ACCEPTED LIMITATION pin: the private message
  // DELETE was produced at all" — independently confirm DELETE events are
  // being produced and delivered at all, so when this check goes red for an
  // empty array, that red is diagnosable as "stopped arriving at the
  // outsider specifically," not "the whole delivery path is broken.")
  const outsiderPrivDeletes = seenByOutsider.filter(
    (p) => p.eventType === "DELETE" && p.old?.id === PRIV_MSG);
  const boundedToPrimaryKey = outsiderPrivDeletes.length > 0 && outsiderPrivDeletes.every((p) => {
    const keys = Object.keys(p.old ?? {});
    return keys.length === 1 && keys[0] === "id";
  });
  check("ACCEPTED LIMITATION (pinned): outsider's DELETE receipt for the private message is bounded to the primary key only",
    boundedToPrimaryKey,
    outsiderPrivDeletes.length
      ? `old=${JSON.stringify(outsiderPrivDeletes.map((p) => p.old))}`
      : "*** NO DELETE ARRIVED AT THE OUTSIDER — deletes stopped being published; this is NOT a pass ***");

  check("outsider receives NO channels row for the private channel",
    !seenByOutsider.some((p) => p.table === "channels" && (p.new?.id === PRIV || p.old?.id === PRIV)),
    "private channel row");

  check("outsider receives NO projects / project_members row for the restricted project",
    !anyRef(seenByOutsider.filter((p) => p.table === "projects"), SECRET_PROJ)
      && !seenByOutsider.some((p) => p.table === "project_members"
        && (p.new?.project_id === SECRET_PROJ || p.old?.project_id === SECRET_PROJ)),
    "restricted project rows");

  // Diagnostic, not a check: the exact DELETE payloads, for the record. This
  // is what the ACCEPTED LIMITATION pin above is asserting stays true: a bare
  // primary key (existence disclosure) rather than a full old row (content
  // disclosure) — for every subscriber, entitled or not.
  console.log("\nDELETE payloads in full:");
  for (const [who, list] of [["outsider", seenByOutsider], ["owner", seenByOwner]]) {
    for (const p of list.filter((x) => x.eventType === "DELETE")) {
      console.log(`  ${who.padEnd(9)} ${p.table} old=${JSON.stringify(p.old)} new=${JSON.stringify(p.new)}`);
    }
  }

  // Diagnostic, not a check: what the outsider actually saw, for the report.
  console.log("\noutsider payload summary:");
  for (const p of seenByOutsider) {
    console.log(`  ${p.eventType.padEnd(6)} ${p.table.padEnd(16)} ${JSON.stringify(p.new?.id ?? p.old?.id ?? p.new ?? p.old).slice(0, 60)}`);
  }
  console.log("owner payload summary:");
  for (const p of seenByOwner) {
    console.log(`  ${p.eventType.padEnd(6)} ${p.table.padEnd(16)} ${JSON.stringify(p.new?.id ?? p.old?.id ?? p.new ?? p.old).slice(0, 60)}`);
  }
} catch (err) {
  // A throw here means the checks below it never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  for (const { client, ch } of channels) {
    try { await ch.unsubscribe(); await client.removeAllChannels(); } catch { /* teardown */ }
  }
  // Conversations first: messages, channels, dms, dm_members, read_state and
  // conversation-scoped activities all cascade from them. Projects cascade
  // tasks, project_members and project-scoped activities.
  await svc.from("conversations").delete().in("id", [PRIV, OPEN, DM]);
  await svc.from("projects").delete().in("id", [SECRET_PROJ]);
  await svc.from("activities").delete().in("id", [SECRET_ACT]);
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
      ? `\nALL REALTIME PROBES PASSED (${checks} checks)`
      : `\n${failures} REALTIME PROBE(S) FAILED (${checks} checks)`
  );
  process.exit(failures === 0 ? 0 : 1);
}
