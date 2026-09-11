"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OtpInput } from "@/components/auth/otp-input";
import { TwoFactorQr } from "@/components/auth/two-factor-qr";
import { DEMO_PASSWORD, useAuth, type LoginOutcome } from "@/lib/auth";
import { backendKind } from "@/lib/backend";
import { cn } from "@/lib/utils";

type Step = "credentials" | "totp" | "enroll" | "password";

// Owner first: it is the top role, and the demo is the only place it can be
// signed into without a runbook. `findUserId` already matched it by handle —
// what was missing was any way to know it existed.
const DEMO_ACCOUNTS = [
  { handle: "owner", role: "Owner" },
  { handle: "moshe", role: "Admin" },
  { handle: "maya", role: "Member" },
  { handle: "elena", role: "Guest" },
];

export function LoginScreen() {
  /** The demo is the *only* thing the one-click logins and the printed
   *  password are for. On a real backend they are not rendered — and
   *  `fillDemo` below, their only caller, therefore cannot run. Read per
   *  render so tests can mount this screen under either flag. */
  const isDemo = backendKind !== "supabase";

  const {
    login,
    submitLoginTotp,
    submitEnrollment,
    submitFirstPassword,
    cancelPendingLogin,
    loginEnrollment,
  } = useAuth();

  const [step, setStep] = React.useState<Step>("credentials");
  const [identifier, setIdentifier] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  /** The "choose your own" step. Kept apart from `password`, which holds the
   *  one they were given and is still needed if they go back. */
  const [nextPassword, setNextPassword] = React.useState("");
  const [nextAgain, setNextAgain] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const apply = (outcome: LoginOutcome) => {
    if (outcome.step === "error") {
      setError(outcome.message);
      return;
    }
    setError(null);
    setCode("");
    if (outcome.step === "totp") setStep("totp");
    else if (outcome.step === "enroll") setStep("enroll");
    else if (outcome.step === "password") {
      setNextPassword("");
      setNextAgain("");
      setStep("password");
    }
    // "success" → session flips; AuthGate swaps in the app.
  };

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    apply(await login(identifier, password));
    setBusy(false);
  };

  const verifyCode = async (value = code) => {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError(null);
    apply(
      step === "enroll"
        ? await submitEnrollment(value)
        : await submitLoginTotp(value)
    );
    setBusy(false);
  };

  const choosePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (nextPassword !== nextAgain) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    apply(await submitFirstPassword(nextPassword));
    setBusy(false);
  };

  const back = () => {
    cancelPendingLogin();
    setStep("credentials");
    setCode("");
    setError(null);
    setPassword("");
    setNextPassword("");
    setNextAgain("");
  };

  const fillDemo = (handle: string) => {
    setIdentifier(handle);
    setPassword(DEMO_PASSWORD);
    setError(null);
  };

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* Ambient brand glow */}
      <div className="pointer-events-none absolute -top-32 left-1/2 size-[520px] -translate-x-1/2 rounded-full bg-gradient-to-br from-indigo-500/20 via-violet-500/15 to-fuchsia-500/10 blur-3xl" />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="relative w-full max-w-sm"
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/25">
            <Sparkles className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {step === "credentials" && "Welcome to Lumina"}
            {step === "totp" && "Two-factor verification"}
            {step === "enroll" && "Secure your account"}
            {step === "password" && "Choose your own password"}
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {step === "credentials" && "Sign in to Northlight Studio"}
            {step === "totp" && "Enter the code from your authenticator app"}
            {step === "enroll" && "Two-factor is required for your role"}
            {step === "password" &&
              "The one you were given was shared with you — replace it to continue"}
          </p>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          {step === "credentials" && (
            <form onSubmit={submitCredentials} className="flex flex-col gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="login-id">
                  {isDemo ? "Username or email" : "Work email"}
                </Label>
                <Input
                  id="login-id"
                  autoFocus
                  autoComplete={isDemo ? "username" : "email"}
                  placeholder={isDemo ? "moshe" : "you@company.com"}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="login-pw">Password</Label>
                <div className="relative">
                  <Lock className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="login-pw"
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    className="pl-8"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </div>

              {error && <FormError message={error} />}

              <Button type="submit" className="mt-1 w-full" disabled={busy}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                Sign in
              </Button>
            </form>
          )}

          {(step === "totp" || step === "enroll") && (
            <div className="flex flex-col gap-4">
              {step === "enroll" && loginEnrollment && (
                <div className="flex flex-col items-center gap-3">
                  <ol className="w-full space-y-1.5 text-[13px] text-muted-foreground">
                    <li className="flex gap-2">
                      <Smartphone className="mt-0.5 size-3.5 shrink-0" />
                      Scan this with Google Authenticator (or any TOTP app).
                    </li>
                  </ol>
                  <TwoFactorQr
                    uri={loginEnrollment.uri}
                    secret={loginEnrollment.secret}
                    qrCode={loginEnrollment.qrCode}
                  />
                </div>
              )}

              {step === "totp" && (
                <div className="flex items-center justify-center gap-2 rounded-xl bg-muted/40 py-3 text-[13px] text-muted-foreground">
                  <ShieldCheck className="size-4 text-emerald-500" />
                  Protected by two-factor authentication
                </div>
              )}

              <div className="grid gap-1.5">
                <Label htmlFor="otp">
                  {step === "enroll" ? "Enter the 6-digit code to confirm" : "6-digit code"}
                </Label>
                <OtpInput
                  value={code}
                  onChange={setCode}
                  onComplete={(v) => verifyCode(v)}
                  autoFocus
                  disabled={busy}
                  invalid={!!error}
                />
              </div>

              {error && <FormError message={error} />}

              <Button
                className="w-full"
                onClick={() => verifyCode()}
                disabled={busy || code.length !== 6}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                {step === "enroll" ? "Verify & enable" : "Verify"}
              </Button>
              <button
                type="button"
                onClick={back}
                className="flex items-center justify-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                Back to sign in
              </button>
            </div>
          )}

          {/* The last gate. Two-factor runs first, so by now they are as
              authenticated as the workspace asks — what is left is that the
              password they hold was chosen by somebody else. */}
          {step === "password" && (
            <form onSubmit={choosePassword} className="flex flex-col gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="first-pw">New password</Label>
                <div className="relative">
                  <Lock className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="first-pw"
                    type="password"
                    autoFocus
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    className="pl-8"
                    value={nextPassword}
                    onChange={(e) => setNextPassword(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="first-pw-again">Type it again</Label>
                <Input
                  id="first-pw-again"
                  type="password"
                  autoComplete="new-password"
                  value={nextAgain}
                  onChange={(e) => setNextAgain(e.target.value)}
                />
              </div>

              {error && <FormError message={error} />}

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                Set password and continue
              </Button>
              {/* No way back. "Back to sign in" on the two-factor steps drops an
                  abandoned factor and ends the half-open session; here there is
                  nothing to abandon, and offering an exit from a gate the admin
                  imposed would just be a way around it. Signing out and in
                  again lands on this same screen. */}
            </form>
          )}
        </div>

        {isDemo && step === "credentials" && (
          <div className="mt-4 rounded-xl border border-dashed bg-muted/30 p-3">
            <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Demo accounts · password{" "}
              <span className="font-mono normal-case">{DEMO_PASSWORD}</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {DEMO_ACCOUNTS.map((a) => (
                <button
                  key={a.handle}
                  type="button"
                  onClick={() => fillDemo(a.handle)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-xs transition-colors hover:border-foreground/25"
                  )}
                >
                  <span className="font-medium">{a.handle}</span>
                  <span className="text-[10px] text-muted-foreground">{a.role}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="mt-4 text-center text-[11px] text-muted-foreground/70">
          {isDemo
            ? "Local demo · everything runs in your browser, and any of the accounts above signs in with the password shown."
            : "Accounts are created by an administrator. Trouble signing in? Ask them to check your account."}
        </p>
      </motion.div>
    </div>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <motion.p
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
    >
      {message}
    </motion.p>
  );
}
