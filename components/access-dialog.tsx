"use client";

import * as React from "react";
import { Crown, Eye, Pencil, ShieldCheck, UserPlus, X } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { useUI } from "@/components/ui-context";
import { useStore } from "@/lib/store";
import type { AccessLevel, ResourceMember } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AccessDialog() {
  const { accessDialog, closeAccessDialog } = useUI();
  const { state, setChannelAccess, setProjectAccess } = useStore();

  const channel =
    accessDialog?.kind === "channel"
      ? state.channels.find((c) => c.id === accessDialog.id)
      : undefined;
  const project =
    accessDialog?.kind === "project"
      ? state.projects.find((p) => p.id === accessDialog.id)
      : undefined;
  const resource = channel ?? project;

  const [restricted, setRestricted] = React.useState(false);
  const [members, setMembers] = React.useState<ResourceMember[]>([]);
  const [addUserId, setAddUserId] = React.useState("");

  React.useEffect(() => {
    if (!accessDialog?.open || !resource) return;
    setRestricted(channel ? channel.isPrivate : !!project?.restricted);
    setMembers([...resource.members]);
    setAddUserId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessDialog?.open, accessDialog?.id]);

  if (!accessDialog || !resource) return null;

  const label = channel ? `#${channel.name}` : (project?.name ?? "");
  const creatorId = resource.createdBy;

  const availableUsers = state.users.filter(
    (u) => !members.some((m) => m.userId === u.id)
  );

  const setLevel = (userId: string, level: AccessLevel) =>
    setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, level } : m)));

  const removeMember = (userId: string) =>
    setMembers((prev) => prev.filter((m) => m.userId !== userId));

  const addMember = (userId: string) => {
    if (!userId) return;
    setMembers((prev) => [...prev, { userId, level: "viewer" }]);
    setAddUserId("");
  };

  const save = async () => {
    const ok = channel
      ? await setChannelAccess(channel.id, { isPrivate: restricted, members })
      : await setProjectAccess(project!.id, { restricted, members });
    if (!ok) return;
    toast.success(`Access updated for ${label}`);
    closeAccessDialog();
  };

  return (
    <Dialog open={accessDialog.open} onOpenChange={(o) => !o && closeAccessDialog()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage access — {label}</DialogTitle>
          <DialogDescription>
            {channel
              ? "Restrict this channel to specific people and choose what each of them can do."
              : "Restrict this project to specific people and choose what each of them can do."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="grid gap-0.5">
              <Label htmlFor="access-restrict" className="cursor-pointer">
                Restrict access
              </Label>
              <p className="text-[11px] text-muted-foreground">
                {channel
                  ? "Only invited people and admins can see this channel."
                  : "Only invited people and admins can see this project."}
              </p>
            </div>
            <Switch
              id="access-restrict"
              checked={restricted}
              onCheckedChange={setRestricted}
            />
          </div>

          {restricted && (
            <div className="grid gap-2">
              <Label>People with access</Label>
              <div className="overflow-hidden rounded-lg border">
                {members.map((m, i) => {
                  const user = state.users.find((u) => u.id === m.userId);
                  if (!user) return null;
                  const isCreator = m.userId === creatorId;
                  return (
                    <div
                      key={m.userId}
                      className={cn(
                        "flex items-center gap-2.5 bg-card px-3 py-2",
                        i > 0 && "border-t"
                      )}
                    >
                      <UserAvatar user={user} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                        {user.name}
                      </span>
                      {isCreator ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                              <Crown className="size-3" />
                              Owner
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            Owners always keep full editor access.
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <>
                          <Select
                            value={m.level}
                            onValueChange={(v) => setLevel(m.userId, v as AccessLevel)}
                          >
                            <SelectTrigger size="sm" className="h-7 w-24 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="editor">
                                <Pencil className="size-3" />
                                Editor
                              </SelectItem>
                              <SelectItem value="viewer">
                                <Eye className="size-3" />
                                Viewer
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            onClick={() => removeMember(m.userId)}
                          >
                            <X className="size-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  );
                })}
                {members.length === 0 && (
                  <p className="bg-card px-3 py-4 text-center text-[11px] text-muted-foreground">
                    Nobody has been invited yet.
                  </p>
                )}
              </div>

              {availableUsers.length > 0 && (
                <Select value={addUserId} onValueChange={addMember}>
                  <SelectTrigger className="h-8 text-xs">
                    <UserPlus className="size-3.5 text-muted-foreground" />
                    <SelectValue placeholder="Add a person…" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableUsers.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        <UserAvatar user={u} size="xs" />
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-[11px] text-muted-foreground">
                New invitees start as <span className="font-medium">Viewer</span>{" "}
                (read-only) — upgrade them to Editor for full access.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeAccessDialog}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            <ShieldCheck className="size-3.5" />
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
