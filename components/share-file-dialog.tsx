"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileText, Hash, Lock, Megaphone, Share2 } from "lucide-react";
import { toast } from "sonner";

import { useAttachmentUrl } from "@/components/attachment-url";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
import { useUI } from "@/components/ui-context";
import { formatBytes, isStorageRef } from "@/lib/attachments";
import { chatHref, dmHref } from "@/lib/routes";
import { useStore } from "@/lib/store";
import type { MessageAttachment } from "@/lib/types";

/** "Share to chat" for a project file: posts a *reference* to the file into a
 *  channel or a DM (no bytes are copied — see MessageAttachment). */
export function ShareFileDialog() {
  const { shareFileDialog, closeShareFileDialog } = useUI();
  const { state, currentUser, canSeeChannel, channelAccessLevel, sendMessage, sendToUser } =
    useStore();
  const router = useRouter();
  // "channel:<id>" | "user:<id>"
  const [target, setTarget] = React.useState("");
  const [note, setNote] = React.useState("");
  const project = shareFileDialog
    ? state.projects.find((p) => p.id === shareFileDialog.projectId)
    : undefined;
  const file = project?.attachments.find((a) => a.id === shareFileDialog?.attachmentId);
  // Before the early return below, because it is a hook. `""` when there is no
  // file resolves to no URL and renders nothing, which is what a closed dialog
  // should show anyway.
  const preview = useAttachmentUrl(file?.dataUrl ?? "");

  React.useEffect(() => {
    if (shareFileDialog?.open) {
      setTarget("");
      setNote("");
    }
  }, [shareFileDialog?.open, shareFileDialog?.attachmentId]);

  if (!shareFileDialog || !project || !file) return null;

  const channels = state.channels
    .filter((c) => canSeeChannel(c) && channelAccessLevel(c) === "editor")
    .sort((a, b) => Number(Boolean(b.isTeam)) - Number(Boolean(a.isTeam)));
  const people = state.users.filter((u) => u.id !== currentUser.id);
  const isImage = file.type.startsWith("image/");

  const share = async () => {
    const [kind, id] = target.split(":");
    if (!kind || !id) return;
    // The reference is kept when it points at Storage and blanked when it is
    // the bytes themselves. Both mean the same thing — "no second copy" — but
    // locally that has to be an empty `dataUrl` resolved back through the
    // project (see resolveMessageAttachment), while on the real backend the
    // path is what makes the shared file render before the next hydrate.
    const payload: MessageAttachment = {
      ...file,
      dataUrl: isStorageRef(file.dataUrl) ? file.dataUrl : "",
      sourceProjectId: project.id,
    };
    let label: string;
    let href: string;
    if (kind === "channel") {
      const channel = channels.find((c) => c.id === id);
      if (!channel) return;
      if (!(await sendMessage(channel.id, note.trim(), [payload]))) return;
      label = `#${channel.name}`;
      href = chatHref(channel.id);
    } else {
      const user = people.find((u) => u.id === id);
      if (!user) return;
      const dm = await sendToUser(user.id, note.trim(), [payload]);
      if (!dm) return;
      label = user.name;
      href = dmHref(dm.id);
    }
    toast.success(`Shared “${file.name}” to ${label}`, {
      action: { label: "Open", onClick: () => router.push(href) },
    });
    closeShareFileDialog();
  };

  return (
    <Dialog open={shareFileDialog.open} onOpenChange={(o) => !o && closeShareFileDialog()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share to chat</DialogTitle>
          <DialogDescription>
            Post this file into a channel or a direct message. It stays linked to{" "}
            {project.emoji} {project.name}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-2.5 py-2">
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="" className="size-10 shrink-0 rounded-md object-cover" />
            ) : (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                <FileText className="size-4 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">{file.name}</div>
              <div className="text-[11px] text-muted-foreground">{formatBytes(file.size)}</div>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="share-target">Send to</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger id="share-target" className="w-full">
                <SelectValue placeholder="Pick a channel or a person" />
              </SelectTrigger>
              <SelectContent>
                {channels.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Channels</SelectLabel>
                    {channels.map((c) => (
                      <SelectItem key={c.id} value={`channel:${c.id}`}>
                        <span className="flex items-center gap-1.5">
                          {c.isTeam ? (
                            <Megaphone className="size-3.5 text-muted-foreground" />
                          ) : c.isPrivate ? (
                            <Lock className="size-3.5 text-muted-foreground" />
                          ) : (
                            <Hash className="size-3.5 text-muted-foreground" />
                          )}
                          {c.isTeam ? "Team" : c.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                <SelectGroup>
                  <SelectLabel>People</SelectLabel>
                  {people.map((u) => (
                    <SelectItem key={u.id} value={`user:${u.id}`}>
                      <span className="flex items-center gap-1.5">
                        <UserAvatar user={u} size="xs" />
                        {u.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="share-note">Message (optional)</Label>
            <Textarea
              id="share-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note…"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeShareFileDialog}>
            Cancel
          </Button>
          <Button onClick={share} disabled={!target}>
            <Share2 className="size-4" />
            Share
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
