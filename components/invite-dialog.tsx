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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSubmitOnce } from "@/components/use-submit-once";
import { rankOf } from "@/lib/permissions";
import { useStore } from "@/lib/store";

/**
 * Invite a teammate by email.
 *
 * The account is created server-side by an Edge Function — a browser cannot
 * do it, because creating one needs the service-role key. So unlike every
 * other dialog here, nothing lands optimistically: the invited person has no
 * profile until they accept, and showing a placeholder member would be a
 * claim the workspace cannot back up.
 */
export function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, userRole, inviteUser } = useStore();
  const [email, setEmail] = React.useState("");
  const [roleId, setRoleId] = React.useState("member");

  React.useEffect(() => {
    if (open) {
      setEmail("");
      setRoleId("member");
    }
  }, [open]);

  // Only roles at or below the inviter's own rank: the Edge Function refuses
  // anything higher and so does the database, so offering it would be an
  // invitation to be told no.
  const myRank = rankOf(userRole());
  const assignable = state.roles
    .filter((r) => rankOf(r) <= myRank)
    .sort((a, b) => rankOf(b) - rankOf(a));

  const sendOnce = async () => {
    const address = email.trim();
    if (!address || !address.includes("@")) {
      toast.error("Give a valid email address.");
      return;
    }
    const failure = await inviteUser(address, roleId);
    if (failure) {
      // The server's own sentence — "already in the workspace", "you can't
      // invite someone as Owner" — not a generic failure.
      toast.error("Couldn't invite them", { description: failure });
      return;
    }
    onOpenChange(false);
    toast.success(`Invitation sent to ${address}`, {
      description: "They'll set their own password from the email.",
    });
  };

  const [send, sending] = useSubmitOnce(sendOnce);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            They&apos;ll get an email and choose their own password.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              autoFocus
              value={email}
              placeholder="them@company.com"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignable.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void send()} disabled={sending}>
            {sending ? "Sending…" : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
