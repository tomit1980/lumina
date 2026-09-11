"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Lock,
  MessageCircle,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Shield,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RoleBadge } from "@/components/role-badge";
import { AddMemberDialog } from "@/components/add-member-dialog";
import { RoleDialog } from "@/components/role-dialog";
import { UserAvatar } from "@/components/user-avatar";
import { useAuth, type TwoFactorStatus } from "@/lib/auth";
import { backendKind } from "@/lib/backend";
import {
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_META,
  roleHas,
} from "@/lib/permissions";
import { useStore } from "@/lib/store";
import { useUI } from "@/components/ui-context";
import type { Permission, RoleDef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { dmHref } from "@/lib/routes";

const TWO_FACTOR_META: Record<
  TwoFactorStatus,
  { label: string; icon: typeof Shield; className: string }
> = {
  off: { label: "2FA off", icon: ShieldOff, className: "text-muted-foreground" },
  pending: {
    label: "2FA pending",
    icon: Shield,
    className: "text-amber-500",
  },
  enrolled: { label: "2FA on", icon: ShieldCheck, className: "text-emerald-500" },
};

function TwoFactorControl({
  userName,
  status,
  onRequire,
  onClearRequirement,
  onReset,
  onDisable,
}: {
  userName: string;
  status: TwoFactorStatus;
  onRequire: () => void;
  onClearRequirement: () => void;
  onReset: () => void;
  onDisable: () => void;
}) {
  const meta = TWO_FACTOR_META[status];
  const Icon = meta.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 gap-1.5 px-2.5 text-[11px]", meta.className)}
        >
          <Icon className="size-3.5" />
          {meta.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          Two-factor for {userName}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {status === "off" && (
          <DropdownMenuItem onSelect={onRequire}>
            <ShieldCheck className="size-4 text-emerald-500" />
            Require two-factor
          </DropdownMenuItem>
        )}
        {status === "pending" && (
          <>
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              Required — they&apos;ll set it up at next sign-in.
            </div>
            <DropdownMenuItem onSelect={onClearRequirement}>
              <ShieldOff className="size-4" />
              Cancel requirement
            </DropdownMenuItem>
          </>
        )}
        {status === "enrolled" && (
          <>
            <DropdownMenuItem onSelect={onReset}>
              <RotateCcw className="size-4" />
              Reset (re-enroll)
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDisable}>
              <ShieldOff className="size-4" />
              Disable two-factor
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PermissionCell({
  role,
  permission,
  editable,
  onToggle,
}: {
  role: RoleDef;
  permission: Permission;
  editable: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const granted = roleHas(role, permission);

  if (role.locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="flex items-center justify-center gap-0.5"
            style={{ color: role.color }}
          >
            <Check className="size-3.5" />
            <Lock className="size-2.5 opacity-50" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{role.name} always has full access.</TooltipContent>
      </Tooltip>
    );
  }

  if (!editable) {
    return (
      <span className="flex justify-center">
        {granted ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Minus className="size-3.5 text-muted-foreground/40" />
        )}
      </span>
    );
  }

  return (
    <span className="flex justify-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onToggle(!granted)}
            aria-label={`${granted ? "Revoke" : "Grant"} “${PERMISSION_META[permission].label}” for ${role.name}`}
            className={cn(
              "flex size-6 items-center justify-center rounded-md transition-all",
              granted
                ? "bg-emerald-500/12 text-emerald-500 hover:bg-emerald-500/20"
                : "text-muted-foreground/40 hover:bg-muted hover:text-foreground"
            )}
          >
            {granted ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{granted ? "Click to revoke" : "Click to grant"}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/**
 * The workspace's people and roles, as two sections of the Settings page.
 *
 * This was `app/people/page.tsx` in its entirety. It moved rather than being
 * rewritten — the member list, the role list, the permission matrix and the
 * two-factor controls are the same code — because Settings absorbing People
 * is a change of address, not of behaviour. `/people` still resolves; it
 * redirects here.
 */
export function WorkspacePeople({ section }: { section: "members" | "roles" }) {
  const router = useRouter();
  const {
    state,
    currentUser,
    can,
    userRole,
    getRole,
    setUserRole,
    setRolePermission,
    deleteRole,
    openDm,
  } = useStore();
  const {
    twoFactorStatus,
    requireTwoFactor,
    clearTwoFactorRequirement,
    resetTwoFactor,
    disableTwoFactor,
  } = useAuth();
  const { openProfileDialog } = useUI();

  const manageRoles = can("members.manage");
  const roles = state.roles;

  const [roleDialogOpen, setRoleDialogOpen] = React.useState(false);
  const [addMemberOpen, setAddMemberOpen] = React.useState(false);
  const [editingRole, setEditingRole] = React.useState<RoleDef | undefined>();

  const memberCount = (roleId: string) =>
    state.users.filter((u) => u.roleId === roleId).length;

  const messageUser = async (userId: string) => {
    // openDm resolves null when the thread couldn't be created — never
    // navigate to a conversation that doesn't exist.
    const dm = await openDm(userId);
    if (!dm) return;
    router.push(dmHref(dm.id));
  };

  const togglePermission = async (
    role: RoleDef,
    permission: Permission,
    enabled: boolean
  ) => {
    if (!(await setRolePermission(role.id, permission, enabled))) return;
    toast.success(
      `${role.name}s ${enabled ? "can now" : "can no longer"} ${PERMISSION_META[
        permission
      ].label.toLowerCase()}`
    );
  };

  const matrixCols = { gridTemplateColumns: `1fr repeat(${roles.length}, 4.2rem)` };

  return (
    <>
      {section === "members" && (
        <>
        {/* Creating an account goes through an Edge Function, because it
            needs the service-role key and a browser cannot hold one. Offered
            only on the real backend: the demo has no server to create anyone
            on, and `LocalBackend.createUser` rejects rather than pretending. */}
        {manageRoles && backendKind === "supabase" && (
          <div className="mb-4 flex items-center justify-between">
            <p className="text-[12px] text-muted-foreground">
              You choose their first password; they can change it from their own
              account menu.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setAddMemberOpen(true)}
            >
              <Plus className="size-3.5" />
              Add teammate
            </Button>
          </div>
        )}
        <AddMemberDialog open={addMemberOpen} onOpenChange={setAddMemberOpen} />
        <div className="overflow-hidden rounded-xl border">
          {state.users.map((user, i) => {
            const isMe = user.id === currentUser.id;
            const role = userRole(user);
            return (
              <div
                key={user.id}
                className={cn(
                  "flex items-center gap-3 bg-card px-4 py-3",
                  i > 0 && "border-t"
                )}
              >
                <button
                  onClick={() => { if (!isMe) void messageUser(user.id); }}
                  className={cn(!isMe && "transition-transform hover:scale-105")}
                  disabled={isMe}
                >
                  <UserAvatar user={user} size="lg" showPresence />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { if (!isMe) void messageUser(user.id); }}
                      disabled={isMe}
                      className={cn(
                        "truncate text-[13px] font-semibold",
                        !isMe && "hover:underline"
                      )}
                    >
                      {user.name}
                    </button>
                    <span className="text-[11px] text-muted-foreground">
                      @{user.handle}
                    </span>
                    {isMe && (
                      <Badge className="bg-primary/10 text-[10px] text-primary">you</Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{user.title}</p>
                </div>

                {!isMe && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-foreground"
                        onClick={() => void messageUser(user.id)}
                      >
                        <MessageCircle className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Message {user.name.split(" ")[0]}</TooltipContent>
                  </Tooltip>
                )}
                {/* Two-factor is real only on a real backend: the local demo
                    has no server to verify a code against (see lib/auth.tsx),
                    so the control is not rendered there rather than offering
                    buttons that would do nothing. */}
                {manageRoles && backendKind === "supabase" && (
                  <TwoFactorControl
                    userName={user.name.split(" ")[0]}
                    status={twoFactorStatus(user.id)}
                    // QA-119: each of these awaits its write before saying it
                    // happened. They used to fire the green toast the instant
                    // the switch moved, so a refused write produced
                    // "Two-factor required for Dana" followed by a red
                    // contradiction — while every other control on this page
                    // already checked its return value first. The action
                    // shows its own error toast, so a failure here is silent
                    // rather than doubled.
                    onRequire={async () => {
                      if (!(await requireTwoFactor(user.id))) return;
                      toast.success(`Two-factor required for ${user.name}`, {
                        description: "They'll set it up at their next sign-in.",
                      });
                    }}
                    onClearRequirement={async () => {
                      if (!(await clearTwoFactorRequirement(user.id))) return;
                      toast(`Two-factor requirement cleared for ${user.name}`);
                    }}
                    onReset={async () => {
                      if (!(await resetTwoFactor(user.id))) return;
                      toast.success(`Two-factor reset for ${user.name}`, {
                        description: "They'll re-enroll at their next sign-in.",
                      });
                    }}
                    onDisable={async () => {
                      if (!(await disableTwoFactor(user.id))) return;
                      toast(`Two-factor disabled for ${user.name}`);
                    }}
                  />
                )}
                {/* Edit their details. Offered for everyone including
                    yourself — an admin correcting their own name should not
                    have to go to a different screen for it. The store and the
                    database both allow the self case anyway. */}
                {manageRoles && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label={`Edit ${user.name}'s details`}
                        onClick={() => openProfileDialog(user.id)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit {user.name}&apos;s details</TooltipContent>
                  </Tooltip>
                )}
                {manageRoles && !isMe ? (
                  <Select
                    value={user.roleId}
                    onValueChange={async (roleId) => {
                      if (!(await setUserRole(user.id, roleId))) return;
                      const next = getRole(roleId);
                      toast.success(`${user.name} is now a ${next.name}`, {
                        description: next.description,
                      });
                    }}
                  >
                    <SelectTrigger size="sm" className="h-8 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          <span
                            className="mr-1.5 inline-block size-2 rounded-full"
                            style={{ backgroundColor: r.color }}
                          />
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <RoleBadge role={role} className="text-[11px]" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-56">
                      {isMe && manageRoles
                        ? "You can't change your own role."
                        : role.description}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}

      {section === "roles" && (
        <>
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">Roles</h2>
          {manageRoles && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => {
                setEditingRole(undefined);
                setRoleDialogOpen(true);
              }}
            >
              <Plus className="size-3.5" />
              New role
            </Button>
          )}
        </div>
        <div className="mt-2 overflow-hidden rounded-xl border">
          {roles.map((role, i) => {
            const count = memberCount(role.id);
            return (
              <div
                key={role.id}
                className={cn(
                  "flex items-center gap-3 bg-card px-4 py-2.5",
                  i > 0 && "border-t"
                )}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: role.color }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold">{role.name}</span>
                    {role.locked && (
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <Lock className="size-2.5" /> Locked
                      </Badge>
                    )}
                    {role.isSystem && !role.locked && (
                      <Badge variant="outline" className="text-[10px]">
                        Built-in
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {role.description || "No description"}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {count} {count === 1 ? "member" : "members"} ·{" "}
                  {role.locked ? "all" : role.permissions.length} perms
                </span>
                {manageRoles && !role.locked && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setEditingRole(role);
                          setRoleDialogOpen(true);
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit role</TooltipContent>
                  </Tooltip>
                )}
                {manageRoles && !role.isSystem && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        onClick={async () => {
                          if (count > 0) {
                            toast.error("This role still has members", {
                              description: "Reassign them to another role first.",
                            });
                            return;
                          }
                          if (!(await deleteRole(role.id))) return;
                          toast.success(`Role “${role.name}” deleted`);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete role</TooltipContent>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>

        {/* Permission matrix */}
        <div className="mt-8 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold">Permission matrix</h2>
          {manageRoles && (
            <span className="text-[11px] text-muted-foreground">
              Click a cell to grant or revoke — changes apply instantly.
            </span>
          )}
        </div>
        <div className="mt-2 overflow-x-auto rounded-xl border">
          <div className="min-w-max">
            <div
              className="grid items-center gap-2 border-b bg-muted/50 px-4 py-2 text-[11px] font-semibold text-muted-foreground"
              style={matrixCols}
            >
              <span>Capability</span>
              {roles.map((r) => (
                <span key={r.id} className="truncate text-center" style={{ color: r.color }}>
                  {r.name}
                </span>
              ))}
            </div>
            {PERMISSION_GROUPS.map((group) => (
              <div key={group}>
                <div className="border-t bg-muted/30 px-4 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  {group}
                </div>
                {ALL_PERMISSIONS.filter((p) => PERMISSION_META[p].group === group).map(
                  (permission) => (
                    <div
                      key={permission}
                      className="grid items-center gap-2 border-t bg-card px-4 py-1.5 text-xs"
                      style={matrixCols}
                    >
                      <span>{PERMISSION_META[permission].label}</span>
                      {roles.map((role) => (
                        <PermissionCell
                          key={role.id}
                          role={role}
                          permission={permission}
                          editable={manageRoles}
                          onToggle={(enabled) =>
                            void togglePermission(role, permission, enabled)
                          }
                        />
                      ))}
                    </div>
                  )
                )}
              </div>
            ))}
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Every action is enforced in the store, not just hidden in the UI. Direct
          messages are always available. Tip: ⌘K → “View as” to experience Lumina as
          any role.
        </p>
        <RoleDialog
          open={roleDialogOpen}
          onOpenChange={setRoleDialogOpen}
          editRole={editingRole}
        />
        </>
      )}
    </>
  );
}
