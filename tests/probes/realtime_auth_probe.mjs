// Task 7 — the regression probe for the headline bug of this plan: live
// updates did not work in the real app while 629 unit tests, 234 access tests
// and 11 probes were green.
//
// THE THING BEING PINNED. A Realtime channel is authorized ONCE, at join
// time, by whatever token the SOCKET was carrying at that instant — a token
// that is set separately from the one REST requests use, which is why a
// working `hydrate()` proves nothing about it. The publishable ("anon") key
// is a token too, and every policy in this schema is `to authenticated`, so a
// channel that joins before the session is attached is filtered down to
// nothing. Not "unauthorized": SUBSCRIBED, healthy-looking, and permanently
// blind. Signing in afterwards does not repair it — supabase-js pushes the
// new token to the joined channel, and the existing postgres_changes
// subscription is not re-authorized by it.
//
// That is exactly the order the app takes: `StoreProvider` subscribes on
// mount and the session attaches separately. Every other test in this repo
// takes the other order — sign in, THEN subscribe — which is why none of them
// could see it. tests/probes/realtime_probe.mjs even calls
// `realtime.setAuth(token)` explicitly before subscribing, with a comment
// saying an unauthenticated socket would pass every negative while proving
// nothing. It was right about the probe and nobody carried it into the app.
//
// WHAT THIS FILE ASSERTS, in the order the checks print:
//
//   1. HAZARD (pinned) — a channel joined before sign-in receives nothing
//      even after signing in. If this ever fails, the platform has changed
//      and the re-join in lib/backend/supabase/realtime.ts may be able to go;
//      read the note here before deleting anything.
//   2. THE REGRESSION — `subscribeToWorkspace` ITSELF, the real module from
//      lib/backend/supabase/realtime.ts, imported and run here against the
//      real server in the app's own order (subscribe first, sign in after).
//      It must deliver a message written after sign-in. Until the final
//      review this check re-implemented the repair by hand instead, so
//      nothing committed bound the module to the server: the module was
//      pinned only against a fake client that models the hazard, and the
//      server was pinned only against an imitation of the module. Either one
//      could drift from the other with every test still green.
//   3. Control — a socket that signed in BEFORE subscribing receives the same
//      event. Without it, a failure of 1 or 2 could not be told apart from
//      "the write never produced an event at all".
//   4. Signing out re-joins as nobody, and the socket then receives nothing —
//      while the control, still signed in, receives the same write. A
//      session change must not leave the previous person's rows arriving.
//   5. HONESTY — what the module says about itself, against the real server:
//      it must not report `connection online: true` while it is joined as
//      nobody (every policy here is `to authenticated`, so such a channel
//      receives nothing by construction), and it must report `false` again
//      after a sign-out.
//
// NO SLEEPS. `subscribe()` races a rejection deadline; delivery is awaited by
// polling a predicate to a wall-clock deadline and returning the instant it
// holds. Every negative is bounded by a positive on another socket, so
// "nothing arrived" is only ever asserted after the same write has been seen
// arriving somewhere it was entitled to.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

// The module under test, imported for real — Node strips the types. This is
// the whole point of check 2: what runs below is the code the browser runs,
// not a description of it.
import { subscribeToWorkspace } from "../../lib/backend/supabase/realtime.ts";

config({ path: ".env.test.local", quiet: true });
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!URL || !anonKey || !process.env.SUPABASE_SECRET_KEY) {
  console.log("REFUSING: .env.test.local is missing SUPABASE_URL / _ANON_KEY / _SECRET_KEY.");
  process.exit(1);
}
if (URL.includes("eshstdmgceohizbevwll")) {
  console.log("REFUSING: that is the production project.");
  process.exit(1);
}
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const stamp = Date.now();
const pw = "probe-password-7c1d";
/** The topic the app uses. Constant across a re-join on purpose — see
 *  `rejoin()`: the app cannot make it unique per join, because presence is
 *  scoped to the topic, so the re-join has to work on a shared name. */
const TOPIC = `probe-workspace-${stamp}`;

const OPEN = `c_rtauth_open_${stamp}`;
const ids = {};
const clients = [];
/** Teardown for the real module's own subscription — it owns a channel and an
 *  auth listener, and both must go even if a check below throws. */
let moduleUnsubscribe = null;
let failures = 0;
let checks = 0;
const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};

const must = (label, { error }) => {
  if (error) throw new Error(`${label}: ${error.message}`);
};

