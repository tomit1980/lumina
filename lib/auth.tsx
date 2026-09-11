"use client";

/**
 * Authentication, in two implementations behind one context.
 *
 * `backendKind` (lib/backend/index.ts) picks which one mounts:
 *
 * - **local** — the browser-only demo the public GitHub Pages build ships.
 *   Any seeded handle plus `DEMO_PASSWORD` signs you in. There is no
 *   cryptography here at all any more: `lib/crypto.ts` (PBKDF2 password
 *   hashing, hand-rolled RFC-6238 TOTP, an AES-GCM "vault" whose key shipped
 *   in the bundle) is deleted, and with it the demo's two-factor. See the
 *   note on `twoFactorStatus` below.
 * - **supabase** — real accounts. `signInWithPassword` / `signOut` /
 *   `onAuthStateChange`, and genuine server-side two-factor through
 *   Supabase's native TOTP MFA.
 *
 * Both satisfy the same `AuthValue`, so `components/auth/login-screen.tsx`
 * and its three-step machine are shared. The demo-only members of that shape
 * (`requestSwitch`, `pendingSwitch`, `submitSwitchTotp`, `cancelSwitch`,
 * `resetAll`) are inert no-ops under the Supabase flag *and* not rendered by
 * any caller there — see components/app-shell.tsx, components/command-palette.tsx
 * and components/providers.tsx. The Phase 3 cutover deletes them outright.
 */

import * as React from "react";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";

import { backendKind } from "./backend";
import { generateTotpSecret, totpAuthUri, verifyTotp } from "./totp";
import type { Database } from "./database.types";
import { createSeed } from "./seed";

const SESSION_KEY = "lumina:session";
/** The credential blob the deleted `lib/crypto.ts` used to encrypt. Nothing
 *  reads it any more; it is removed on sign-out so stale copies don't linger
 *  in browsers that ran an older build. */
const LEGACY_AUTH_KEY = "lumina:auth";
const WORKSPACE = "Lumina";

/** Demo password for every seeded account (surfaced on the login screen —
 *  under the local flag only). */
export const DEMO_PASSWORD = "lumina24";

/** Where the demo keeps its TOTP records. Plain JSON on purpose — see the
 *  note on LocalAuthProvider. */
const LOCAL_FACTOR_KEY = "lumina:factors";

interface LocalFactor {
  status: Exclude<TwoFactorStatus, "off">;
  /** Base32, present once enrolled. */
  secret?: string;
}

export type TwoFactorStatus = "off" | "pending" | "enrolled";

/** What a login attempt needs next. */
export type LoginOutcome =
  | { step: "success" }
  | { step: "totp" }
  | { step: "enroll"; secret: string; uri: string; account: string }
  /**
   * They must replace the password they were given before they get in.
   *
   * Last of the gates, in both paths: two-factor is the stronger check and
   * runs first, so by the time this appears the person is as authenticated as
   * the workspace asks them to be. The session still is not published.
   */
  | { step: "password" }
  | { step: "error"; message: string };

export interface EnrollmentDraft {
  userId: string;
  account: string;
  secret: string;
  uri: string;
  /** A ready-made QR image (data URI). Supabase returns one from `enroll()`,
   *  so the Supabase path never generates a QR; the local path has no server
   *  to ask and leaves this undefined, and `TwoFactorQr` renders the `uri`
   *  through the `qrcode` package instead. */
  qrCode?: string;
  /** Supabase MFA factor id — the handle `challenge`/`verify`/`unenroll` need. */
  factorId?: string;
}

export interface AuthValue {
  ready: boolean;
  /** Authenticated user id, or null when logged out. Under Supabase this is
   *  the `profiles.id`, which is the auth uid. */
  session: string | null;

  login: (identifier: string, password: string) => Promise<LoginOutcome>;
  submitLoginTotp: (code: string) => Promise<LoginOutcome>;
  submitEnrollment: (code: string) => Promise<LoginOutcome>;
  /** Replace the handed-out password, as the last step of signing in. */
  submitFirstPassword: (next: string) => Promise<LoginOutcome>;
  cancelPendingLogin: () => void;
  /** Live enrollment draft during a forced-enrollment login. */
  loginEnrollment: EnrollmentDraft | null;
  logout: () => void;

