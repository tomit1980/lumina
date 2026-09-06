"use client";

import * as React from "react";

import {
  decryptJSON,
  encryptJSON,
  generateTotpSecret,
  hashPassword,
  totpAuthUri,
  verifyPassword,
  verifyTotp,
  type EncryptedBlob,
  type PasswordHash,
} from "./crypto";
import { createSeed } from "./seed";

const AUTH_KEY = "lumina:auth";
const SESSION_KEY = "lumina:session";
const AUTH_VERSION = 1;
const WORKSPACE = "Lumina";

/** Demo password for every seeded account (surfaced on the login screen). */
export const DEMO_PASSWORD = "lumina24";

export type TwoFactorStatus = "off" | "pending" | "enrolled";

interface TwoFactor {
  status: TwoFactorStatus;
  /** base32 secret — only present once enrolled. */
  secret?: string;
}

interface AuthRecord {
  passwordHash: PasswordHash;
  twoFactor: TwoFactor;
}

interface AuthStore {
  version: number;
  records: Record<string, AuthRecord>;
}

/** What a login attempt needs next. */
export type LoginOutcome =
  | { step: "success" }
  | { step: "totp" }
  | { step: "enroll"; secret: string; uri: string; account: string }
  | { step: "error"; message: string };

export interface EnrollmentDraft {
  userId: string;
  account: string;
  secret: string;
  uri: string;
}

interface AuthValue {
  ready: boolean;
  /** Authenticated user id, or null when logged out. */
  session: string | null;

  login: (identifier: string, password: string) => Promise<LoginOutcome>;
  submitLoginTotp: (code: string) => Promise<LoginOutcome>;
  submitEnrollment: (code: string) => Promise<LoginOutcome>;
  cancelPendingLogin: () => void;
  /** Live enrollment draft during a forced-enrollment login. */
  loginEnrollment: EnrollmentDraft | null;
  logout: () => void;

  /** Demo account switch — enforces 2FA when the target has it enrolled. */
  requestSwitch: (userId: string) => Promise<void>;
  pendingSwitch: string | null;
  submitSwitchTotp: (code: string) => Promise<boolean>;
  cancelSwitch: () => void;

  twoFactorStatus: (userId: string) => TwoFactorStatus;
  /** Admin: require 2FA (user enrolls at next login). */
  requireTwoFactor: (userId: string) => void;
  /** Admin: cancel a pending requirement. */
  clearTwoFactorRequirement: (userId: string) => void;
  /** Admin: turn 2FA off entirely. */
  disableTwoFactor: (userId: string) => void;
  /** Admin: force re-enrollment (keeps it required, drops the secret). */
  resetTwoFactor: (userId: string) => void;

  /** Self-service enrollment (from the account menu). */
  beginSelfEnrollment: (userId: string) => EnrollmentDraft;
  confirmSelfEnrollment: (draft: EnrollmentDraft, code: string) => Promise<boolean>;

  resetAll: () => Promise<void>;
}

const AuthContext = React.createContext<AuthValue | null>(null);