const mkUser = async (who) => {
  const email = `rtauth-${who}-${stamp}@lumina.test`;
  const { data, error } = await svc.auth.admin.createUser({
    email, password: pw, email_confirm: true,
  });
  if (error) throw new Error(`createUser ${who}: ${error.message}`);
  ids[who] = data.user.id;
  const p = await svc.from("profiles").upsert({
    id: data.user.id, email, name: who, handle: `rtauth${who}${stamp}`,
    title: "", role_id: "member", color: "#000000",
  });
  if (p.error) throw new Error(`profile ${who}: ${p.error.message}`);
  return email;
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

/**
 * Opens `TOPIC` on `client`, collecting every `public` change event into
 * `sink`. Resolves with the channel once the join is acknowledged, or rejects
 * on a deadline rather than hanging.
 *
 * Note what it does NOT do: check who the socket is authorized as. That is
 * the whole point — `SUBSCRIBED` is exactly what a blind channel reports.
 */
const openChannel = async (label, client, sink) => {
  const ch = client.channel(TOPIC);
  ch.on("postgres_changes", { event: "*", schema: "public" }, (p) => sink.push(p));
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${label} never subscribed`)), 15_000);
    ch.subscribe((status, err) => {
      if (status === "SUBSCRIBED") { clearTimeout(timer); res(); }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        rej(new Error(`${label} subscribe status ${status}: ${err?.message ?? ""}`));
      }
    });
  });
  console.log(`  ${label}: SUBSCRIBED`);
  return ch;
};

const mkClient = () => {
  const c = createClient(URL, anonKey, { auth: { persistSession: false } });
  clients.push(c);
  return c;
};

const signIn = async (client, email) => {
  const { data, error } = await client.auth.signInWithPassword({ email, password: pw });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return data.session;
};

/** One message written with the service key, so what is under test is the
 *  broadcast filter and not a client-side write gate. */
const post = async (label) => {
  const id = `m_rtauth_${label}_${stamp}`;
  must(`write ${label}`, await svc.from("messages").insert({
    id, conversation_id: OPEN, author_id: ids.control, content: `rtauth ${label}`,
  }));
  return id;
};

const got = (sink, id) => sink.some((p) => p.eventType === "INSERT" && p.new?.id === id);

try {
  const appEmail = await mkUser("app");
  const controlEmail = await mkUser("control");

  // A public channel: readable by any signed-in user, and by nobody who is
  // not. That is the whole distinction this probe turns on.
  must("conversations", await svc.from("conversations").insert({ id: OPEN, kind: "channel" }));
  must("channels", await svc.from("channels").insert({
    id: OPEN, name: `rtauth-open-${stamp}`, description: "",
    is_private: false, is_team: false, created_by: ids.control,
  }));

  // -----------------------------------------------------------------
  // The control: signs in FIRST, then subscribes — the order every other
  // test in this repo takes, and the order that always worked.
  // -----------------------------------------------------------------
  const controlClient = mkClient();
  const controlSession = await signIn(controlClient, controlEmail);
  await controlClient.realtime.setAuth(controlSession.access_token);
  const seenByControl = [];
  await openChannel("control (signed in, then subscribed)", controlClient, seenByControl);

  // -----------------------------------------------------------------
  // The app's order: subscribe on mount, sign in afterwards.
  // -----------------------------------------------------------------
  const appClient = mkClient();
  const seenByApp = [];
  await openChannel("app (subscribed, then signed in)", appClient, seenByApp);
  await signIn(appClient, appEmail);

  // supabase-js's own `_handleTokenChanged` has already pushed the new token
  // to that joined channel by now. Give the write below every chance to
  // arrive on it: the check that follows is what says whether that was
  // enough. (It is not — hence the re-join.)
  const beforeRejoin = await post("before_rejoin");
  const controlSawFirst = await waitFor(
    "control receives the first write",
    () => got(seenByControl, beforeRejoin)
  );
  check(
    "positive control: a socket that signed in BEFORE subscribing receives the write",
    controlSawFirst,
    `${seenByControl.length} event(s) seen`
  );

  // Bounded by the control above: the event has demonstrably been produced
  // and delivered, so "the app socket does not have it" is a filtering
  // result, not a race.
  check(
    "HAZARD (pinned): a channel joined BEFORE sign-in stays blind afterwards — pushing it a token does not re-authorize it",
    !got(seenByApp, beforeRejoin),
    got(seenByApp, beforeRejoin)
      ? "*** it received the write — the platform changed; re-read the note at the top of this file before trusting or removing the re-join ***"
      : `${seenByApp.length} event(s) seen, none of them the write`
  );

  // -----------------------------------------------------------------
  // THE REGRESSION, driven through the REAL MODULE.
  //
  // A fresh client, signed out, handed straight to `subscribeToWorkspace` —
  // the app's own order and the app's own code, against the real server. No
  // step of the repair is performed here: if the module stops attaching the
  // session, stops re-joining on sign-in, or re-joins the wrong way, this
  // goes red. It is deliberately NOT told the topic, the token, or when to
  // re-join; it is only asked what it delivered.
  // -----------------------------------------------------------------
  const moduleClient = mkClient();
  /** Every `RealtimeEvent` the module emitted, and the connection half of
   *  them separately — what it CLAIMS about its own health, which is the
   *  other thing this branch exists to keep honest. */
  const fromModule = [];
  const health = [];
  /** Set the instant this probe hands the client a session, so any
   *  `online: true` recorded while it is false was said about a channel
   *  joined as nobody. A flag rather than a snapshot taken after the fact:
   *  a claim that arrives a moment late is the same claim. */
  let signedIn = false;
  let claimedHealthyAsNobody = false;
  moduleUnsubscribe = subscribeToWorkspace(moduleClient, (event) => {
    fromModule.push(event);
    if (event.kind !== "connection") return;
    health.push(event.online);
    if (event.online && !signedIn) claimedHealthyAsNobody = true;
  });
  const gotMessage = (id) =>
    fromModule.some((e) => e.kind === "message-insert" && e.message.id === id);

  // Let the anon join settle, so what the module says about itself while
  // joined as nobody is on the record before anyone signs in.
  await waitFor("the module reports on its first join", () => health.length > 0, 15_000);

  signedIn = true;
  await signIn(moduleClient, appEmail);
  // The module observes the session change itself (`onAuthStateChange`) and
  // re-joins. Waiting for it to SAY it is healthy, rather than sleeping.
  const moduleReportedUp = await waitFor(
    "the module reports online after sign-in",
    () => health[health.length - 1] === true
  );

  const afterRejoin = await post("after_rejoin");
  const moduleSaw = await waitFor(
    "the module delivers the write made after sign-in",
    () => gotMessage(afterRejoin)
  );
  check(
    "THE REGRESSION: subscribeToWorkspace itself, subscribed BEFORE sign-in, delivers a write made after it",
    moduleSaw,
    moduleSaw
      ? `received; the module emitted ${fromModule.length} event(s)`
      : `*** nothing arrived; ${fromModule.length} event(s) emitted in total ***`
  );
  check(
    "positive control: the same write reached the control socket too",
    await waitFor("control receives the second write", () => got(seenByControl, afterRejoin)),
    `${seenByControl.length} event(s) seen`
  );
  check(
    "the module reported itself online once it really was receiving",
    moduleReportedUp,
    `connection events: ${health.join(",") || "none"}`
  );
  // HONESTY (finding 8). Bounded by the check above: the module demonstrably
  // does say `true` when it is entitled to, so a `false` while joined as
  // nobody is a judgement and not a socket that never worked.
  check(
    "the module did NOT claim to be online while joined as nobody — no policy here grants the anon key anything",
    !claimedHealthyAsNobody,
    claimedHealthyAsNobody
      ? "*** reported online: true for a channel that receives nothing by construction ***"
      : "reported offline until it carried a session"
  );

  // -----------------------------------------------------------------
  // The other half of a session change: signing out must not leave the
  // previous person's rows arriving — and the module must say so.
  // -----------------------------------------------------------------
  health.length = 0;
  await moduleClient.auth.signOut();
  await waitFor(
    "the module reports the socket down after sign-out",
    () => health.includes(false)
  );

  const afterSignOut = await post("after_signout");
  const controlSawThird = await waitFor(
    "control receives the third write",
    () => got(seenByControl, afterSignOut)
  );
  check(
    "positive control: the third write was produced and delivered to an entitled socket",
    controlSawThird,
    `${seenByControl.length} event(s) seen`
  );
  check(
    "after sign-out the module's re-joined socket receives nothing — the token went with the session",
    !gotMessage(afterSignOut),
    gotMessage(afterSignOut)
      ? "*** a signed-out socket received a message row ***"
      : "silent, as an unauthenticated socket must be"
  );
  check(
    "and it says so: no online: true survives the sign-out",
    !health.includes(true),
    `connection events since sign-out: ${health.join(",") || "none"}`
  );

  console.log("\nhand-rolled app socket payload summary:");
  for (const p of seenByApp) {
    console.log(`  ${p.eventType.padEnd(6)} ${p.table.padEnd(16)} ${p.new?.id ?? p.old?.id ?? ""}`);
  }
  console.log("module event summary:");
  for (const e of fromModule) {
    console.log(
      `  ${e.kind.padEnd(15)} ${
        e.kind === "message-insert"
          ? e.message.id
          : e.kind === "connection"
            ? `online=${e.online}`
            : ""
      }`
    );
  }
} catch (err) {
  // A throw here means the checks below it never ran. Without this, `failures`
  // stays 0 and the epilogue cheerfully reports success for a probe that
  // asserted nothing.
  failures++;
  console.log(`*** SETUP/RUN ERROR *** ${err && err.message ? err.message : err}`);
} finally {
  try { moduleUnsubscribe?.(); } catch { /* teardown */ }
  for (const c of clients) {
    try { await c.removeAllChannels(); } catch { /* teardown */ }
  }
  await svc.from("conversations").delete().eq("id", OPEN);
  for (const id of Object.values(ids)) await svc.auth.admin.deleteUser(id);
  // A probe that asserted nothing must not report success. This is not
  // hypothetical: on 2026-09-08 a new database trigger made every probe's
  // setup throw, and all seven printed PASSED having checked nothing.
  if (checks === 0) {
    failures++;
    console.log("\n*** NO CHECKS RAN — this probe asserted nothing ***");
  }
  console.log(
    failures === 0
      ? `\nALL REALTIME AUTH PROBES PASSED (${checks} checks)`
      : `\n${failures} REALTIME AUTH PROBE(S) FAILED (${checks} checks)`
  );
  process.exit(failures === 0 ? 0 : 1);
}
