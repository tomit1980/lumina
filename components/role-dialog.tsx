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
  ALL_PERMISSIONS,
  PERMISSION_META,
  ROLE_COLORS,
} from "@/lib/permissions";
import { useStore } from "@/lib/store";
import type { Permission, RoleDef } from "@/lib/types";
import { cn } from "@/lib/utils";

export function RoleDialog({
  open,
  onOpenChange,
  editRole,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this role instead of creating one. */
  editRole?: RoleDef;
}) {
  const { state, createRole, updateRole } = useStore();

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [color, setColor] = React.useState(ROLE_COLORS[0]);
  const [permissions, setPermissions] = React.useState<Permission[]>([]);

  React.useEffect(() => {
    if (!open) return;
    if (editRole) {
      setName(editRole.name);
      setDescription(editRole.description);
      setColor(editRole.color);
      setPermissions([...editRole.permissions]);
    } else {
      const member = state.roles.find((r) => r.id === "member");
      setName("");
      setDescription("");
      setColor(ROLE_COLORS[3]);
      setPermissions(member ? [...member.permissions] : ["message.send"]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editRole?.id]);

  const togglePermission = (p: Permission) =>
    setPermissions((perms) =>
      perms.includes(p) ? perms.filter((x) => x !== p) : [...perms, p]
    );

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the role a name first.");
      return;
    }
    const clash = state.roles.some(
      (r) => r.name.toLowerCase() === trimmed.toLowerCase() && r.id !== editRole?.id
    );
    if (clash) {
      toast.error(`A role called “${trimmed}” already exists.`);
      return;
    }
    if (editRole) {
      const ok = await updateRole(editRole.id, {
        name: trimmed,
        description: description.trim(),
        color,
        permissions,
      });
      if (!ok) return;
      toast.success(`Role “${trimmed}” updated`);
    } else {
      const role = await createRole({
        name: trimmed,
        description: description.trim(),
        color,
        permissions,
      });
      if (!role) return;
      toast.success(`Role “${trimmed}” created`, {
        description: "Assign it to teammates from the People page.",
      });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editRole ? `Edit ${editRole.name}` : "New role"}</DialogTitle>
          <DialogDescription>
            {editRole
              ? "Rename the role, restyle it, or adjust what it can do."
              : "Custom roles let you hand out exactly the access a group needs."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                autoFocus
                placeholder="e.g. Moderator"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Color</Label>
              <div className="flex gap-1">
                {ROLE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={cn(
                      "size-5 rounded-full transition-transform hover:scale-110",
                      color === c &&
                        "ring-2 ring-foreground/60 ring-offset-2 ring-offset-background"
                    )}
                    style={{ backgroundColor: c }}
                    aria-label={`Use color ${c}`}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="role-desc">Description</Label>
            <Input
              id="role-desc"
              placeholder="What is this role for?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Permissions</Label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_PERMISSIONS.map((p) => {
                const active = permissions.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePermission(p)}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px] font-medium transition-all",
                      active
                        ? "bg-primary/12 text-primary ring-1 ring-primary/30"
                        : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                    )}
                  >
                    {PERMISSION_META[p].label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {permissions.length} of {ALL_PERMISSIONS.length} permissions granted.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            {editRole ? "Save changes" : "Create role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
