// The browser client's auth options — the three booleans that decide whether
// somebody can get back into their own account.
//
// WHY THIS FILE EXISTS. `detectSessionInUrl` was `false`, with a comment
// explaining that a static export has no redirect flow and so never has a
// session in the URL. That was true when it was written and quietly stopped
// being true the day the workspace needed a way in for someone who had
// forgotten their password.
//
// The failure mode is the reason a test guards a boolean at all: a magic link
// arrives with a real session in the URL fragment, supabase-js reads the
// fragment, discards it because it was told to, and the app renders the login
// screen. No error, no console message, no network failure — every visible
// signal says "that link didn't work", and none of them says why. It cost an
// afternoon on the first day in production, and it would have cost the same
// again the first time a teammate locked themselves out.
//
// So the assertion here is not "this boolean is true" for its own sake. It is
// that the recovery path the workspace depends on is not switched off by a
// setting nobody looks at.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `lib/supabase.ts` throws at import time without credentials — deliberately,
 * so a real deployment fails loudly rather than shipping a client pointed at
 * nothing. The test supplies throwaway values and imports it fresh.
 */
async function loadAuthOptions() {
  const mod = await import("@/lib/supabase");
  return mod.AUTH_OPTIONS;
}

beforeEach(() => {
  // Without this the second import returns the cached module and never
  // re-reads the environment — which would make the control below pass by
  // never running the code it claims to test.
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_test_key_value";
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

describe("the browser client's auth options", () => {
  it("reads a session out of the URL, so magic and recovery links work", async () => {
    const options = await loadAuthOptions();

    expect(options.detectSessionInUrl).toBe(true);
  });

  it("keeps the session across reloads and refreshes it before it expires", async () => {
    // The other two halves of staying signed in. Without persistence every
    // reload is a fresh login; without refresh the session dies mid-session
    // and looks like a random sign-out.
    const options = await loadAuthOptions();

    expect(options.persistSession).toBe(true);
    expect(options.autoRefreshToken).toBe(true);
  });

  it("CONTROL: refuses to build a client with no credentials at all", async () => {
    // Without this, the assertions above would pass just as happily against a
    // module that had stopped validating anything — and a build pointed at
    // nowhere is the failure that put a dead page on the public URL earlier
    // the same day.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    await expect(import("@/lib/supabase")).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
