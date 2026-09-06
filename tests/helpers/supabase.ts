import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_ANON_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  throw new Error(
    "Missing Supabase test credentials. Copy .env.example to .env.test.local and fill in the lumina-dev values."
  );
}

export const TEST_PASSWORD = "test-password-9f3a2b";

/**
 * Bypasses every RLS policy — this is the secret key. Use it only to seed
 * fixtures and clean up. Never assert authorisation with it: a test that
 * passes under this client proves nothing about what a real user can do.
 */
export const serviceClient = createClient<Database>(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** A fresh signed-out client, subject to RLS as the anonymous role. */
export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A client authenticated as one user. Each call builds its own client so a
 * test can hold several identities at once and compare what each can see.
 */
export async function signInAs(
  email: string,
  password: string
): Promise<SupabaseClient<Database>> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInAs(${email}) failed: ${error.message}`);
  return client;
}

export async function createTestUser(opts: {
  email: string;
  password: string;
  name: string;
  handle: string;
  roleId: string;
}): Promise<string> {
  const { data, error } = await serviceClient.auth.admin.createUser({
    email: opts.email,
    password: opts.password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createTestUser failed: ${error?.message}`);

  // Deliberately untyped: this helper runs both before and after the identity
  // migration exists. Until it is pushed, `profiles` is absent from the
  // generated Database type and a typed .from("profiles") will not compile.
  // The insert below is checked at runtime by the tolerance right after it.
  const bootstrap = serviceClient as unknown as SupabaseClient;
  const profile = await bootstrap.from("profiles").upsert({
    id: data.user.id,
    email: opts.email,
    name: opts.name,
    handle: opts.handle,
    title: "Test User",
    role_id: opts.roleId,
    color: "#7c3aed",
  });
  // Tolerated only before the identity migration creates the table. PostgREST
  // reports a missing table as PGRST205 ("Could not find the table ... in the
  // schema cache"), not as Postgres's own "relation does not exist" — match the
  // code, since the prose has changed between PostgREST versions.
  const tableMissing =
    profile.error?.code === "PGRST205" ||
    /does not exist|schema cache/i.test(profile.error?.message ?? "");
  if (profile.error && !tableMissing) {
    // The auth user already exists at this point. Remove it before throwing,
    // or every failed run leaves an orphan behind that no afterAll can reach.
    await deleteTestUser(data.user.id);
    throw new Error(
      `createTestUser profile insert failed (${profile.error.code}): ${profile.error.message}`
    );
  }
  return data.user.id;
}

export async function deleteTestUser(userId: string): Promise<void> {
  await serviceClient.auth.admin.deleteUser(userId);
}
