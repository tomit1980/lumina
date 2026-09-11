// Create a teammate's account, from inside the app.
//
// An admin types an email, a password and a role; the account exists
// immediately and that person can sign in straight away. No email is sent and
// none is needed — which also means this does not depend on Supabase's shared
// mail service, whose free-tier cap is a handful of messages an hour.
//
// (An earlier version of this invited by email instead. It was the wrong
// choice for a two-person workspace: it added a dependency that rate-limits,
// and it made adding somebody a thing you wait for rather than a thing you
// do.)
//
// WHY THIS IS NOT IN THE BROWSER. Creating an account needs the service-role
// key, which bypasses every row-level policy in the database. A static export
// cannot hold it: anything the bundle has, its reader has, and the bundle is
// served from a public URL. So this runs server-side and is called with the
// signed-in user's token.
//
// IT DOES NOT TRUST ITS CALLER. The Members screen only shows the button to
// someone with `members.manage`, but anyone can POST here with any token, so
// every rule is re-derived from the caller's own profile:
//
//   1. the token must resolve to a real user;
//   2. that user must hold `members.manage`;
//   3. the role being handed out must not outrank the caller's own.
//
// Rule 3 is the rank rule from 20260910006000_owner_role.sql, applied BEFORE
// the account exists rather than after — so an admin trying to mint an Owner
// gets a sentence instead of a half-created account and a constraint error.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    return reply(500, { error: "The create-user function is not configured." });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply(401, { error: "Sign in first." });

  // 1. Who is calling? Taken from the token, never from the body.
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) {
    return reply(401, { error: "That session is no longer valid." });
  }

  let body: { email?: unknown; password?: unknown; roleId?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Expected a JSON body." });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const roleId = typeof body.roleId === "string" ? body.roleId : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!email || !email.includes("@")) return reply(400, { error: "Give a valid email address." });
  // Supabase's own floor is 6. Saying so here means the person gets the rule
  // before the round trip rather than a raw API message after it.
  if (password.length < 8) {
    return reply(400, { error: "Use a password of at least 8 characters." });
  }
  if (!roleId) return reply(400, { error: "Choose a role." });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 2. and 3. The caller's own role answers both.
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, roles!inner(id, rank, permissions)")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError) return reply(500, { error: "Couldn't read your role." });
  if (!profile) return reply(403, { error: "This account has no Lumina profile." });

  const callerRole = profile.roles as unknown as {
    id: string;
    rank: number;
    permissions: string[];
  };
  if (!callerRole.permissions.includes("members.manage")) {
    return reply(403, { error: "Your role can't add people." });
  }

  const { data: target, error: targetError } = await admin
    .from("roles").select("id, rank, name").eq("id", roleId).maybeSingle();
  if (targetError) return reply(500, { error: "Couldn't read that role." });
  if (!target) return reply(400, { error: "That role doesn't exist." });
  if (target.rank > callerRole.rank) {
    return reply(403, { error: `You can't add someone as ${target.name}.` });
  }

  // 4. Create, confirmed. `email_confirm: true` matters more than it looks:
  //    an unconfirmed account cannot sign in, and fails with no useful error —
  //    the exact trap docs/runbooks/creating-a-user.md warns about when doing
  //    this by hand in the dashboard.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    const already = (createError?.message ?? "").toLowerCase().includes("already");
    return reply(already ? 409 : 500, {
      error: already
        ? "Someone with that address is already in the workspace."
        : `Couldn't create the account: ${createError?.message ?? "unknown error"}`,
    });
  }

  // The `handle_new_user` trigger makes the profile as a Member. Set the role
  // that was actually asked for — and the display name, if one was given.
  // Retried briefly: the trigger is AFTER INSERT, so the row is normally
  // there, and "normally" is not "always". An account silently landing on the
  // wrong role would look like a permissions bug weeks later.
  // `must_change_password` is set here and never cleared from the browser: a
  // trigger on auth.users takes it off when the password actually changes
  // (20260911000100_must_change_password.sql). The password an admin types
  // above has been spoken aloud or pasted into a chat window and the admin
  // knows it, so it is a delivery mechanism rather than a credential, and it
  // should stop working the moment the person is in.
  const patch: Record<string, string | boolean> = {
    role_id: roleId,
    must_change_password: true,
  };
  if (name) patch.name = name;

  let assigned = false;
  for (let attempt = 0; attempt < 5 && !assigned; attempt++) {
    const { data: updated } = await admin
      .from("profiles").update(patch).eq("id", created.user.id).select("id");
    assigned = (updated ?? []).length > 0;
    if (!assigned) await new Promise((r) => setTimeout(r, 200));
  }
  if (!assigned) {
    return reply(207, {
      error:
        "The account was created, but the role could not be set — they are a Member for now. Change it from the Members screen.",
      userId: created.user.id,
    });
  }

  return reply(200, { userId: created.user.id, email, roleId });
});
