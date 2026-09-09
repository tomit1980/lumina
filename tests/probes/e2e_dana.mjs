// Acts as the second person for the two-browser pass: signs in as Dana and
// does one thing, so the first browser can be watched for a live update.
//
//   node tests/probes/e2e_dana.mjs post "hello"   — post to #general
//   node tests/probes/e2e_dana.mjs presence 45    — hold a presence channel N seconds
//   node tests/probes/e2e_dana.mjs react <msgId>  — toggle a reaction
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.test.local", quiet: true });

const URL = process.env.SUPABASE_URL;
if (URL.includes("eshstdmgceohizbevwll")) {
  console.log("REFUSING: that is the production project.");
  process.exit(1);
}

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
  const channel = c.channel("lumina-presence", {
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
  console.log(`Dana present for ${seconds}s (user ${me})`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await channel.untrack();
  await c.removeChannel(channel);
  console.log("Dana left");
} else if (action === "react") {
  const { error: err } = await c.rpc("toggle_reaction", {
    p_message_id: arg,
    p_emoji: "🎉",
  });
  if (err) throw new Error(`toggle_reaction: ${err.message}`);
  console.log(`reacted to ${arg}`);
} else {
  console.log("usage: post <text> | presence <seconds> | react <messageId>");
  process.exit(1);
}
