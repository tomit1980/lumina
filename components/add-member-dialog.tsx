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
 * Add a teammate: their account exists the moment you press the button.
 *
 * You choose the first password and tell them what it is. That is a
 * deliberate trade for a workspace this size — the alternative, emailing an
 * invitation, depends on Supabase's shared mail service, which caps the free
 * tier at a handful of messages an hour and is the reason the first attempt
 * at this was rewritten.
 *
 * The account is created server-side by an Edge Function — a browser cannot
 * do it, because creating one needs the service-role key. So unlike every
 * other dialog here, nothing lands optimistically: the new profile is written
 * on the server and this store has not seen it, so inventing a member row
 * would be a guess at data the workspace already holds.
 */
export function AddMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, userRole, createUser } = useStore();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const [roleId, setRoleId] = React.useState("member");

  React.useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setPassword("");
      setReveal(false);
      setRoleId("member");
    }
  }, [open]);

  // Only roles at or below your own rank: the Edge Function refuses anything
  // higher and so does the database, so offering it would be an invitation to
  // be told no.
  const myRank = rankOf(userRole());
  const assignable = state.roles
    .filter((r) => rankOf(r) <= myRank)
    .sort((a, b) => rankOf(b) - rankOf(a));

  const addOnce = async () => {
    const address = email.trim();
    if (!address || !address.includes("@")) {
      toast.error("Give a valid email address.");
      return;
    }
    if (password.length < 8) {
      toast.error("Use a password of at least 8 characters.");
      return;
    }
    const failure = await createUser({
      email: address,
      password,
      roleId,
      name: name.trim() || undefined,
    });
    if (failure) {
      // The server's own sentence — "already in the workspace", "you can't
      // add someone as Owner" — not a generic failure.
      toast.error("Couldn't add them", { description: failure });
      return;
    }
    onOpenChange(false);
    toast.success(`${address} can sign in now`, {
      description: "Send them the password you chose — they can change it later.",
    });
  };

  const [add, adding] = useSubmitOnce(addOnce);

  /** Enter submits from any field, so the form does not need a mouse. */
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void add();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a teammate</DialogTitle>
          <DialogDescription>
            Their account is created straight away. Choose a password and pass it on —
            they can change it once they&apos;re in.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="add-member-email">Email</Label>
            <Input
              id="add-member-email"
              type="email"
              autoFocus
              value={email}
              placeholder="them@company.com"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={onEnter}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="add-member-name">
              Name <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="add-member-name"
              value={name}
              placeholder="Their name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onEnter}
            />
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="add-member-password">First password</Label>
              {/* Visible by design: you are about to read this out to someone,
                  and a masked field you cannot check is how a typo becomes an
                  account nobody can sign into. */}
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setReveal((v) => !v)}
              >
                {reveal ? "Hide" : "Show"}
              </button>
            </div>
            <Input
              id="add-member-password"
              type={reveal ? "text" : "password"}
              value={password}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onEnter}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="add-member-role">Role</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger id="add-member-role">
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
          <Button size="sm" onClick={() => void add()} disabled={adding}>
            {adding ? "Adding…" : "Add teammate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
