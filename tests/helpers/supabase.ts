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

// Memoised by email, module-scoped. Supabase rate-limits signInWithPassword
// per project across the whole `npm run test:rls` run, and several
// pre-existing suites were re-authenticating the same handful of identities
// on every single assertion — that's what was crossing the threshold, not
// the number of distinct fixture users.
//
// Safe to cache the session rather than the account: has_permission() (see
// supabase/migrations/20260906000100_identity.sql) reads role and
// permissions from the profiles/roles tables live via auth.uid() on every
// request — nothing is baked into the JWT — so a session cached before a
// role or membership change stays exactly as valid a probe as a fresh one
// afterwards. tests/rls/attachments.test.ts's revocation tests confirm this
// empirically: they hold a client cached before a project_members /
// channel_members row is deleted, then reuse it afterwards, and the policy
// still denies correctly.
//
// Safe with respect to user lifecycle too: no test in this suite deletes a
// user and later signs back in as that same email address, so this cache
// never hands back a session for an identity that no longer exists.
//
// This cache is per test FILE, not per process: vitest.rls.config.ts uses
// pool "forks" with the default isolate: true, so vitest resets the module
// registry between test files even when they share a worker process, and
// each file gets its own fresh copy of this module (and this Map). That is
// fine — every RLS file mints its own timestamped emails, so there is no
// cross-file cache hit to lose; this only dedupes repeat sign-ins *within*
// one file, which is where the call volume was.
//
// `fresh: true` is an escape hatch for a future test that genuinely needs a
// new token for an existing email (e.g. re-authenticating after a password
// change) — nothing in the current suite exercises that path, since the
// permission model above never requires it.
const signInCache = new Map<string, SupabaseClient<Database>>();

// Debug-only counter for measuring the before/after sign-in volume. Reset it
// with resetSignInCount(); it has no effect on behaviour. Set
// RLS_DEBUG_SIGNIN_COUNT to have each test file (they run in isolated
// processes, so this fires once per file) report its own total on exit.
let signInCount = 0;
export function getSignInCount(): number {
  return signInCount;
}
export function resetSignInCount(): void {
  signInCount = 0;
}

function isRateLimitError(message: string): boolean {
  return /rate limit/i.test(message);
}

/**
 * A client authenticated as one user, memoised by email so repeat calls in
 * the same test file reuse one session instead of re-authenticating (see
 * the cache comment above for why that is safe here). Retries with backoff
 * specifically on Supabase's sign-in rate-limit error — never on any other
 * failure — so a cold-start burst across the suite's forked test files
 * cannot fail the run on its own.
 */
export async function signInAs(
  email: string,
  password: string,
  opts: { fresh?: boolean } = {}
): Promise<SupabaseClient<Database>> {
  if (!opts.fresh) {
    const cached = signInCache.get(email);
    if (cached) return cached;
  }

  const maxAttempts = 5;
  let lastMessage = "unknown error";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const client = anonClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (!error) {
      signInCount++;
      if (process.env.RLS_DEBUG_SIGNIN_COUNT) {
        console.log(`[signInAs] network sign-in #${signInCount} in this file: ${email}`);
      }
      if (!opts.fresh) signInCache.set(email, client);
      return client;
    }
    lastMessage = error.message;
    if (!isRateLimitError(lastMessage)) {
      throw new Error(`signInAs(${email}) failed: ${lastMessage}`);
    }
    // Rate limiting is a shared, per-project budget every RLS file draws
    // from concurrently — a 429 here says nothing about policy correctness.
    // Back off and retry rather than failing the run on it.
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw new Error(`signInAs(${email}) failed after ${maxAttempts} attempts: ${lastMessage}`);
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
