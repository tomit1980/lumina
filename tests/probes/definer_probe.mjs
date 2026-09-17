// Can a signed-out browser enter the body of a `security definer` function?
//
// WHY THIS IS ITS OWN PROBE. `security definer` means the function runs with
// its OWNER's privileges, not the caller's: inside it, RLS is not consulted
// and `select 1 from public.projects` sees every row in the workspace. That is
// exactly why these helpers exist — a policy that read the table directly
// would be filtered by the visibility it is trying to decide. It also means
// the only thing standing between an anonymous caller and owner-level reads is
// whatever the function's own first lines do about `auth.uid()` being null.
//
// Those first lines are correct today. Every one of these functions refuses an
// anonymous caller on its own merits, and 20260916000400 does not fix a leak.
// What it fixes is that the defence lived in ONE place — the order of
// statements inside a function body — where an ordinary edit could move it and
// nothing outside that file would notice. EXECUTE is the door; the body is the
// bouncer. This probe asserts the door.
//
// THE TRAP THAT CREATED THE FINDING. `revoke all on function ... from public`
// reads like it closes everything and does not. Supabase ships default
// privileges on the `public` schema granting EXECUTE on every new function to
// `anon`, `authenticated` and `service_role` BY NAME. Revoking from PUBLIC
// removes only the implicit grant every function is born with. So the familiar
// pair — `revoke all from public; grant execute to authenticated` — leaves a
// signed-out caller able to execute the function. It was found once, for the
// client functions (20260914000400), by reading a refusal message carefully:
// the refusal was a sentence from INSIDE the function.
//
// Every check here is made from an ANONYMOUS client using the publishable key
// that ships in the public bundle. The service client only plants and removes
// the one fixture user.
import { createClient } from "@supabase/supabase-js";

// Loads the env file and decides dev-vs-production. See ./_target.mjs.
import "./_target.mjs";
const URL = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const anon = createClient(URL, anonKey, { auth: { persistSession: false } });
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const pw = "probe-password-4b81";
// A syntactically valid uuid that belongs to nobody. Arguments have to cast
// before the call is attempted, or a cast error would be mistaken for a
// refusal.
const NOBODY = "00000000-0000-0000-0000-000000000000";

/** Every callable `security definer` function this migration closes, with
 *  arguments PostgREST will accept. None of these is a write. */
const SHUT = [
  ["actor_rank", {}],
  ["can_join_dm", { target_dm_id: "d_nope" }],
  ["can_see_attachment", { att_id: "att_nope" }],
  ["can_see_conversation", { conv_id: "c_general" }],
  ["can_see_profile", { target_user_id: NOBODY }],
  ["can_see_project", { proj_id: "p_nope" }],
  ["channel_is_manageable", { target_channel_id: "c_general" }],
  ["has_permission", { perm: "members.manage" }],
  ["is_attachment_uploader", { att_id: "att_nope" }],
  ["my_role_id", {}],
  ["password_is_current", {}],
  ["project_is_manageable", { target_project_id: "p_nope" }],
  ["project_is_viewer_only", { proj_id: "p_nope" }],
  ["session_is_assured", {}],
  ["user_can_see_project", { project_id: "p_nope", user_id: NOBODY }],
];

/** `find_or_create_dm` is the sixteenth and is kept out of the list above
 *  because it WRITES. It is asserted separately, and the assertion is
 *  stronger for it: no dm row may appear. */
const WRITER = "find_or_create_dm";

