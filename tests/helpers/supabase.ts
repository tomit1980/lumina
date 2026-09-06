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

  const profile = await serviceClient.from("profiles").upsert({
    id: data.user.id,
    email: opts.email,
    name: opts.name,
    handle: opts.handle,
    title: "Test User",
    role_id: opts.roleId,
    color: "#7c3aed",
  } as never);
  // Tolerated only before the identity migration creates the table.
  if (profile.error && !/relation .* does not exist/.test(profile.error.message)) {
    throw new Error(`createTestUser profile insert failed: ${profile.error.message}`);
  }
  return data.user.id;
}

export async function deleteTestUser(userId: string): Promise<void> {
  await serviceClient.auth.admin.deleteUser(userId);
}
