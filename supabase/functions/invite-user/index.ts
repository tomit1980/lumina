// Invite a teammate, from inside the app.
//
// WHY THIS IS NOT IN THE BROWSER. Creating an account needs the service-role
// key, which bypasses every row-level policy in the database. A static export
// cannot hold it: anything the browser has, its user has, and the bundle is
// served from a public URL. So this runs server-side, holds the key in its own
// environment, and is called with the signed-in user's token.
//
// IT DOES NOT TRUST ITS CALLER. The Members screen only shows the invite
// button to someone with `members.manage`, but a UI check is a suggestion —
// anyone can call this endpoint directly with any token. Every rule is
// re-derived here from the caller's own profile:
//
//   1. the token must resolve to a real user;
//   2. that user must hold `members.manage`;
//   3. the role being handed out must not outrank the caller's own.
//
// Rule 3 is the rank rule from 20260910006000_owner_role.sql, applied BEFORE
// the account exists rather than after. The database enforces it on the
// profile UPDATE too, so this is defence in depth rather than the only guard —
// but doing it first means an admin who tries to mint an Owner gets a sentence
// instead of a half-created account and a constraint error.
//
// INVITE, NOT CREATE-WITH-PASSWORD. The new person sets their own password
// from the email link, so nobody handles anyone else's credential and there is
// nothing to transmit. It also sidesteps the "Auto Confirm User" trap that the
// runbook warns about: an accepted invite is confirmed by definition, and an
// unconfirmed account cannot sign in — silently, with no useful error.
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
    // Fail loudly rather than half-working: a function missing its service key
    // would refuse every invite and look like a permission bug.
    return reply(500, { error: "The invite function is not configured." });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return reply(401, { error: "Sign in first." });
  }

  // 1. Who is calling? Resolved from the token itself, not from the body.
  //    A client created with the ANON key plus the caller's header can only
  //    see what that caller may see — it cannot be talked into more.
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) {
    return reply(401, { error: "That session is no longer valid." });
  }

  let body: { email?: unknown; roleId?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Expected a JSON body." });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const roleId = typeof body.roleId === "string" ? body.roleId : "";
  if (!email || !email.includes("@")) return reply(400, { error: "Give a valid email address." });
  if (!roleId) return reply(400, { error: "Choose a role." });

  // The service client: everything below reads and writes as the database
  // owner, so every decision it makes has already been checked above.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 2. and 3. The caller's own role decides both questions.
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
    return reply(403, { error: "Your role can't invite people." });
  }

  const { data: target, error: targetError } = await admin
    .from("roles")
    .select("id, rank, name")
    .eq("id", roleId)
    .maybeSingle();
  if (targetError) return reply(500, { error: "Couldn't read that role." });
  if (!target) return reply(400, { error: "That role doesn't exist." });

  if (target.rank > callerRole.rank) {
    return reply(403, { error: `You can't invite someone as ${target.name}.` });
  }

  // 4. Invite. The trigger on auth.users creates the profile as a Member;
  //    the role is set immediately afterwards.
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email);
  if (inviteError || !invited.user) {
    // The common case by far is "already registered", and saying so is more
    // use than a generic failure.
    const already = (inviteError?.message ?? "").toLowerCase().includes("already");
    return reply(already ? 409 : 500, {
      error: already
        ? "Someone with that address is already in the workspace."
        : `Couldn't send the invitation: ${inviteError?.message ?? "unknown error"}`,
    });
  }

  // The profile is created by an AFTER INSERT trigger, so it is normally there
  // by the time the call returns — but "normally" is not "always", and an
  // invitation that silently landed on the wrong role would be worse than a
  // failed one. Retry briefly, then say plainly what happened.
  let assigned = false;
  for (let attempt = 0; attempt < 5 && !assigned; attempt++) {
    const { data: updated } = await admin
      .from("profiles")
      .update({ role_id: roleId })
      .eq("id", invited.user.id)
      .select("id");
    assigned = (updated ?? []).length > 0;
    if (!assigned) await new Promise((r) => setTimeout(r, 200));
  }
  if (!assigned) {
    return reply(207, {
      error:
        "The invitation was sent, but the role could not be set. They will join as a Member — change it from the Members screen once they accept.",
      userId: invited.user.id,
    });
  }

  return reply(200, { userId: invited.user.id, email, roleId });
});