let failures = 0;
let checks = 0;
const check = (label, pass, detail = "") => {
  checks++;
  console.log(`${pass ? "PASS" : "*** FAIL ***"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!pass) failures++;
};
/** A fixture write that must land. Not a check — a check whose setup failed
 *  silently asserts nothing. */
const must = (label, { error }) => {
  if (error) throw new Error(`${label}: ${error.message}`);
};

/** The door, not the bouncer. 42501 is `insufficient_privilege`: Postgres
 *  refused the CALL. Anything else — a value, a null, or a message written
 *  inside the function — means the anonymous role got into the body. */
const shutOut = (error) =>
  Boolean(error) && (error.code === "42501" || /permission denied for function/i.test(error.message ?? ""));

const describe = (error, data) =>
  error ? `${error.code ?? "?"} ${error.message}` : `ENTERED THE BODY, returned ${JSON.stringify(data)}`;

let cleanup = null;

async function main() {
  console.log(`\nSigned-out caller vs. security definer functions — ${URL}\n`);

  for (const [fn, args] of SHUT) {
    const { data, error } = await anon.rpc(fn, args);
    check(`anon is refused at the door by ${fn}()`, shutOut(error), describe(error, data));
  }

  // The writer, and the consequence rather than only the error code.
  const before = await svc.from("dms").select("id");
  must("count dms before", before);
  const wrote = await anon.rpc(WRITER, { other_user_id: NOBODY });
  check(`anon is refused at the door by ${WRITER}()`, shutOut(wrote.error), describe(wrote.error, wrote.data));
  const after = await svc.from("dms").select("id");
  must("count dms after", after);
  check(
    `${WRITER}() created no dm for a signed-out caller`,
    after.data.length === before.data.length,
    `${before.data.length} -> ${after.data.length}`
  );

  // CONTROL 1 — a function closed to anon in an EARLIER migration. If this
  // one ever reads as open, the detector is wrong about what "closed" looks
  // like and every PASS above is worthless.
  {
    const { data, error } = await anon.rpc("mfa_enrolled_ids", {});
    check(
      "CONTROL: mfa_enrolled_ids(), shut in 20260915000100, still reads as shut",
      shutOut(error),
      describe(error, data)
    );
  }

  // CONTROL 2 — THE ONE THAT CAN FAIL. `dm_pair_key` is deliberately left
  // open: it is `security invoker` and `immutable`, a pure function of the two
  // uuids the caller already holds, touching no table. It is the proof that
  // this probe is reading privileges and not simply printing PASS — if a
  // refusal is what every function returns, a refusal means nothing.
  {
    const { data, error } = await anon.rpc("dm_pair_key", { a: NOBODY, b: NOBODY });
    check(
      "CONTROL: dm_pair_key() is still executable by anon, so a refusal above is a real finding",
      !shutOut(error) && typeof data === "string",
      describe(error, data)
    );
  }

  // CONTROL 3 — the over-reach control, and the reason this change is not
  // free: `revoke ... from anon` must take nothing away from a real session.
  // Every function above is called by a policy on behalf of a signed-in
  // person; if the revoke caught `authenticated` too, the app would refuse
  // its own users. (The live RLS suite is the wide version of this check.)
  const email = `definer-${stamp}@lumina.test`;
  const made = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (made.error) throw new Error(`createUser: ${made.error.message}`);
  const uid = made.user?.id ?? made.data.user.id;
  cleanup = () => svc.auth.admin.deleteUser(uid);
  must(
    "profile",
    await svc.from("profiles").upsert({
      id: uid, email, name: "definer probe", handle: `dp${stamp}`,
      title: "", role_id: "member", color: "#000000",
    })
  );

  const signedIn = createClient(URL, anonKey, { auth: { persistSession: false } });
  const session = await signedIn.auth.signInWithPassword({ email, password: pw });
  if (session.error) throw new Error(`signIn: ${session.error.message}`);

  for (const [fn, args] of SHUT) {
    const { error } = await signedIn.rpc(fn, args);
    check(`CONTROL: a signed-in member may still execute ${fn}()`, !shutOut(error), describe(error, "ok"));
  }
}

let threw = null;
try {
  await main();
} catch (e) {
  // Without this catch, an exception here would reach the `finally` below and
  // be swallowed by `process.exit` — the failure shape that once made a probe
  // report ALL PASSED while asserting nothing (tests/probes/README.md).
  threw = e;
  failures++;
  console.log(`*** FAIL ***  the probe threw before it finished  -> ${e.message}`);
} finally {
  if (cleanup) await cleanup().catch(() => {});
  if (checks === 0) {
    console.log("\n*** NO CHECKS RAN *** — a probe that asserts nothing is not a pass.");
    process.exit(1);
  }
  console.log(
    failures === 0
      ? `\nALL DEFINER PROBES PASSED (${checks} checks)`
      : `\n*** ${failures} DEFINER PROBE FAILURE(S) *** out of ${checks} checks`
  );
  process.exit(failures === 0 && !threw ? 0 : 1);
}
