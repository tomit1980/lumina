"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  Lock,
  Mail,
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

type Step = "credentials" | "totp" | "enroll" | "password" | "forgot" | "recover";

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
    forgotPassword,
    recovering,
    submitRecoveryPassword,
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
  /** A non-failure message, e.g. after a password was updated. Kept apart from
   *  `error` because the two are announced differently and styled oppositely. */
  const [notice, setNotice] = React.useState<string | null>(null);
  /** The reset request was accepted. Deliberately not "the email was sent" —
   *  nothing in the browser can know that. */
  const [resetRequested, setResetRequested] = React.useState(false);
  /** Which field the current error is about, or null for a refusal about
   *  both. Drives `aria-invalid` and where focus lands. */
  const [errorField, setErrorField] = React.useState<"email" | "password" | null>(null);
  const [busy, setBusy] = React.useState(false);

  // A reset link puts the provider into `recovering` before this screen ever
  // renders, so the step is derived rather than set by an effect — there is no
  // frame in which the credentials form is shown to somebody who arrived by
  // link, and no effect ordering to get wrong.
  const effectiveStep: Step = recovering && step === "credentials" ? "recover" : step;

  const emailRef = React.useRef<HTMLInputElement>(null);
  const passwordRef = React.useRef<HTMLInputElement>(null);

  const apply = (outcome: LoginOutcome) => {
    if (outcome.step === "error") {
      setError(outcome.message);
      setErrorField(outcome.field ?? null);
      // Move focus to what is wrong. A sighted user sees the red paragraph
      // appear; a keyboard or screen-reader user was left on the button, or —
      // after an async refusal — on the page body, with no signal at all.
      // `role="alert"` announces the text; this is what makes it actionable.
      if (effectiveStep === "credentials") {
        const target = outcome.field === "password" ? passwordRef : emailRef;
        target.current?.focus();
      }
      return;
    }
    setErrorField(null);
    setError(null);
    setCode("");
    if (outcome.step === "credentials") {
      // Back to the form, carrying a notice rather than a refusal. Clearing
      // the password matters: the one just replaced is stale.
      setNotice(outcome.notice ?? null);
      setPassword("");
      setNextPassword("");
      setNextAgain("");
      setStep("credentials");
      return;
    }
    setNotice(null);
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

  const requestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await forgotPassword(identifier);
    if (failure) {
      setError(failure);
      setErrorField("email");
    } else {
      // Shown for any accepted request, including an address with no account.
      // Supabase answers identically for both and so must this screen: a
      // different message would turn the form into an account-enumeration
      // oracle for anybody who can load the page.
      setResetRequested(true);
    }
    setBusy(false);
  };

  const setNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (nextPassword !== nextAgain) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    apply(await submitRecoveryPassword(nextPassword));
    setBusy(false);
  };

  const backToSignIn = () => {
    cancelPendingLogin();
    setStep("credentials");
    setResetRequested(false);
    setError(null);
    setErrorField(null);
    setNextPassword("");
    setNextAgain("");
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
            {effectiveStep === "credentials" && "Welcome to Lumina"}
            {effectiveStep === "totp" && "Two-factor verification"}
            {effectiveStep === "enroll" && "Secure your account"}
            {effectiveStep === "password" && "Choose your own password"}
            {effectiveStep === "forgot" && "Reset your password"}
            {effectiveStep === "recover" && "Choose a new password"}
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {effectiveStep === "credentials" && "Sign in to Northlight Studio"}
            {effectiveStep === "totp" && "Enter the code from your authenticator app"}
            {effectiveStep === "enroll" && "Two-factor is required for your role"}
            {effectiveStep === "password" &&
              "The one you were given was shared with you — replace it to continue"}
            {effectiveStep === "forgot" &&
              "We'll email you a link to set a new one"}
            {effectiveStep === "recover" && "You got here from a reset link"}
          </p>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          {effectiveStep === "credentials" && (
            <form onSubmit={submitCredentials} className="flex flex-col gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="login-id">
                  {isDemo ? "Username or email" : "Work email"}
                </Label>
                <Input
                  id="login-id"
                  ref={emailRef}
                  autoFocus
                  autoComplete={isDemo ? "username" : "email"}
                  placeholder={isDemo ? "moshe" : "you@company.com"}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  // A refusal about both fields marks both: "Incorrect email
                  // or password" is, by design, about both.
                  aria-invalid={!!error && errorField !== "password"}
                  aria-describedby={error ? ERROR_ID : undefined}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="login-pw">Password</Label>
                <div className="relative">
                  <Lock className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="login-pw"
                    ref={passwordRef}
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    className="pl-8"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={!!error && errorField !== "email"}
                    aria-describedby={error ? ERROR_ID : undefined}
                  />
                </div>
              </div>

              {notice && <FormNotice message={notice} />}
              {error && <FormError message={error} />}

              <Button type="submit" className="mt-1 w-full" disabled={busy}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                Sign in
              </Button>

              {/* Not offered on the demo: one shared password is printed on
                  this very screen, so there is nothing to reset and the link
                  would lead to a refusal. */}
              {!isDemo && (
                <button
                  type="button"
                  onClick={() => {
                    setStep("forgot");
                    setError(null);
                    setErrorField(null);
                    setNotice(null);
                  }}
                  className="text-center text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  Forgot your password?
                </button>
              )}
            </form>
          )}

          {effectiveStep === "forgot" && (
            <div className="flex flex-col gap-4">
              {resetRequested ? (
                <>
                  {/* The same sentence whether or not the address has an
                      account, and it promises a REQUEST rather than a
                      delivery. On the free tier the mailer caps at about two
                      an hour and the shared sender lands in spam — neither is
                      visible from here, so neither is claimed. */}
                  <p role="status" className="rounded-lg bg-muted/50 px-3 py-2.5 text-[13px]">
                    If that address has an account, a reset link is on its way. It&apos;s
                    valid for an hour. If nothing arrives in a few minutes, check your spam
                    folder — or ask an admin to reset it for you.
                  </p>
                  <button
                    type="button"
                    onClick={backToSignIn}
                    className="flex items-center justify-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ArrowLeft className="size-3.5" />
                    Back to sign in
                  </button>
                </>
              ) : (
                <form onSubmit={requestReset} className="flex flex-col gap-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="forgot-email">Work email</Label>
                    <Input
                      id="forgot-email"
                      // Deliberately NOT `type="email"`, matching the sign-in
                      // field above. That type turns on native constraint
                      // validation, which blocks submit and shows the
                      // browser's own bubble — unstyled, inconsistent between
                      // browsers, and not reliably announced. Our refusal is
                      // `role="alert"` and wired to `aria-describedby`, which
                      // is the whole point of LUM-QA-001. `inputMode` still
                      // gives the right mobile keyboard.
                      inputMode="email"
                      autoFocus
                      autoComplete="email"
                      placeholder="you@company.com"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      aria-invalid={!!error}
                      aria-describedby={error ? ERROR_ID : undefined}
                    />
                  </div>

                  {error && <FormError message={error} />}

                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Mail className="size-4" />
                    )}
                    Email me a reset link
                  </Button>
                  <button
                    type="button"
                    onClick={backToSignIn}
                    className="flex items-center justify-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ArrowLeft className="size-3.5" />
                    Back to sign in
                  </button>
                </form>
              )}
            </div>
          )}

          {effectiveStep === "recover" && (
            <form onSubmit={setNewPassword} className="flex flex-col gap-4">
              <NewPasswordFields
                idPrefix="recover"
                next={nextPassword}
                again={nextAgain}
                onNext={setNextPassword}
                onAgain={setNextAgain}
              />

              {error && <FormError message={error} />}

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                Set password
              </Button>
              {/* Leaving spends the link, which is survivable — another can be
                  requested — and is better than trapping somebody on a screen
                  they reached by accident. */}
              <button
                type="button"
                onClick={backToSignIn}
                className="flex items-center justify-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                Back to sign in
              </button>
            </form>
          )}

          {(effectiveStep === "totp" || effectiveStep === "enroll") && (
            <div className="flex flex-col gap-4">
              {effectiveStep === "enroll" && loginEnrollment && (
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

              {effectiveStep === "totp" && (
                <div className="flex items-center justify-center gap-2 rounded-xl bg-muted/40 py-3 text-[13px] text-muted-foreground">
                  <ShieldCheck className="size-4 text-emerald-500" />
                  Protected by two-factor authentication
                </div>
              )}

              <div className="grid gap-1.5">
                <Label htmlFor="otp">
                  {effectiveStep === "enroll" ? "Enter the 6-digit code to confirm" : "6-digit code"}
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
                {effectiveStep === "enroll" ? "Verify & enable" : "Verify"}
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
          {effectiveStep === "password" && (
            <form onSubmit={choosePassword} className="flex flex-col gap-4">
              <NewPasswordFields
                idPrefix="first"
                next={nextPassword}
                again={nextAgain}
                onNext={setNextPassword}
                onAgain={setNextAgain}
              />

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

        {isDemo && effectiveStep === "credentials" && (
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

/**
 * Every refusal on this screen, announced and associated.
 *
 * It was an ordinary paragraph: visible, and invisible to anything that is not
 * a pair of eyes. An independent audit reproduced that (LUM-QA-001) — no
 * `role`, no live region, no `aria-describedby` from the fields it was about.
 *
 * `role="alert"` is implicitly `aria-live="assertive"`, which is right here and
 * would be wrong almost anywhere else: this refusal blocks the only action on
 * the screen, so interrupting is the correct behaviour rather than rudeness.
 */
const ERROR_ID = "login-error";

/**
 * The two "choose a password" steps, which are the same form.
 *
 * Shared so they cannot drift: one is the gate for a handed-out first
 * password, the other the end of a reset link, and a rule that held on one
 * but not the other would be found by whichever person hit the wrong one.
 */
function NewPasswordFields({
  idPrefix,
  next,
  again,
  onNext,
  onAgain,
}: {
  idPrefix: string;
  next: string;
  again: string;
  onNext: (value: string) => void;
  onAgain: (value: string) => void;
}) {
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-pw`}>New password</Label>
        <div className="relative">
          <Lock className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={`${idPrefix}-pw`}
            type="password"
            autoFocus
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className="pl-8"
            value={next}
            onChange={(e) => onNext(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-pw-again`}>Type it again</Label>
        <Input
          id={`${idPrefix}-pw-again`}
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => onAgain(e.target.value)}
        />
      </div>
    </>
  );
}

/**
 * A message that is not a refusal.
 *
 * `role="status"` is implicitly `aria-live="polite"`, which is the difference
 * that matters: "your password was updated" should be read when the reader
 * reaches a pause, not interrupt whatever it is saying. `FormError` is
 * `role="alert"` and red, and routing a success through it would be wrong in
 * the accessible layer as well as the visible one.
 */
function FormNotice({ message }: { message: string }) {
  return (
    <motion.p
      role="status"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg bg-emerald-500/10 px-3 py-2 text-[13px] text-emerald-700 dark:text-emerald-400"
    >
      {message}
    </motion.p>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <motion.p
      id={ERROR_ID}
      role="alert"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
    >
      {message}
    </motion.p>
  );
}
