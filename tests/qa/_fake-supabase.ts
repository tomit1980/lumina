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
  signOutCalls: number;
  enrollCalls: number;
  /** Every `profiles.update({mfa_required})` this client was asked to make. */
  requirementWrites: { id: string; mfa_required: boolean }[];
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
    session: options.signedInAs ? { user: { id: options.signedInAs } } : null,
    signOutCalls: 0,
    enrollCalls: 0,
    requirementWrites: [],
    passwordUpdates: [],
    passwordFailure: null,
    failRequirementWrites: false,
    enrollFailure: null,
  };

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
      setTimeout(() => callback("INITIAL_SESSION", fake.session), 0);
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
      const uid = fake.authUsers[email];
      if (!uid || fake.passwords[email] !== password) {
        return {
          data: { user: null, session: null },
          error: { message: "Invalid login credentials" },
        };
      }
      fake.session = { user: { id: uid } };
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

    signOut: async () => {
      fake.signOutCalls += 1;
      fake.session = null;
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
        return { data: { access_token: "token" }, error: null };
      },

      unenroll: async ({ factorId }: { factorId: string }) => {
        fake.factors = fake.factors.filter((f) => f.id !== factorId);
        return { data: { id: factorId }, error: null };
      },
    },
  };

  // Table and column arguments are accepted and ignored: this fake serves
  // only `profiles`, and the provider only ever selects from it.
  const from = () => ({
    select: () => {
      const rows = fake.profiles.map((p) => ({ ...p }));
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

  // The one cast, and it is on the test's own object: production code stays
  // typed against the real `SupabaseClient<Database>`.
  fake.client = { auth, from } as unknown as SupabaseClient<Database>;
  return fake;
}