async function buildSeedStore(): Promise<AuthStore> {
  const seed = createSeed();
  const records: Record<string, AuthRecord> = {};
  // Each account gets its own salt → distinct hash for the same demo password.
  await Promise.all(
    seed.users.map(async (user) => {
      records[user.id] = {
        passwordHash: await hashPassword(DEMO_PASSWORD),
        twoFactor: { status: "off" },
      };
    })
  );
  return { version: AUTH_VERSION, records };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = React.useState(false);
  const [store, setStore] = React.useState<AuthStore | null>(null);
  const [session, setSession] = React.useState<string | null>(null);

  // Transient login state (not persisted).
  const [pendingLoginUser, setPendingLoginUser] = React.useState<string | null>(null);
  const [loginEnrollment, setLoginEnrollment] =
    React.useState<EnrollmentDraft | null>(null);
  const [pendingSwitch, setPendingSwitch] = React.useState<string | null>(null);

  // Resolve display names for otpauth accounts without importing the store.
  const usersRef = React.useRef(createSeed().users);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded: AuthStore | null = null;
      try {
        const raw = window.localStorage.getItem(AUTH_KEY);
        if (raw) {
          const blob = JSON.parse(raw) as EncryptedBlob;
          const decoded = await decryptJSON<AuthStore>(blob);
          if (decoded?.version === AUTH_VERSION) loaded = decoded;
        }
      } catch {
        // Corrupt/undecryptable → re-seed fresh credentials.
      }
      if (!loaded) loaded = await buildSeedStore();

      const savedSession = window.localStorage.getItem(SESSION_KEY);
      if (cancelled) return;
      setStore(loaded);
      if (savedSession && loaded.records[savedSession]) setSession(savedSession);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the credential store, encrypted at rest.
  React.useEffect(() => {
    if (!store) return;
    (async () => {
      try {
        const blob = await encryptJSON(store);
        window.localStorage.setItem(AUTH_KEY, JSON.stringify(blob));
      } catch {
        // Storage unavailable — auth still works for this session.
      }
    })();
  }, [store]);

  const persistSession = React.useCallback((userId: string | null) => {
    setSession(userId);
    try {
      if (userId) window.localStorage.setItem(SESSION_KEY, userId);
      else window.localStorage.removeItem(SESSION_KEY);
    } catch {}
  }, []);

  const accountName = React.useCallback((userId: string) => {
    return usersRef.current.find((u) => u.id === userId)?.handle ?? userId;
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

    const draftFor = (userId: string): EnrollmentDraft => {
      const secret = generateTotpSecret();
      const account = accountName(userId);
      return {
        userId,
        account,
        secret,
        uri: totpAuthUri({ secret, account, issuer: WORKSPACE }),
      };
    };

    const patchRecord = (userId: string, fn: (r: AuthRecord) => AuthRecord) =>
      setStore((s) => {
        if (!s || !s.records[userId]) return s;
        return {
          ...s,
          records: { ...s.records, [userId]: fn(s.records[userId]) },
        };
      });

    const login: AuthValue["login"] = async (identifier, password) => {
      setPendingLoginUser(null);
      setLoginEnrollment(null);
      if (!store) return { step: "error", message: "Still loading — try again." };
      const userId = findUserId(identifier);
      const record = userId ? store.records[userId] : undefined;
      if (!userId || !record) {
        return { step: "error", message: "No account matches those details." };
      }
      const ok = await verifyPassword(password, record.passwordHash);
      if (!ok) return { step: "error", message: "Incorrect password." };

      const { status } = record.twoFactor;
      if (status === "enrolled") {
        setPendingLoginUser(userId);
        return { step: "totp" };
      }
      if (status === "pending") {
        const draft = draftFor(userId);
        setPendingLoginUser(userId);
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

    const submitLoginTotp: AuthValue["submitLoginTotp"] = async (code) => {
      if (!store || !pendingLoginUser) {
        return { step: "error", message: "Session expired — start over." };
      }
      const record = store.records[pendingLoginUser];
      if (!record?.twoFactor.secret) {
        return { step: "error", message: "Two-factor is not set up." };
      }
      const ok = await verifyTotp(record.twoFactor.secret, code);
      if (!ok) return { step: "error", message: "That code isn't valid. Try again." };
      persistSession(pendingLoginUser);
      setPendingLoginUser(null);
      return { step: "success" };
    };

    const submitEnrollment: AuthValue["submitEnrollment"] = async (code) => {
      if (!pendingLoginUser || !loginEnrollment) {
        return { step: "error", message: "Enrollment expired — start over." };
      }
      const ok = await verifyTotp(loginEnrollment.secret, code);
      if (!ok) {
        return { step: "error", message: "That code isn't valid yet. Try again." };
      }
      const secret = loginEnrollment.secret;
      patchRecord(pendingLoginUser, (r) => ({
        ...r,
        twoFactor: { status: "enrolled", secret },
      }));
      persistSession(pendingLoginUser);
      setPendingLoginUser(null);
      setLoginEnrollment(null);
      return { step: "success" };
    };

    const cancelPendingLogin = () => {
      setPendingLoginUser(null);
      setLoginEnrollment(null);
    };

    const logout = () => {
      persistSession(null);
      cancelPendingLogin();
      setPendingSwitch(null);
    };

    const requestSwitch: AuthValue["requestSwitch"] = async (userId) => {
      if (!store || userId === session) return;
      const record = store.records[userId];
      if (record?.twoFactor.status === "enrolled") {
        setPendingSwitch(userId);
        return;
      }
      persistSession(userId);
    };

    const submitSwitchTotp: AuthValue["submitSwitchTotp"] = async (code) => {
      if (!store || !pendingSwitch) return false;
      const record = store.records[pendingSwitch];
      if (!record?.twoFactor.secret) return false;
      const ok = await verifyTotp(record.twoFactor.secret, code);
      if (!ok) return false;
      persistSession(pendingSwitch);
      setPendingSwitch(null);
      return true;
    };

    const cancelSwitch = () => setPendingSwitch(null);

    const twoFactorStatus: AuthValue["twoFactorStatus"] = (userId) =>
      store?.records[userId]?.twoFactor.status ?? "off";

    const requireTwoFactor = (userId: string) =>
      patchRecord(userId, (r) =>
        r.twoFactor.status === "off"
          ? { ...r, twoFactor: { status: "pending" } }
          : r
      );

    const clearTwoFactorRequirement = (userId: string) =>
      patchRecord(userId, (r) =>
        r.twoFactor.status === "pending"
          ? { ...r, twoFactor: { status: "off" } }
          : r
      );

    const disableTwoFactor = (userId: string) =>
      patchRecord(userId, (r) => ({ ...r, twoFactor: { status: "off" } }));

    const resetTwoFactor = (userId: string) =>
      patchRecord(userId, (r) => ({ ...r, twoFactor: { status: "pending" } }));

    const beginSelfEnrollment = (userId: string) => draftFor(userId);

    const confirmSelfEnrollment: AuthValue["confirmSelfEnrollment"] = async (
      draft,
      code
    ) => {
      const ok = await verifyTotp(draft.secret, code);
      if (!ok) return false;
      patchRecord(draft.userId, (r) => ({
        ...r,
        twoFactor: { status: "enrolled", secret: draft.secret },
      }));
      return true;
    };

    const resetAll = async () => {
      const fresh = await buildSeedStore();
      try {
        window.localStorage.removeItem(AUTH_KEY);
      } catch {}
      setStore(fresh);
      persistSession(null);
      cancelPendingLogin();
      setPendingSwitch(null);
    };

    return {
      ready,
      session,
      login,
      submitLoginTotp,
      submitEnrollment,
      cancelPendingLogin,
      loginEnrollment,
      logout,
      requestSwitch,
      pendingSwitch,
      submitSwitchTotp,
      cancelSwitch,
      twoFactorStatus,
      requireTwoFactor,
      clearTwoFactorRequirement,
      disableTwoFactor,
      resetTwoFactor,
      beginSelfEnrollment,
      confirmSelfEnrollment,
      resetAll,
    };
  }, [
    ready,
    store,
    session,
    pendingLoginUser,
    loginEnrollment,
    pendingSwitch,
    persistSession,
    accountName,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
