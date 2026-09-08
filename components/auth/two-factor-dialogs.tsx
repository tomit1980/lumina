"use client";

import * as React from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { OtpInput } from "@/components/auth/otp-input";
import { TwoFactorQr } from "@/components/auth/two-factor-qr";
import { UserAvatar } from "@/components/user-avatar";
import { useUI } from "@/components/ui-context";
import { useAuth, type EnrollmentDraft } from "@/lib/auth";
import { useStore } from "@/lib/store";

/** Prompts for a TOTP code when switching into a 2FA-protected demo account.
 *
 *  Demo-only, and reached only through `requestSwitch`. Under the Supabase flag
 *  `components/providers.tsx` does not render this at all and `pendingSwitch`
 *  is permanently null, so there is no path that opens it. */
export function SwitchTwoFactorPrompt() {
  const { pendingSwitch, submitSwitchTotp, cancelSwitch } = useAuth();
  const { state } = useStore();

  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const user = state.users.find((u) => u.id === pendingSwitch);

  React.useEffect(() => {
    if (pendingSwitch) {
      setCode("");
      setError(false);
    }
  }, [pendingSwitch]);

  const verify = async (value = code) => {
    if (busy || value.length !== 6) return;
    setBusy(true);
    const ok = await submitSwitchTotp(value);
    setBusy(false);
    if (ok) {
      toast.success(`Switched to ${user?.name ?? "account"}`);
    } else {
      setError(true);
      setCode("");
    }
  };

  return (
    <Dialog open={!!pendingSwitch} onOpenChange={(o) => !o && cancelSwitch()}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader className="items-center text-center">
          {user && <UserAvatar user={user} size="lg" className="mb-1" />}
          <DialogTitle>Verify to continue</DialogTitle>
          <DialogDescription>
            {user?.name ?? "This account"} has two-factor enabled. Enter their current
            code.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <OtpInput
            value={code}
            onChange={(v) => {
              setCode(v);
              setError(false);
            }}
            onComplete={(v) => verify(v)}
            autoFocus
            disabled={busy}
            invalid={error}
          />
          {error && (
            <p className="text-center text-[13px] text-destructive">
              That code isn&apos;t valid. Try again.
            </p>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            className="w-full"
            onClick={() => verify()}
            disabled={busy || code.length !== 6}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Verify
          </Button>
          <Button variant="ghost" className="w-full" onClick={cancelSwitch}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Self-service 2FA setup, opened from the account menu. */
export function SelfEnrollDialog() {
  const { securityDialogOpen, setSecurityDialogOpen } = useUI();
  const { currentUser } = useStore();
  const { twoFactorStatus, beginSelfEnrollment, confirmSelfEnrollment } = useAuth();

  const status = twoFactorStatus(currentUser.id);
  const alreadyOn = status === "enrolled";

  const [draft, setDraft] = React.useState<EnrollmentDraft | null>(null);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Enrolling is a server round-trip now (`auth.mfa.enroll`), so the draft
  // arrives asynchronously and the dialog shows its skeleton until it does.
  React.useEffect(() => {
    if (!securityDialogOpen || alreadyOn) return;
    let cancelled = false;
    setDraft(null);
    setCode("");
    setError(false);
    void beginSelfEnrollment(currentUser.id).then((next) => {
      if (!cancelled) setDraft(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [securityDialogOpen, currentUser.id, alreadyOn]);

  const confirm = async (value = code) => {
    if (busy || !draft || value.length !== 6) return;
    setBusy(true);
    const ok = await confirmSelfEnrollment(draft, value);
    setBusy(false);
    if (ok) {
      toast.success("Two-factor authentication enabled");
      setSecurityDialogOpen(false);
    } else {
      setError(true);
      setCode("");
    }
  };

  return (
    <Dialog open={securityDialogOpen} onOpenChange={setSecurityDialogOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Two-factor authentication</DialogTitle>
          <DialogDescription>
            {alreadyOn
              ? "Your account is protected with an authenticator app."
              : "Add a second step to your sign-in with Google Authenticator or any TOTP app."}
          </DialogDescription>
        </DialogHeader>

        {alreadyOn ? (
          <div className="flex flex-col items-center gap-2 py-4">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-emerald-500/12">
              <ShieldCheck className="size-6 text-emerald-500" />
            </div>
            <p className="text-sm font-medium">Two-factor is on</p>
            <p className="text-center text-[13px] text-muted-foreground">
              An admin can reset or disable it for you from the People page.
            </p>
          </div>
        ) : (
          draft && (
            <div className="flex flex-col gap-4">
              <TwoFactorQr uri={draft.uri} secret={draft.secret} qrCode={draft.qrCode} />
              <div className="grid gap-1.5">
                <Label htmlFor="self-otp">Enter the 6-digit code to confirm</Label>
                <OtpInput
                  value={code}
                  onChange={(v) => {
                    setCode(v);
                    setError(false);
                  }}
                  onComplete={(v) => confirm(v)}
                  disabled={busy}
                  invalid={error}
                />
                {error && (
                  <p className="text-[13px] text-destructive">
                    That code isn&apos;t valid yet. Try again.
                  </p>
                )}
              </div>
            </div>
          )
        )}

        <DialogFooter>
          {alreadyOn ? (
            <Button className="w-full" onClick={() => setSecurityDialogOpen(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setSecurityDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => confirm()} disabled={busy || code.length !== 6}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                Enable
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