  /** Demo account switch. Inert under the Supabase flag. */
  requestSwitch: (userId: string) => Promise<void>;
  pendingSwitch: string | null;
  submitSwitchTotp: (code: string) => Promise<boolean>;
  cancelSwitch: () => void;

  twoFactorStatus: (userId: string) => TwoFactorStatus;
  /**
   * The four admin two-factor actions, and they all resolve `false` when the
   * write did not land.
   *
   * They used to return `void` and run their update in a detached async IIFE,
   * so `app/people/page.tsx` toasted "Two-factor required for Dana" the
   * instant the switch was flipped and a refused write answered a moment
   * later with a red contradiction — QA-119. Every other admin control on
   * that page already checks a return value before claiming anything; these
   * four were the exception, and now they are not.
   */
  requireTwoFactor: (userId: string) => Promise<boolean>;
  /** Admin: cancel a pending requirement. */
  clearTwoFactorRequirement: (userId: string) => Promise<boolean>;
  /** Admin: turn 2FA off entirely. */
  disableTwoFactor: (userId: string) => Promise<boolean>;
  /** Admin: force re-enrollment (keeps it required, drops the factor). */
  resetTwoFactor: (userId: string) => Promise<boolean>;

  /** Self-service enrollment (from the account menu). Resolves null when the
   *  backend can't start one — always, on the local path. */
  beginSelfEnrollment: (userId: string) => Promise<EnrollmentDraft | null>;
  confirmSelfEnrollment: (draft: EnrollmentDraft, code: string) => Promise<boolean>;

  /**
   * Change your own password. Resolves `null` on success, or the reason.
   *
   * Your own, and only your own — this is `auth.updateUser`, which acts on the
   * session's user and cannot be pointed at anybody else. Setting somebody
   * else's password needs the secret key, which is why `scripts/set-password.ps1`
   * exists and runs outside the browser.
   *
   * Added because the workspace was handing out first passwords with no way to
   * replace them: the Members screen said "they can change it once they're in"
   * while the app offered nothing that could.
   */
  changePassword: (next: string) => Promise<string | null>;

  /** Demo data wipe. Inert under the Supabase flag. */
  resetAll: () => Promise<void>;
}

const AuthContext = React.createContext<AuthValue | null>(null);

type Client = SupabaseClient<Database>;

/**
 * The browser client, loaded only when this build actually runs on Supabase.
 *
 * `lib/supabase.ts` throws at import time when `NEXT_PUBLIC_SUPABASE_URL` /
 * `..._ANON_KEY` are missing, which is the correct behaviour for a real
 * deployment and the wrong behaviour for a local-flag build or a unit test
 * that never talks to Supabase at all. A dynamic import keeps that module out
 * of the graph unless the Supabase provider mounts without an injected client.
 */
let clientPromise: Promise<Client> | null = null;
function browserClient(): Promise<Client> {
  clientPromise ??= import("./supabase").then((m) => m.supabase);
  return clientPromise;
}

export function AuthProvider({
  children,
  client,
}: React.PropsWithChildren<{
  /** Test seam, mirroring `StoreProvider`'s `backend` prop. Production never
   *  passes it — the provider loads the real browser client itself. */
  client?: Client;
}>) {
  return backendKind === "supabase" ? (
    <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>
  ) : (
    <LocalAuthProvider>{children}</LocalAuthProvider>
  );
}

export function useAuth(): AuthValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Local — the browser-only demo
// ---------------------------------------------------------------------------

/**
 * Two-factor on the local demo is genuine RFC-6238 TOTP — a real Google
 * Authenticator code, really verified (`lib/totp.ts`). A screen that waved
 * through any six digits would be a lie in the UI, so this is either honest
 * or absent. It is honest.
 *
 * What the auth swap did retire is the PBKDF2 password hashing and the
 * AES-GCM "credential vault" that used to wrap these records. Both were
 * browser-side theatre — the wrapping key shipped inside the bundle — and
 * real passwords are Supabase's job now. The secrets below sit in plain
 * localStorage, which is exactly as secure as the encrypted version was and
 * does not pretend otherwise. All of it retires at cutover.
 */
