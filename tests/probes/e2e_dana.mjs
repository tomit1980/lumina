// Acts as the second person for the two-browser pass: signs in as Dana and
// does one thing, so the first browser can be watched for a live update.
//
//   node tests/probes/e2e_dana.mjs post "hello"   — post to #general
//   node tests/probes/e2e_dana.mjs clean           — remove every message it posted
//   node tests/probes/e2e_dana.mjs react <msgId>  — toggle a reaction
//
//   node tests/probes/e2e_dana.mjs presence 45    — hold a presence channel N seconds
//
// WARNING: `post` writes a REAL row into c_general, and
// tests/rls/store-swap.test.ts asserts that channel is empty. Always run
// `clean` before the access suite, or that test fails on a stale row from a
// browser pass — which looks like a regression and is not one.
import { createClient } from "@supabase/supabase-js";

// Loads the env file and decides dev-vs-production. See ./_target.mjs.
import "./_target.mjs";

const URL = process.env.SUPABASE_URL;

const c = createClient(URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: session, error } = await c.auth.signInWithPassword({
  email: "dana@lumina.test",
  password: "e2e-password-4417",
});
if (error) throw new Error(`sign-in: ${error.message}`);
const me = session.user.id;

const [action, arg] = process.argv.slice(2);

if (action === "post") {
  const id = `m_dana_${Date.now()}`;
  const { error: err } = await c.from("messages").insert({
    id,
    conversation_id: "c_general",
    author_id: me,
    content: arg ?? "from Dana",
  });
  if (err) throw new Error(`insert: ${err.message}`);
  console.log(`posted ${id}: ${arg ?? "from Dana"}`);
} else if (action === "presence") {
  const seconds = Number(arg ?? 30);
  // The app's topic, and it has to be exactly this. Presence is scoped to a
  // topic: a helper tracking on any other name is invisible to the app, so a
  // manual presence check with it can neither light a dot nor prove one is
  // missing. It said "lumina-presence" until the final review caught it —
  // keep this in step with `TOPIC` in lib/backend/supabase/realtime.ts.
  const TOPIC = "workspace-changes";
  // The socket carries a token of its own, set separately from the REST one;
  // sign-in pushes it, but say so explicitly rather than relying on the order.
  await c.realtime.setAuth(session.session.access_token);
  const channel = c.channel(TOPIC, {
    config: { presence: { key: me } },
  });
  await new Promise((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(status));
    });
    setTimeout(() => reject(new Error("never subscribed")), 10_000);
  });
  await channel.track({ user_id: me });
  console.log(`Dana present for ${seconds}s on "${TOPIC}" (user ${me})`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await channel.untrack();
  await c.removeChannel(channel);
  console.log("Dana left");
} else if (action === "clean") {
  const { data, error: err } = await c
    .from("messages")
    .delete()
    .like("id", "m_dana_%")
    .eq("conversation_id", "c_general")
    .select("id");
  if (err) throw new Error(`clean: ${err.message}`);
  console.log(`removed ${(data ?? []).length} message(s)`);
} else if (action === "react") {
  const { error: err } = await c.rpc("toggle_reaction", {
    p_message_id: arg,
    p_emoji: "🎉",
  });
  if (err) throw new Error(`toggle_reaction: ${err.message}`);
  console.log(`reacted to ${arg}`);
} else {
  console.log("usage: post <text> | clean | presence <seconds> | react <messageId>");
  process.exit(1);
}
