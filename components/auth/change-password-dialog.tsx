"use client";

import * as React from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSubmitOnce } from "@/components/use-submit-once";
import { useAuth } from "@/lib/auth";
import { useUI } from "@/components/ui-context";

/**
 * Change your own password.
 *
 * WHY IT EXISTS. Accounts are created by an admin, who picks the first
 * password and reads it out. Without this dialog that password is permanent:
 * the Members screen promised "they can change it once they're in" and nothing
 * in the app could. This is the thing that makes the promise true.
 *
 * It changes YOUR password and cannot be pointed at anyone else — `updateUser`
 * acts on the session's own user. Setting somebody else's needs the secret key,
 * which is why that lives in `scripts/set-password.ps1`, outside the browser.
 *
 * No "current password" field. Supabase does not verify one here, so asking
 * would be theatre: a box whose contents are discarded, implying a check that
 * never happens. The session is the proof of identity, and a project that wants
 * more can turn on secure password change — whose refusal arrives as the
 * server's own message and is shown verbatim.
 */
export function ChangePasswordDialog() {
  const { passwordDialogOpen, setPasswordDialogOpen } = useUI();
  const { changePassword } = useAuth();
  const [next, setNext] = React.useState("");
  const [again, setAgain] = React.useState("");
  const [reveal, setReveal] = React.useState(false);

  React.useEffect(() => {
    if (passwordDialogOpen) {
      setNext("");
      setAgain("");
      setReveal(false);
    }
  }, [passwordDialogOpen]);

  const saveOnce = async () => {
    if (next.length < 8) {
      toast.error("Use a password of at least 8 characters.");
      return;
    }
    if (next !== again) {
      toast.error("The two passwords don't match.");
      return;
    }
    const failure = await changePassword(next);
    if (failure) {
      // The server's own sentence — "same as the old password", "reauthentication
      // needed" — not a generic failure. Those are the only ones you can act on.
      toast.error("Couldn't change your password", { description: failure });
      return;
    }
    setPasswordDialogOpen(false);
    toast.success("Password changed", {
      description: "Use the new one next time you sign in.",
    });
  };

  const [save, saving] = useSubmitOnce(saveOnce);

  /** Enter submits from either field, so the form needs no mouse. */
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void save();
  };

  return (
    <Dialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change your password</DialogTitle>
          <DialogDescription>
            It takes effect immediately. You&apos;ll stay signed in here.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="change-password-new">New password</Label>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setReveal((v) => !v)}
              >
                {reveal ? "Hide" : "Show"}
              </button>
            </div>
            <Input
              id="change-password-new"
              type={reveal ? "text" : "password"}
              autoFocus
              autoComplete="new-password"
              value={next}
              placeholder="At least 8 characters"
              onChange={(e) => setNext(e.target.value)}
              onKeyDown={onEnter}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="change-password-again">Type it again</Label>
            <Input
              id="change-password-again"
              type={reveal ? "text" : "password"}
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              onKeyDown={onEnter}
            />
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => setPasswordDialogOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? "Changing…" : "Change password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
