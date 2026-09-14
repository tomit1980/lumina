// A stand-in for the Supabase browser client, covering exactly the calls
// lib/auth.tsx makes: password sign-in, sign-out, the auth-state listener,
// the `profiles` reads/writes behind `mfa_required`, and the native TOTP MFA
// surface (list/enroll/challenge/verify/unenroll).
//
// It is a fake, not a stub: factors really change status when a correct code
// is verified, `listFactors().totp` really only reports verified ones (the
// narrowing supabase-js does), sign-in really rejects a wrong password, and
// every state change really notifies the listener. That is what lets the
// tests distinguish "the second factor gated the login" from "the assertion
// never ran". Nothing here touches the network — tests/rls/ is where real
// credentials belong.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

export interface FakeProfile {
  id: string;
  handle: string;
  email: string;
  mfa_required: boolean;
  /** Set when an admin creates the account; only a real password change
   *  clears it, which here means `auth.updateUser({ password })`. */
  must_change_password?: boolean;
}

interface FakeFactor {
  id: string;
  factor_type: "totp";
  status: "verified" | "unverified";
}

export interface FakeSupabase {
  /** The typed client to hand to `AuthProvider`'s `client` prop. */
  client: SupabaseClient<Database>;
  profiles: FakeProfile[];
  factors: FakeFactor[];
  /** email -> password. */
  passwords: Record<string, string>;
  /** email -> auth uid. Deliberately separate from `profiles`: an auth user
   *  can exist with no profile row, which is a real failure mode (the
   *  runbook's troubleshooting section) the provider has to handle. */
  authUsers: Record<string, string>;
  /** The only TOTP code `verify` accepts. */
  validCode: string;
  session: { user: { id: string } } | null;
  /**
   * The session's assurance level, exactly as it governs `require_assurance`.
   *
   * "none" = signed out. `signInWithPassword` gives "aal1"; answering a factor
   * gives "aal2". This is not decoration: 20260910004000_require_assurance.sql
   * makes `profiles` UNREADABLE to an aal1 session whose account has a
   * verified factor, and a fake that ignored it let the login screen tell a
   * user with two-factor that they had no profile — for a day, with 768 green
   * tests, because the instrument could not express the failure.
   */
  assurance: "none" | "aal1" | "aal2";
  /** Every `signInWithPassword`, refused or not. */
  signInCalls: number;
  /** Every reset request, with the redirect the caller asked Supabase to bake
   *  into the email. */
  resetRequests: { email: string; redirectTo?: string }[];
  /** Make the next reset request fail with this message. */
  resetFailure: string | null;
  signOutCalls: number;
  enrollCalls: number;
  /** Every `profiles.update({mfa_required})` this client was asked to make. */
  requirementWrites: { id: string; mfa_required: boolean }[];
  /**
   * What `mfa_enrolled_ids()` answers — the ids of people with a verified
   * factor, as the database reports them to a `members.manage` holder.
   *
   * Deliberately separate from `factors`, which models `listFactors()` and is
   * the SIGNED-IN user's own factors only. Conflating the two would let the
   * provider pass a test by leaking your own enrolment onto everybody else,
   * which is the exact bug this function exists to avoid.
   */
  enrolledIds: string[];
  /** Model a caller without `members.manage`: the function returns no rows
   *  rather than raising, which is how every read in this schema refuses. */
  mfaEnrolledRefused: boolean;
  /** Every `rpc()` name this client was asked for, in order. */
  rpcCalls: string[];
  /** Every `auth.updateUser({ password })` this client was asked to make. */
  passwordUpdates: string[];
  /** Make the next password update fail, with this message. */
  passwordFailure: string | null;
  /** Make the next `profiles` update fail, as RLS would. */
  failRequirementWrites: boolean;
  /**
   * Make `mfa.enroll` fail with this message, as a project with TOTP
   * enrolment switched off does. Null means enrolment works.
   *
   * The real signal has never been seen: tests/rls/forced-enrolment.test.ts
   * found enrolment ENABLED on development, so there is no observed string to
   * copy. That is exactly why the code under test passes the server's message
   * through instead of matching on one - and why this knob takes the message
   * as a parameter rather than hard-coding a guess.
   */
  enrollFailure: string | null;
}