function LocalAuthProvider({ children }: React.PropsWithChildren) {
  const [ready, setReady] = React.useState(false);
  const [session, setSession] = React.useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = React.useState<string | null>(null);

  // Resolve handles without importing the store.
  const usersRef = React.useRef(createSeed().users);

  /** Per-user TOTP records for the demo. */
  const [factors, setFactors] = React.useState<Record<string, LocalFactor>>({});
  const [pendingLogin, setPendingLogin] = React.useState<string | null>(null);
  const [loginEnrollment, setLoginEnrollment] =
    React.useState<EnrollmentDraft | null>(null);

  React.useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(SESSION_KEY);
    } catch {}
    if (saved && usersRef.current.some((u) => u.id === saved)) setSession(saved);
    try {
      const raw = window.localStorage.getItem(LOCAL_FACTOR_KEY);
      if (raw) setFactors(JSON.parse(raw) as Record<string, LocalFactor>);
    } catch {
      // Unreadable or corrupt: everyone simply starts with 2FA off.
    }
    setReady(true);
  }, []);

  const writeFactors = React.useCallback(
    (next: Record<string, LocalFactor>) => {
      setFactors(next);
      try {
        window.localStorage.setItem(LOCAL_FACTOR_KEY, JSON.stringify(next));
      } catch {}
    },
    []
  );

  const persistSession = React.useCallback((userId: string | null) => {
    setSession(userId);
    try {
      if (userId) window.localStorage.setItem(SESSION_KEY, userId);
      else window.localStorage.removeItem(SESSION_KEY);
    } catch {}
  }, []);

  const value = React.useMemo<AuthValue>(() => {
    const findUserId = (identifier: string): string | null => {
      const q = identifier.trim().toLowerCase();
      if (!q) return null;
      const user = usersRef.current.find(
        (u) =>
          u.handle.toLowerCase() === q ||
          u.name.toLowerCase() === q ||
          `${u.handle}@northlight.studio` === q
      );
      return user?.id ?? null;
    };

    const login: AuthValue["login"] = async (identifier, password) => {
      const userId = findUserId(identifier);
      if (!userId) return { step: "error", message: "No account matches those details." };
      // A demo password held in a public bundle: there is nothing to protect,
      // so a plain comparison is the honest implementation.
      if (password !== DEMO_PASSWORD) {
        return { step: "error", message: "Incorrect password." };
      }
      const factor = factors[userId];
      if (factor?.status === "enrolled") {
        setPendingLogin(userId);
        return { step: "totp" };
      }
      if (factor?.status === "pending") {
        const draft = draftFor(userId);
        setPendingLogin(userId);
        setLoginEnrollment(draft);
        return {
          step: "enroll",
          secret: draft.secret,
          uri: draft.uri,
          account: draft.account,
        };
      }
      persistSession(userId);
      return { step: "success" };
    };

    const draftFor = (userId: string): EnrollmentDraft => {
      const user = usersRef.current.find((u) => u.id === userId);
      const account = user ? `${user.handle}@northlight.studio` : userId;
      const secret = generateTotpSecret();
      return {
        userId,
        account,
        secret,
        uri: totpAuthUri({ secret, account, issuer: "Lumina" }),
      };
    };

    const submitLoginTotp: AuthValue["submitLoginTotp"] = async (code) => {
      const userId = pendingLogin;
      const secret = userId ? factors[userId]?.secret : undefined;
      if (!userId || !secret) {
        return { step: "error", message: "That sign-in expired. Start again." };
      }
      if (!(await verifyTotp(secret, code))) {
        return {
          step: "error",
          message: "That code isn't right. Try the next one.",
        };
      }
      setPendingLogin(null);
      persistSession(userId);
      return { step: "success" };
    };

    const submitEnrollment: AuthValue["submitEnrollment"] = async (code) => {
      const draft = loginEnrollment;
      if (!draft) {
        return { step: "error", message: "That sign-in expired. Start again." };
      }
      if (!(await verifyTotp(draft.secret, code))) {
        return {
          step: "error",
          message: "That code isn't right. Try the next one.",
        };
      }
      writeFactors({
        ...factors,
        [draft.userId]: { status: "enrolled", secret: draft.secret },
      });
      setLoginEnrollment(null);
      setPendingLogin(null);
      persistSession(draft.userId);
      return { step: "success" };
    };

    const logout = () => {
      persistSession(null);
      setPendingSwitch(null);
      setPendingLogin(null);
      setLoginEnrollment(null);
    };

    const setStatus = (userId: string, next: LocalFactor | null) => {
      const copy = { ...factors };
      if (next) copy[userId] = next;
      else delete copy[userId];
      writeFactors(copy);
    };

    return {
      ready,
      session,
      login,
      submitLoginTotp,
      submitEnrollment,
      submitFirstPassword: async () => ({
        step: "error" as const,
        message: "The demo signs everyone in with one shared password, so there is nothing to replace.",
      }),
      cancelPendingLogin: () => {
        setPendingLogin(null);
        setLoginEnrollment(null);
      },
      loginEnrollment,
      logout,

      requestSwitch: async (userId) => {
        if (userId === session) return;
        // Switching into an account with 2FA still has to pass it.
        if (factors[userId]?.status === "enrolled") setPendingSwitch(userId);
        else persistSession(userId);
      },
      pendingSwitch,
      submitSwitchTotp: async (code) => {
        const secret = pendingSwitch ? factors[pendingSwitch]?.secret : undefined;
        if (!pendingSwitch || !secret) return false;
        if (!(await verifyTotp(secret, code))) return false;
        persistSession(pendingSwitch);
        setPendingSwitch(null);
        return true;
      },
      cancelSwitch: () => setPendingSwitch(null),

      twoFactorStatus: (userId) => factors[userId]?.status ?? "off",
      // The demo path writes to memory, so these cannot fail; they resolve
      // `true` to satisfy the seam the Supabase path needs.
      requireTwoFactor: async (userId) => {
        setStatus(userId, { status: "pending" });
        return true;
      },
      clearTwoFactorRequirement: async (userId) => {
        setStatus(userId, null);
        return true;
      },
      disableTwoFactor: async (userId) => {
        setStatus(userId, null);
        return true;
      },
      // Still required, factor dropped: they enroll again at next login.
      resetTwoFactor: async (userId) => {
        setStatus(userId, { status: "pending" });
        return true;
      },
      changePassword: async () =>
        "The demo signs everyone in with one shared password, so there is nothing to change here.",
      beginSelfEnrollment: async (userId) => draftFor(userId),
      confirmSelfEnrollment: async (draft, code) => {
        if (!(await verifyTotp(draft.secret, code))) return false;
        writeFactors({
          ...factors,
          [draft.userId]: { status: "enrolled", secret: draft.secret },
        });
        return true;
      },

      resetAll: async () => {
        try {
          window.localStorage.removeItem(LEGACY_AUTH_KEY);
          window.localStorage.removeItem(LOCAL_FACTOR_KEY);
        } catch {}
        setFactors({});
        persistSession(null);
        setPendingSwitch(null);
        setPendingLogin(null);
        setLoginEnrollment(null);
      },
    };
  }, [
    ready,
    session,
    pendingSwitch,
    pendingLogin,
    loginEnrollment,
    factors,
    persistSession,
    writeFactors,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ---------------------------------------------------------------------------
// Supabase — real accounts, native TOTP MFA
// ---------------------------------------------------------------------------

type ProfileRow = Pick<
  Database["public"]["Tables"]["profiles"]["Row"],
  "id" | "handle" | "email" | "mfa_required" | "must_change_password"
>;

async function fetchProfile(client: Client, uid: string): Promise<ProfileRow | null> {
  const { data, error } = await client
    .from("profiles")
    .select("id, handle, email, mfa_required, must_change_password")
    .eq("id", uid)
    .maybeSingle();
  return error ? null : data;
}

/** The user's own verified TOTP factor, if they have one. `listFactors().totp`
 *  is already narrowed to verified factors by supabase-js. */
async function verifiedFactorId(client: Client): Promise<string | null> {
  try {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error || !data) return null;
    return data.totp[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Drops the caller's own factors. Only ever their own: removing someone
 *  else's needs `auth.admin`, which needs the secret key, which must never
 *  reach a browser bundle. */
async function unenrollOwnFactors(client: Client): Promise<void> {
  try {
    const { data } = await client.auth.mfa.listFactors();
    for (const factor of data?.all ?? []) {
      await client.auth.mfa.unenroll({ factorId: factor.id });
    }
  } catch {}
}

/**
 * What `startEnrollment` answers with.
 *
 * It used to answer `EnrollmentDraft | null`, and the `null` threw away the
 * only useful part. Enrolment fails for two quite different reasons - a
 * transient network problem, and TOTP enrolment being switched off in the
 * project's Auth settings - and the caller has to tell them apart, because
 * "try again" is sound advice for the first and advice that can never work
 * for the second.
 */
type EnrollmentAttempt =
  | { ok: true; draft: EnrollmentDraft }
  | { ok: false; message: string };

async function startEnrollment(
  client: Client,
  userId: string,
  account: string
): Promise<EnrollmentAttempt> {
  try {
    // Supabase keeps unverified factors around, so an abandoned attempt would
    // pile a second one on top of the first. Clear them before enrolling.
    const { data: existing } = await client.auth.mfa.listFactors();
    for (const factor of existing?.all ?? []) {
      if (factor.status !== "verified") {
        await client.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error } = await client.auth.mfa.enroll({
      factorType: "totp",
      issuer: WORKSPACE,
    });
    if (error || !data) {
      return { ok: false, message: error?.message ?? "Supabase refused the enrolment." };
    }
    return {
      ok: true,
      draft: {
        userId,
        account,
        secret: data.totp.secret,
        uri: data.totp.uri,
        qrCode: data.totp.qr_code,
        factorId: data.id,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The enrolment request didn't complete.",
    };
  }
}

async function challengeAndVerify(
  client: Client,
  factorId: string,
  code: string
): Promise<boolean> {
  try {
    const challenge = await client.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data) return false;
    const verified = await client.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code: code.replace(/\s/g, ""),
    });
    return !verified.error;
  } catch {
    return false;
  }
}

async function signOutQuietly(client: Client): Promise<void> {
  try {
    await client.auth.signOut();
  } catch {}
}

function SupabaseAuthProvider({
  children,
  client: injected,
}: React.PropsWithChildren<{ client?: Client }>) {
  const [client, setClient] = React.useState<Client | null>(injected ?? null);
  const [ready, setReady] = React.useState(false);
  const [session, setSession] = React.useState<string | null>(null);
  const [loginEnrollment, setLoginEnrollment] = React.useState<EnrollmentDraft | null>(
    null
  );
  /** The half-finished login held at the TOTP/enrolment step. */
  const [pending, setPending] = React.useState<{
    profileId: string;
    factorId: string;
  } | null>(null);
  /** `profiles.mfa_required`, by user id. Profiles are readable by any signed-in
   *  user, so this is one small read that keeps `twoFactorStatus` synchronous. */
  const [mfaRequired, setMfaRequired] = React.useState<Record<string, boolean>>({});
  const [selfEnrolled, setSelfEnrolled] = React.useState(false);

  /**
   * True while a login is waiting on a second factor. Supabase has already
   * issued a session at that point (aal1) and `onAuthStateChange` fires
   * immediately — publishing it would let anyone skip the second factor by
   * simply not answering it. A ref, not state: the listener must see the
   * current value, not the one captured when it was registered.
   */
  const gated = React.useRef(false);
  /** The initial `getSession()` pass owns the first answer; until it finishes,
   *  the listener stays quiet rather than racing it. */
  const initialised = React.useRef(false);

  React.useEffect(() => {
    if (injected) {
      setClient(injected);
      return;
    }
    let cancelled = false;
    browserClient().then(
      (c) => {
        if (!cancelled) setClient(c);
      },
      () => {
        // Misconfigured build: surface the login screen rather than a spinner
        // that never resolves.
        if (!cancelled) setReady(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [injected]);

  React.useEffect(() => {
    if (!client) return;
    let cancelled = false;

    const publish = async (uid: string | null) => {
      if (cancelled || !initialised.current) return;
      if (!uid) {
        setSession(null);
        setSelfEnrolled(false);
        setMfaRequired({});
        return;
      }
      if (gated.current) return;
      const profile = await fetchProfile(client, uid);
      if (cancelled) return;
      setSession(profile ? profile.id : null);
    };

    void (async () => {
      const { data } = await client.auth.getSession();
      const uid = data.session?.user.id ?? null;
      if (uid) {
        const profile = await fetchProfile(client, uid);
        const factorId = await verifiedFactorId(client);
        if (
          !profile ||
          (profile.mfa_required && !factorId) ||
          profile.must_change_password
        ) {
          // Either the profile row never appeared (see the runbook), a forced
          // enrolment was never completed, or the password they were handed is
          // still in place. There is no safe half-state to restore into, and
          // leaving the session would let a reload walk straight past whichever
          // step is outstanding — so start clean.
          await signOutQuietly(client);
        } else if (!cancelled) {
          setSession(profile.id);
          setSelfEnrolled(!!factorId);
        }
      }
      initialised.current = true;
      if (!cancelled) setReady(true);
    })();

    const { data: sub } = client.auth.onAuthStateChange((_event, next) => {
      // Deferred: supabase-js holds an internal lock across this callback, and
      // calling back into the client from inside it can deadlock.
      const uid = next?.user.id ?? null;
      setTimeout(() => void publish(uid), 0);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [client]);

  // Everyone's requirement flag, plus our own enrolment state, once signed in.
  React.useEffect(() => {
    if (!client || !session) return;
    let cancelled = false;
    void (async () => {
      const { data } = await client.from("profiles").select("id, mfa_required");
      if (!cancelled && data) {
        setMfaRequired(
          Object.fromEntries(data.map((p) => [p.id, p.mfa_required] as const))
        );
      }
      const factorId = await verifiedFactorId(client);
      if (!cancelled) setSelfEnrolled(!!factorId);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  const value = React.useMemo<AuthValue>(() => {
    const login: AuthValue["login"] = async (identifier, password) => {
      if (!client) return { step: "error", message: "Still connecting — try again." };
      const email = identifier.trim();
      if (!email.includes("@")) {
        return { step: "error", message: "Sign in with your work email address." };
      }

      setPending(null);
      setLoginEnrollment(null);
      // Hold the session back until we know whether a second factor is owed.
      gated.current = true;

      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error || !data.user) {
        gated.current = false;
        // One message for both "no such account" and "wrong password": telling
        // them apart tells an attacker which addresses exist.
        return { step: "error", message: "Incorrect email or password." };
      }

      // THE FACTOR CHECK COMES BEFORE THE PROFILE READ, AND THE ORDER IS THE
      // WHOLE POINT.
      //
      // `signInWithPassword` issues an aal1 session. For an account that has a
      // verified factor, `session_is_assured()` is false at that moment, so
      // `require_assurance` (20260910004000) filters `profiles` to nothing —
      // no error, no rows, because a restrictive policy filters rather than
      // raises. Reading the profile here therefore returned null and the login
      // screen told the workspace's Owner that he had no profile.
      //
      // He had one. It was unreadable for the three seconds between his
      // password and his code, which is exactly what that policy is for. The
      // effect was that enrolling two-factor locked you out permanently.
      //
      // `listFactors` is an auth API rather than a table, so it answers at
      // aal1. And `profiles.id` IS the auth uid (`handle_new_user` guarantees
      // it), so nothing here needs the profile row to know who is signing in.
      // The profile is read once the session can actually read it — after the
      // second factor, in `finishGatedLogin`.
      const factorId = await verifiedFactorId(client);
      if (factorId) {
        setPending({ profileId: data.user.id, factorId });
        return { step: "totp" };
      }

      // No verified factor, so the session is assured and this read works.
      const profile = await fetchProfile(client, data.user.id);
      if (!profile) {
        await signOutQuietly(client);
        gated.current = false;
        return {
          step: "error",
          message: "This account has no Lumina profile yet — ask an admin to finish setting it up.",
        };
      }

      if (profile.mfa_required) {
        const attempt = await startEnrollment(client, profile.id, profile.handle);
        const draft = attempt.ok ? attempt.draft : null;
        if (!draft?.factorId) {
          await signOutQuietly(client);
          gated.current = false;
          // Carry Supabase's own words rather than a sentence invented here.
          //
          // This used to say "Couldn't start two-factor setup. Try again." -
          // which is fine for a dropped connection and actively misleading
          // when TOTP enrolment is switched off for the project, because then
          // there is nothing to try again and every attempt ends the same way.
          //
          // Deliberately not matched against a particular error code. The
          // access suite found enrolment ENABLED on development, so the
          // disabled-provider signal has never been observed here, and a check
          // written against a guessed string is a check that never fires. The
          // server's message is passed through and the likeliest cause is
          // named as a possibility rather than asserted as the reason.
          const reason = attempt.ok ? "Supabase returned no factor." : attempt.message;
          return {
            step: "error",
            message:
              `Two-factor setup couldn't start: ${reason} ` +
              "If this keeps happening, an admin needs to check that two-factor is enabled for the workspace.",
          };
        }
        setPending({ profileId: profile.id, factorId: draft.factorId });
        setLoginEnrollment(draft);
        return {
          step: "enroll",
          secret: draft.secret,
          uri: draft.uri,
          account: draft.account,
        };
      }

      if (profile.must_change_password) {
        // `pending` normally carries the factor the TOTP step will answer.
        // There is none here, and the field is only read by finishGatedLogin,
        // which this path never reaches — so an empty string records "gated on
        // something else" without inventing a factor that does not exist.
        setPending({ profileId: profile.id, factorId: "" });
        return { step: "password" };
      }

      gated.current = false;
      setSession(profile.id);
      return { step: "success" };
    };

    /** Publish the session, now that every gate has been passed. */
    const admit = (profileId: string): LoginOutcome => {
      gated.current = false;
      setSession(profileId);
      setPending(null);
      setLoginEnrollment(null);
      return { step: "success" };
    };

    const finishGatedLogin = async (code: string): Promise<LoginOutcome> => {
      if (!client || !pending) {
        return { step: "error", message: "Session expired — start over." };
      }
      const ok = await challengeAndVerify(client, pending.factorId, code);
      if (!ok) return { step: "error", message: "That code isn't valid. Try again." };
      setSelfEnrolled(true);

      // Two-factor is done; the password gate may still be standing. Re-read
      // the profile rather than trusting what login() saw, because the flag
      // could have been cleared in between - by them, on another device,
      // finishing this same flow.
      // Now aal2, so this read is the first one that can succeed for an
      // account with a factor — which makes it the place the missing-profile
      // case has to be handled.
      const profile = await fetchProfile(client, pending.profileId);
      if (!profile) {
        await signOutQuietly(client);
        gated.current = false;
        setPending(null);
        setLoginEnrollment(null);
        return {
          step: "error",
          message: "This account has no Lumina profile yet — ask an admin to finish setting it up.",
        };
      }
      if (profile.must_change_password) {
        setLoginEnrollment(null);
        return { step: "password" };
      }
      return admit(pending.profileId);
    };

    /**
     * Replace the password you were handed, as the last step of signing in.
     *
     * The flag is NOT written here. A trigger on auth.users clears it when
     * `encrypted_password` actually changes, so this cannot report success
     * over a password that did not move - and equally cannot be skipped by a
     * client that writes the flag without the password.
     */
    const submitFirstPassword = async (next: string): Promise<LoginOutcome> => {
      if (!client || !pending) {
        return { step: "error", message: "Session expired - start over." };
      }
      if (next.length < 8) {
        return { step: "error", message: "Use a password of at least 8 characters." };
      }
      const { error } = await client.auth.updateUser({ password: next });
      if (error) return { step: "error", message: error.message };
      return admit(pending.profileId);
    };

    const cancelPendingLogin = () => {
      const abandoned = loginEnrollment?.factorId;
      const c = client;
      gated.current = false;
      setPending(null);
      setLoginEnrollment(null);
      setSession(null);
      if (!c) return;
      // A gated login still holds a real aal1 session. Backing out of the
      // second step has to end it, or "Back to sign in" would leave the
      // account half-open.
      void (async () => {
        if (abandoned) {
          try {
            await c.auth.mfa.unenroll({ factorId: abandoned });
          } catch {}
        }
        await signOutQuietly(c);
      })();
    };

    const logout = () => {
      gated.current = false;
      setPending(null);
      setLoginEnrollment(null);
      setSession(null);
      try {
        window.localStorage.removeItem(LEGACY_AUTH_KEY);
        window.localStorage.removeItem(SESSION_KEY);
      } catch {}
      if (client) void signOutQuietly(client);
    };

    const setRequirement = async (userId: string, required: boolean): Promise<boolean> => {
      if (!client) return false;
      const { error } = await client
        .from("profiles")
        .update({ mfa_required: required })
        .eq("id", userId);
      if (error) {
        toast.error("Couldn't change the two-factor requirement", {
          description: error.message,
        });
        return false;
      }
      setMfaRequired((m) => ({ ...m, [userId]: required }));
      return true;
    };

    /** Only ever the signed-in user's own factor — see `unenrollOwnFactors`. */
    const dropOwnFactor = (userId: string) => {
      if (!client || userId !== session) return;
      void (async () => {
        await unenrollOwnFactors(client);
        setSelfEnrolled(false);
      })();
    };

    return {
      ready,
      session,
      login,
      submitLoginTotp: finishGatedLogin,
      submitEnrollment: finishGatedLogin,
      submitFirstPassword,
      cancelPendingLogin,
      loginEnrollment,
      logout,

      // Demo-only. Inert here, and rendered nowhere under this flag.
      requestSwitch: async () => {},
      pendingSwitch: null,
      submitSwitchTotp: async () => false,
      cancelSwitch: () => {},
      resetAll: async () => {},

      /**
       * `enrolled` is only ever answerable about the signed-in user: listing
       * anyone else's factors is an `auth.admin` call. For everyone else this
       * reports the requirement flag, which is what an admin can actually act
       * on — so the People page's reset/disable items, which are gated on
       * `enrolled`, only appear for yourself, where they work.
       */
      twoFactorStatus: (userId) => {
        if (userId === session && selfEnrolled) return "enrolled";
        return mfaRequired[userId] ? "pending" : "off";
      },
      requireTwoFactor: (userId) => setRequirement(userId, true),
      clearTwoFactorRequirement: (userId) => setRequirement(userId, false),
      // The requirement write is the one that can be refused and the one the
      // caller is told about; dropping the factor is a no-op unless this is
      // the signed-in user's own (see `dropOwnFactor`), and an admin cannot
      // remove somebody else's from the client — a recorded limitation.
      disableTwoFactor: async (userId) => {
        const ok = await setRequirement(userId, false);
        dropOwnFactor(userId);
        return ok;
      },
      resetTwoFactor: async (userId) => {
        const ok = await setRequirement(userId, true);
        dropOwnFactor(userId);
        return ok;
      },

      beginSelfEnrollment: async (userId) => {
        if (!client) return null;
        const profile = await fetchProfile(client, userId);
        const attempt = await startEnrollment(client, userId, profile?.handle ?? userId);
        // `null` keeps SelfEnrollDialog's QA-120 `failed` flag working as it
        // does today. The dialog has its own "Couldn't start setup" panel; it
        // does not need the reason threaded through to stop being honest.
        return attempt.ok ? attempt.draft : null;
      },
      changePassword: async (next) => {
        if (!client) return "Not connected to the workspace.";
        // Mirrors the floor the Add-teammate dialog uses, so the two places a
        // password is chosen agree. Supabase's own minimum is lower.
        if (next.length < 8) return "Use a password of at least 8 characters.";
        const { error } = await client.auth.updateUser({ password: next });
        // Supabase's own sentence, not a generic one. It is the only thing
        // that distinguishes "too weak", "same as the old one" and a project
        // that requires a recent sign-in before a password change.
        return error ? error.message : null;
      },
      confirmSelfEnrollment: async (draft, code) => {
        if (!client || !draft.factorId) return false;
        const ok = await challengeAndVerify(client, draft.factorId, code);
        if (ok) setSelfEnrolled(true);
        return ok;
      },
    };
  }, [client, ready, session, pending, loginEnrollment, mfaRequired, selfEnrolled]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
