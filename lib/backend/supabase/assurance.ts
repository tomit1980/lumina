/**
 * Is this client's session one the app may act on yet?
 *
 * `signInWithPassword` succeeds BEFORE the TOTP step, and the session it
 * issues at that moment is a real one: a real access token, accepted by
 * PostgREST and by the realtime socket. Its only distinguishing mark is the
 * `aal` claim — `aal1`, "password only" — against an account whose *next*
 * level is `aal2` because it has a verified factor waiting to be answered.
 *
 * `lib/auth.tsx` already holds that session back from React (`gated`), so the
 * login screen stays up. But nothing below React knew about it: the realtime
 * module subscribes to `client.auth.onAuthStateChange` directly (by design —
 * see the banner in ./realtime.ts), so an aal1 `SIGNED_IN` drove a join, an
 * `online: true`, and the whole-workspace hydrate that a connection
 * transition costs. The app fetched every message, project, task and DM the
 * account may see for somebody who had not answered their second factor.
 *
 * This is the client half of that fix, and it is deliberately ONE predicate
 * in ONE place: every caller that would otherwise treat a session as usable
 * asks here first. The server half — an RLS policy that refuses aal1 for an
 * account with a verified factor — lives in
 * `supabase/migrations/20260910004000_require_assurance.sql`, because a
 * client-side check is a convenience and never an access control: anyone
 * holding the aal1 token can call PostgREST by hand.
 *
 * ASSURED, precisely:
 *
 * - no session at all — nothing to assure, and the callers already have their
 *   own signed-out handling (an empty shell, an anon channel);
 * - `aal2` — the second factor has been answered;
 * - `aal1` on an account with **no verified factor at all** — the
 *   overwhelming majority of accounts, including every one the RLS suite
 *   signs in as. There is no second step for them to be waiting on, so
 *   holding them back would lock out almost everybody. supabase-js reports
 *   exactly this as `currentLevel === nextLevel`.
 *
 * Only the one shape — `current=aal1, next=aal2` — is refused.
 *
 * FAILING OPEN is deliberate on the error paths below. This predicate cannot
 * grant access (RLS does that) and cannot be the only thing standing between
 * an attacker and the data; what it can do, if it threw or answered "no" on a
 * client that does not implement the MFA API, is lock every user out of a
 * working app. A test double without `auth.mfa`, an older client, a thrown
 * network error: all read as assured, and the policy still refuses the one
 * session that matters.
 */
import type { LuminaClient } from "./client";

/** The MFA surface this file uses, narrowed to what it actually calls so a
 *  client that predates it (or a test double that never modelled it) is a
 *  missing property rather than a crash. */
type AssuranceApi = {
  getAuthenticatorAssuranceLevel?: () => Promise<{
    data: { currentLevel: string | null; nextLevel: string | null } | null;
    error: unknown;
  }>;
};

export async function sessionIsAssured(client: LuminaClient): Promise<boolean> {
  const mfa: AssuranceApi | undefined = client.auth?.mfa;
  if (typeof mfa?.getAuthenticatorAssuranceLevel !== "function") return true;
  try {
    const { data, error } = await mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return true;
    // `currentLevel` is null when there is no session; nothing to hold back.
    if (!data.currentLevel) return true;
    return !(data.currentLevel === "aal1" && data.nextLevel === "aal2");
  } catch {
    return true;
  }
}