export function createFakeSupabase(options: {
  profiles: FakeProfile[];
  passwords: Record<string, string>;
  /** Pre-existing factors, e.g. a verified one to force the TOTP step. */
  factors?: FakeFactor[];
  /** Start already signed in as this user id (a persisted session). */
  signedInAs?: string;
  /**
   * Start as though the page was opened from a password-reset link.
   *
   * Reproduces both halves of what the real client does: the session already
   * exists by the time anything reads it (supabase-js consumes the fragment
   * while initialising, and `getSession()` awaits that), AND the fragment is
   * still on `window.location` when the provider first renders. A fake that
   * only emitted the event would let a provider pass that keys on the event
   * alone — which loses the race against the restore pass in the real client.
   */
  recovery?: { userId: string };
  /** email -> auth uid. Defaults to the profiles' own ids. */
  authUsers?: Record<string, string>;
}): FakeSupabase {
  type Listener = (event: string, session: { user: { id: string } } | null) => void;
  let listeners: Listener[] = [];

  const fake: FakeSupabase = {
    client: null as unknown as SupabaseClient<Database>,
    profiles: options.profiles,
    passwords: options.passwords,
    authUsers:
      options.authUsers ??
      Object.fromEntries(options.profiles.map((p) => [p.email, p.id])),
    factors: options.factors ?? [],
    validCode: "123456",
    session:
      options.recovery
        ? { user: { id: options.recovery.userId } }
        : options.signedInAs
          ? { user: { id: options.signedInAs } }
          : null,
    assurance: "none",
    signInCalls: 0,
    resetRequests: [],
    resetFailure: null,
    signOutCalls: 0,
    enrollCalls: 0,
    requirementWrites: [],
    enrolledIds: [],
    mfaEnrolledRefused: false,
    rpcCalls: [],
    passwordUpdates: [],
    passwordFailure: null,
    failRequirementWrites: false,
    enrollFailure: null,
  };

  if (options.recovery && typeof window !== "undefined") {
    window.location.hash =
      "#access_token=fake-access&refresh_token=fake-refresh&expires_in=3600" +
      "&token_type=bearer&type=recovery";
    fake.assurance = "aal1";
  }

  let nextFactor = fake.factors.length + 1;
  const emit = (event: string) => {
    for (const listener of [...listeners]) listener(event, fake.session);
  };

  const auth = {
    getSession: async () => ({ data: { session: fake.session }, error: null }),

    onAuthStateChange: (callback: Listener) => {
      listeners.push(callback);
      // supabase-js delivers INITIAL_SESSION just after subscribing, which is
      // exactly the race the provider's `initialised` guard exists for.
      setTimeout(() => {
      callback("INITIAL_SESSION", fake.session);
      if (options.recovery) callback("PASSWORD_RECOVERY", fake.session);
    }, 0);
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              listeners = listeners.filter((l) => l !== callback);
            },
          },
        },
      };
    },

    signInWithPassword: async ({
      email,
      password,
    }: {
      email: string;
      password: string;
    }) => {
      // Counted before the outcome is known: a test asserting a check ran
      // "before the round trip" needs to know the trip was never taken, and a
      // refused trip is still a trip.
      fake.signInCalls += 1;
      const uid = fake.authUsers[email];
      if (!uid || fake.passwords[email] !== password) {
        return {
          data: { user: null, session: null },
          error: { message: "Invalid login credentials" },
        };
      }
      fake.session = { user: { id: uid } };
      fake.assurance = "aal1";
      emit("SIGNED_IN");
      return {
        data: { user: { id: uid }, session: fake.session },
        error: null,
      };
    },

    // Stands in for GoTrue plus the users_clear_password_flag trigger: in the
    // real system the browser never writes must_change_password, a trigger on
    // auth.users clears it when encrypted_password actually moves. Modelling
    // it here rather than letting the test clear the flag keeps the fake
    // honest about who owns that write.
    updateUser: async ({ password }: { password?: string }) => {
      if (fake.passwordFailure) {
        return { data: { user: null }, error: { message: fake.passwordFailure } };
      }
      if (typeof password === "string") {
        fake.passwordUpdates.push(password);
        const uid = fake.session?.user.id;
        const profile = fake.profiles.find((p) => p.id === uid);
        if (profile) {
          profile.must_change_password = false;
          const email = profile.email;
          if (email in fake.passwords) fake.passwords[email] = password;
        }
      }
      return { data: { user: fake.session?.user ?? null }, error: null };
    },

    /**
     * Requesting a reset.
     *
     * SUCCEEDS FOR AN ADDRESS WITH NO ACCOUNT, because that is what Supabase
     * does — answering differently would make the form an account-enumeration
     * oracle. A fake that distinguished would let a screen with exactly that
     * leak pass its tests, which is the one thing this method exists to stop.
     */
    resetPasswordForEmail: async (email: string, opts?: { redirectTo?: string }) => {
      if (fake.resetFailure) {
        return { data: null, error: { message: fake.resetFailure } };
      }
      fake.resetRequests.push({ email, redirectTo: opts?.redirectTo });
      return { data: {}, error: null };
    },

    signOut: async () => {
      fake.signOutCalls += 1;
      fake.session = null;
      fake.assurance = "none";
      emit("SIGNED_OUT");
      return { error: null };
    },

    mfa: {
      listFactors: async () => {
        const all = fake.session ? fake.factors : [];
        return {
          data: {
            all,
            totp: all.filter((f) => f.status === "verified"),
            phone: [],
          },
          error: null,
        };
      },

      enroll: async () => {
        fake.enrollCalls += 1;
        if (fake.enrollFailure) {
          return { data: null, error: { message: fake.enrollFailure } };
        }
        const id = `factor-${nextFactor++}`;
        fake.factors.push({ id, factor_type: "totp", status: "unverified" });
        return {
          data: {
            id,
            type: "totp",
            totp: {
              qr_code: "data:image/svg+xml;utf8,<svg/>",
              secret: "JBSWY3DPEHPK3PXP",
              uri: "otpauth://totp/Lumina:someone?secret=JBSWY3DPEHPK3PXP",
            },
          },
          error: null,
        };
      },

      challenge: async ({ factorId }: { factorId: string }) =>
        fake.factors.some((f) => f.id === factorId)
          ? { data: { id: "challenge-1", type: "totp", expires_at: 0 }, error: null }
          : { data: null, error: { message: "Factor not found" } },

      verify: async ({ factorId, code }: { factorId: string; code: string }) => {
        const factor = fake.factors.find((f) => f.id === factorId);
        if (!factor) return { data: null, error: { message: "Factor not found" } };
        if (code !== fake.validCode) {
          return { data: null, error: { message: "Invalid TOTP code entered" } };
        }
        factor.status = "verified";
        // Answering the factor is what raises the session, and therefore what
        // makes profiles readable again.
        fake.assurance = "aal2";
        return { data: { access_token: "token" }, error: null };
      },

      unenroll: async ({ factorId }: { factorId: string }) => {
        fake.factors = fake.factors.filter((f) => f.id !== factorId);
        return { data: { id: factorId }, error: null };
      },
    },
  };

  /**
   * `session_is_assured()` from 20260910004000_require_assurance.sql:
   * aal2, OR the account has no verified factor. Note what that means for an
   * aal1 session that DOES have one — it reads nothing at all.
   */
  const assured = () => {
    if (fake.assurance === "none") return true;
    if (fake.assurance === "aal2") return true;
    return !fake.factors.some((f) => f.status === "verified");
  };

  // Table and column arguments are accepted and ignored: this fake serves
  // only `profiles`, and the provider only ever selects from it.
  const from = () => ({
    select: () => {
      // `require_assurance`, modelled rather than assumed. A restrictive RLS
      // policy FILTERS: no error, no rows. So an unassured read looks exactly
      // like an account with no profile, which is precisely how this failure
      // presented itself in production.
      const rows = assured() ? fake.profiles.map((p) => ({ ...p })) : [];
      // Awaitable on its own (the mfa_required map) *and* chainable into
      // .eq().maybeSingle() (a single profile) — both shapes the client uses.
      return Object.assign(Promise.resolve({ data: rows, error: null }), {
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => ({
            data: rows.find((r) => r.id === value) ?? null,
            error: null,
          }),
        }),
      });
    },
    update: (patch: { mfa_required: boolean }) => ({
      eq: async (_column: string, value: string) => {
        if (fake.failRequirementWrites) {
          return { error: { message: "new row violates row-level security policy" } };
        }
        const profile = fake.profiles.find((p) => p.id === value);
        if (profile) profile.mfa_required = patch.mfa_required;
        fake.requirementWrites.push({ id: value, mfa_required: patch.mfa_required });
        return { error: null };
      },
    }),
  });

  /**
   * `mfa_enrolled_ids()` from 20260915000100_mfa_enrolled.sql.
   *
   * The `assured()` gate applies here too: the function is `security definer`
   * so no policy filters it, but an unassured session cannot get far enough to
   * ask — and modelling it keeps this fake honest about the one failure that
   * has actually bitten (an aal1 session reading nothing and looking like an
   * empty workspace).
   */
  const rpc = async (name: string) => {
    fake.rpcCalls.push(name);
    if (name !== "mfa_enrolled_ids") return { data: null, error: null };
    if (fake.mfaEnrolledRefused || !assured()) return { data: [], error: null };
    return { data: fake.enrolledIds.map((user_id) => ({ user_id })), error: null };
  };

  // The one cast, and it is on the test's own object: production code stays
  // typed against the real `SupabaseClient<Database>`.
  fake.client = { auth, from, rpc } as unknown as SupabaseClient<Database>;
  return fake;
}
