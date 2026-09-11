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
import { useUI } from "@/components/ui-context";
import { useStore } from "@/lib/store";

/**
 * Edit a person's details — name, handle, title.
 *
 * ONE DIALOG, TWO ENTRY POINTS: your own account menu, and the pencil on a
 * Members row for anybody with `members.manage`. Deliberately not two
 * components, because two would eventually validate differently and only one
 * of them would be the one somebody tested.
 *
 * Both permissions are the database's — `profiles_update_self` for your own
 * row, `profiles_admin_write` for everyone's — and the store mirrors them for
 * the message. Nothing here is the rule.
 *
 * Email is not editable. It is an auth credential rather than a profile field;
 * `profiles.email` only mirrors `auth.users`, so changing it here would
 * desynchronise the two and still leave the person signing in with the old
 * address.
 */
export function ProfileDialog() {
  const { profileDialog, closeProfileDialog } = useUI();
  const { state, updateProfile } = useStore();

  const person = state.users.find((u) => u.id === profileDialog?.userId);
  const open = !!profileDialog?.open && !!person;

  const [name, setName] = React.useState("");
  const [handle, setHandle] = React.useState("");
  const [title, setTitle] = React.useState("");

  React.useEffect(() => {
    if (open && person) {
      setName(person.name);
      setHandle(person.handle);
      setTitle(person.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profileDialog?.userId]);

  const isMe = person?.id === state.currentUserId;
  // Shown only when the handle actually changes — a standing warning would be
  // noise on every rename of a name.
  const handleChanged = !!person && handle.trim().toLowerCase() !== person.handle;

  const saveOnce = async () => {
    if (!person) return;
    const ok = await updateProfile(person.id, { name, handle, title });
    // The store says why it refused; don't close over a write that never
    // happened, and don't claim success for it.
    if (!ok) return;
    closeProfileDialog();
    toast.success(isMe ? "Your details are saved" : `${name.trim()} updated`);
  };

  const [save, saving] = useSubmitOnce(saveOnce);

  /** Enter submits from any field. */
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void save();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeProfileDialog()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isMe ? "Your details" : `Edit ${person?.name ?? ""}`}</DialogTitle>
          <DialogDescription>
            {isMe
              ? "How you appear to everyone in the workspace."
              : "How this person appears to everyone in the workspace."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              autoFocus
              value={name}
              placeholder="Jane Doe"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onEnter}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="profile-handle">Handle</Label>
            <div className="relative">
              <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-muted-foreground">
                @
              </span>
              <Input
                id="profile-handle"
                className="pl-6"
                value={handle}
                placeholder="janedoe"
                // Normalised as you type, the same way `handle_new_user`
                // derives one, so the field shows what will actually be
                // stored rather than refusing punctuation after the fact.
                onChange={(e) =>
                  setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24))
                }
                onKeyDown={onEnter}
              />
            </div>
            {handleChanged && (
              // Said where the decision is made. Mentions are plain text in
              // the message body, resolved against the current handle at
              // render time — so older ones stop matching.
              <p className="text-[12px] text-amber-600 dark:text-amber-400">
                Older messages mentioning <span className="font-medium">@{person?.handle}</span>{" "}
                will stop linking to {isMe ? "you" : "them"}.
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="profile-title">
              Title <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="profile-title"
              value={title}
              placeholder="Pension specialist"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={onEnter}
            />
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={closeProfileDialog}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
