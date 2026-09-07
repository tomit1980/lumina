"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Bell,
  CalendarPlus,
  ChevronsUpDown,
  Command as CommandIcon,
  Hash,
  Home,
  Lock,
  LogOut,
  Megaphone,
  Menu,
  MoreHorizontal,
  Moon,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import { toast } from "sonner";

import { downloadICS, slugify, tasksToICS } from "@/lib/calendar";
import {
  getReminderSound,
  notificationPermission,
  setReminderSound,
} from "@/components/reminders";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RoleBadge } from "@/components/role-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { useUI } from "@/components/ui-context";
import { useAuth } from "@/lib/auth";
import { getUnreadCount, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { chatHref, dmHref, projectHref, useCurrentRoute, useIsViewing } from "@/lib/routes";

function NavLink({
  href,
  active,
  children,
  onNavigate,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        "group flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      )}
    >
      {children}
    </Link>
  );
}

/** Hover-reveal ⋯ menu overlaid on a sidebar row, with optional Edit + Access + Delete. */
function RowMenu({
  label,
  onEdit,
  onManageAccess,
  onDelete,
}: {
  label: string;
  onEdit?: () => void;
  onManageAccess?: () => void;
  onDelete?: () => void;
}) {
  if (!onEdit && !onManageAccess && !onDelete) return null;
  return (
    <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`Options for ${label}`}
            onClick={(e) => e.stopPropagation()}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent-foreground/10 hover:text-foreground"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {onEdit && (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="size-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onManageAccess && (
            <DropdownMenuItem onSelect={onManageAccess}>
              <ShieldCheck className="size-4" />
              Manage access
            </DropdownMenuItem>
          )}
          {onDelete && (
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SectionHeader({
  label,
  onAdd,
  addTooltip,
}: {
  label: string;
  onAdd?: () => void;
  addTooltip?: string;
}) {
  return (
    <div className="mt-5 mb-1 flex h-6 items-center justify-between px-2.5">
      <span className="text-[11px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
        {label}
      </span>
      {onAdd && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 text-muted-foreground hover:text-foreground"
              aria-label={addTooltip}
              onClick={onAdd}
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{addTooltip}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useCurrentRoute();
  const viewing = useIsViewing();
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const {
    setPaletteOpen,
    setChannelDialogOpen,
    openProjectDialog,
    setDmDialogOpen,
    setSecurityDialogOpen,
    openAccessDialog,
  } = useUI();
  const {
    state,
    currentUser,
    can,
    canSeeChannel,
    canDeleteChannel,
    canSeeProject,
    userRole,
    deleteChannel,
    deleteProject,
    resetDemo,
  } = useStore();
  const { requestSwitch, twoFactorStatus, logout, resetAll } = useAuth();
  const selfTwoFactor = twoFactorStatus(currentUser.id);

  // Reminder preferences (read from localStorage on the client after mount).
  const [soundOn, setSoundOn] = React.useState(true);
  const [notifPerm, setNotifPerm] =
    React.useState<NotificationPermission | "unsupported">("default");
  React.useEffect(() => {
    setSoundOn(getReminderSound());
    setNotifPerm(notificationPermission());
  }, []);

  const myScheduledTasks = React.useMemo(
    () =>
      state.tasks.filter(
        (t) =>
          t.dueDate != null &&
          (t.assigneeId === currentUser.id ||
            (t.assigneeId == null && t.createdBy === currentUser.id))
      ),
    [state.tasks, currentUser.id]
  );

  const exportMySchedule = () => {
    if (myScheduledTasks.length === 0) {
      toast("Nothing scheduled yet", {
        description: "Give a task a due date to add it to your calendar.",
      });
      return;
    }
    downloadICS(
      `${slugify(currentUser.name)}-schedule`,
      tasksToICS(myScheduledTasks, `${currentUser.name} — Lumina`)
    );
    toast.success("Schedule exported", {
      description: `${myScheduledTasks.length} task${
        myScheduledTasks.length === 1 ? "" : "s"
      } · open the .ics to import into your calendar`,
    });
  };

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setReminderSound(next);
    toast(next ? "Reminder sounds on" : "Reminder sounds muted");
  };

  const enableNotifications = () => {
    if (typeof Notification === "undefined") return;
    void Notification.requestPermission().then((p) => {
      setNotifPerm(p);
      if (p === "granted") toast.success("Desktop notifications enabled");
      else if (p === "denied")
        toast("Notifications blocked", {
          description: "You can re-enable them in your browser settings.",
        });
    });
  };

  // Pending destructive action awaiting confirmation.
  const [confirm, setConfirm] = React.useState<
    | { kind: "channel"; id: string; name: string; messageCount: number }
    | { kind: "project"; id: string; name: string; taskCount: number }
    | null
  >(null);

  const runDelete = () => {
    if (!confirm) return;
    const viewingIt =
      confirm.kind === "channel"
        ? viewing("/chat", confirm.id)
        : viewing("/projects", confirm.id);
    if (confirm.kind === "channel") {
      deleteChannel(confirm.id);
      toast.success(`Channel #${confirm.name} deleted`);
    } else {
      deleteProject(confirm.id);
      toast.success(`Project “${confirm.name}” deleted`);
    }
    if (viewingIt) router.push("/");
  };

  const teamChannel = state.channels.find((c) => c.isTeam);
  const channels = state.channels.filter((c) => canSeeChannel(c) && !c.isTeam);
  const visibleProjects = state.projects.filter((p) => canSeeProject(p));

  const lastActivity = (conversationId: string, fallback: number) =>
    state.messages.reduce(
      (acc, m) => (m.channelId === conversationId ? Math.max(acc, m.createdAt) : acc),
      fallback
    );
  const myDms = state.dms
    .filter((d) => d.memberIds.includes(currentUser.id))
    .map((d) => ({
      dm: d,
      other: state.users.find(
        (u) => d.memberIds.includes(u.id) && u.id !== currentUser.id
      ),
    }))
    .filter((x): x is { dm: (typeof state.dms)[number]; other: (typeof state.users)[number] } => !!x.other)
    .sort(
      (a, b) =>
        lastActivity(b.dm.id, b.dm.createdAt) - lastActivity(a.dm.id, a.dm.createdAt)
    );
  const isMac =
    typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* Workspace header */}
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/25">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight">Lumina</div>
          <div className="truncate text-[11px] text-muted-foreground">Northlight Studio</div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label="Open command palette"
              onClick={() => setPaletteOpen(true)}
            >
              <CommandIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            Command palette · {isMac ? "⌘" : "Ctrl+"}K
          </TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2.5">
        <nav className="flex flex-col gap-0.5 pt-2">
          <NavLink href="/" active={pathname === "/"} onNavigate={onNavigate}>
            <Home className="size-4" />
            Home
          </NavLink>
          <NavLink href="/people" active={pathname === "/people"} onNavigate={onNavigate}>
            <Users className="size-4" />
            People
            <span className="ml-auto text-[11px] text-muted-foreground">
              {state.users.length}
            </span>
          </NavLink>
          {teamChannel && (
            <NavLink
              href={chatHref(teamChannel.id)}
              active={viewing("/chat", teamChannel.id)}
              onNavigate={onNavigate}
            >
              <Megaphone className="size-4 shrink-0" />
              <span
                className={cn(
                  "truncate",
                  (() => {
                    const unread = getUnreadCount(state, currentUser.id, teamChannel.id);
                    return (
                      unread > 0 &&
                      !viewing("/chat", teamChannel.id) &&
                      "font-semibold text-foreground"
                    );
                  })()
                )}
              >
                Team
              </span>
              {(() => {
                const unread = getUnreadCount(state, currentUser.id, teamChannel.id);
                const active = viewing("/chat", teamChannel.id);
                return unread > 0 && !active ? (
                  <Badge className="ml-auto h-4.5 min-w-4.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                    {unread}
                  </Badge>
                ) : (
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    All {state.users.length}
                  </span>
                );
              })()}
            </NavLink>
          )}
        </nav>

        <SectionHeader
          label="Channels"
          onAdd={
            can("channel.create")
              ? () => setChannelDialogOpen(true)
              : undefined
          }
          addTooltip="New channel"
        />
        <nav className="flex flex-col gap-0.5">
          {channels.map((channel) => {
            const unread = getUnreadCount(state, currentUser.id, channel.id);
            const active = viewing("/chat", channel.id);
            const manageable = canDeleteChannel(channel);
            const deletable = manageable && channel.name !== "general";
            return (
              <div key={channel.id} className="group/row relative">
                <NavLink
                  href={chatHref(channel.id)}
                  active={active}
                  onNavigate={onNavigate}
                >
                  {channel.isPrivate ? (
                    <Lock className="size-4 shrink-0" />
                  ) : (
                    <Hash className="size-4 shrink-0" />
                  )}
                  <span
                    className={cn(
                      "truncate",
                      unread > 0 && !active && "font-semibold text-foreground"
                    )}
                  >
                    {channel.name}
                  </span>
                  {unread > 0 && !active && (
                    <Badge
                      className={cn(
                        "ml-auto h-4.5 min-w-4.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground",
                        manageable && "group-hover/row:opacity-0"
                      )}
                    >
                      {unread}
                    </Badge>
                  )}
                </NavLink>
                {manageable && (
                  <RowMenu
                    label={`#${channel.name}`}
                    onManageAccess={() => openAccessDialog("channel", channel.id)}
                    onDelete={
                      deletable
                        ? () =>
                            setConfirm({
                              kind: "channel",
                              id: channel.id,
                              name: channel.name,
                              messageCount: state.messages.filter(
                                (m) => m.channelId === channel.id
                              ).length,
                            })
                        : undefined
                    }
                  />
                )}
              </div>
            );
          })}
        </nav>

        <SectionHeader
          label="Direct messages"
          onAdd={() => setDmDialogOpen(true)}
          addTooltip="New message"
        />
        <nav className="flex flex-col gap-0.5">
          {myDms.map(({ dm, other }) => {
            const unread = getUnreadCount(state, currentUser.id, dm.id);
            const active = viewing("/dm", dm.id);
            return (
              <NavLink
                key={dm.id}
                href={dmHref(dm.id)}
                active={active}
                onNavigate={onNavigate}
              >
                <UserAvatar user={other} size="xs" showPresence />
                <span
                  className={cn(
                    "truncate",
                    unread > 0 && !active && "font-semibold text-foreground"
                  )}
                >
                  {other.name}
                </span>
                {unread > 0 && !active && (
                  <Badge className="ml-auto h-4.5 min-w-4.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                    {unread}
                  </Badge>
                )}
              </NavLink>
            );
          })}
          {myDms.length === 0 && (
            <button
              onClick={() => setDmDialogOpen(true)}
              className="mx-2.5 rounded-lg border border-dashed px-2.5 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
            >
              Message a teammate…
            </button>
          )}
        </nav>

        <SectionHeader
          label="Projects"
          onAdd={
            can("project.create") ? () => openProjectDialog() : undefined
          }
          addTooltip="New project"
        />
        <nav className="mb-4 flex flex-col gap-0.5">
          {visibleProjects.map((project) => (
            <div key={project.id} className="group/row relative">
              <NavLink
                href={projectHref(project.id)}
                active={viewing("/projects", project.id)}
                onNavigate={onNavigate}
              >
                <span
                  className="flex size-4 items-center justify-center rounded text-[11px]"
                  style={{ backgroundColor: `${project.color}22` }}
                >
                  {project.emoji}
                </span>
                <span className="truncate">{project.name}</span>
              </NavLink>
              <RowMenu
                label={project.name}
                onEdit={
                  can("project.create")
                    ? () => openProjectDialog(project.id)
                    : undefined
                }
                onManageAccess={
                  can("project.create")
                    ? () => openAccessDialog("project", project.id)
                    : undefined
                }
                onDelete={
                  can("project.delete")
                    ? () =>
                        setConfirm({
                          kind: "project",
                          id: project.id,
                          name: project.name,
                          taskCount: state.tasks.filter(
                            (t) => t.projectId === project.id
                          ).length,
                        })
                    : undefined
                }
              />
            </div>
          ))}
          {visibleProjects.length === 0 && (
            <p className="px-2.5 py-1 text-[11px] text-muted-foreground">
              No projects yet.
            </p>
          )}
        </nav>
      </ScrollArea>

      {/* Current user */}
      <div className="border-t border-sidebar-border p-2.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-sidebar-accent">
              <UserAvatar user={currentUser} size="md" showPresence />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{currentUser.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {currentUser.title}
                </div>
              </div>
              <RoleBadge role={userRole()} />
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <DropdownMenuLabel className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              View as — demo the roles
            </DropdownMenuLabel>
            {state.users.map((u) => (
              <DropdownMenuItem
                key={u.id}
                disabled={u.id === currentUser.id}
                onSelect={() => {
                  const needs2fa = twoFactorStatus(u.id) === "enrolled";
                  requestSwitch(u.id);
                  if (!needs2fa) {
                    toast(`Now viewing as ${u.name}`, {
                      description: userRole(u).description,
                    });
                  }
                }}
              >
                <UserAvatar user={u} size="xs" />
                <span className="flex-1">{u.name}</span>
                {twoFactorStatus(u.id) === "enrolled" && (
                  <ShieldCheck className="size-3 text-emerald-500" />
                )}
                <RoleBadge role={userRole(u)} />
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setSecurityDialogOpen(true)}>
              <ShieldCheck
                className={cn(
                  "size-4",
                  selfTwoFactor === "enrolled" && "text-emerald-500"
                )}
              />
              {selfTwoFactor === "enrolled"
                ? "Two-factor is on"
                : "Set up two-factor"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              {resolvedTheme === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
              Switch to {resolvedTheme === "dark" ? "light" : "dark"} mode
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Schedule &amp; reminders
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={exportMySchedule}>
              <CalendarPlus className="size-4" />
              Export my schedule (.ics)
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => {
                // Keep the menu open so the toggled state is visible.
                e.preventDefault();
                toggleSound();
              }}
            >
              {soundOn ? (
                <Volume2 className="size-4" />
              ) : (
                <VolumeX className="size-4" />
              )}
              Reminder sounds: {soundOn ? "On" : "Off"}
            </DropdownMenuItem>
            {notifPerm !== "granted" && notifPerm !== "unsupported" && (
              <DropdownMenuItem onSelect={enableNotifications}>
                <Bell className="size-4" />
                Enable desktop notifications
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                resetDemo();
                void resetAll();
                router.push("/");
                toast.success("Demo data reset — signed out");
              }}
            >
              <RotateCcw className="size-4" />
              Reset demo data
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                logout();
                toast("Signed out");
              }}
            >
              <LogOut className="size-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm?.kind === "channel"
            ? `Delete #${confirm.name}?`
            : `Delete ${confirm?.name ?? ""}?`
        }
        description={
          confirm?.kind === "channel" ? (
            <>
              This permanently removes the channel and its{" "}
              {confirm.messageCount}{" "}
              {confirm.messageCount === 1 ? "message" : "messages"}. This can&apos;t
              be undone.
            </>
          ) : confirm?.kind === "project" ? (
            <>
              This permanently removes the project and its {confirm.taskCount}{" "}
              {confirm.taskCount === 1 ? "task" : "tasks"}. This can&apos;t be undone.
            </>
          ) : null
        }
        confirmLabel={confirm?.kind === "channel" ? "Delete channel" : "Delete project"}
        onConfirm={runDelete}
      />
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const { pathname, id: routeId } = useCurrentRoute();

  return (
    <div className="flex h-svh overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border md:block">
        <SidebarContent />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Open navigation menu">
                <Menu className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SidebarContent onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="flex items-center gap-2">
            <div className="flex size-6 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white">
              <Sparkles className="size-3" />
            </div>
            <span className="text-sm font-semibold tracking-tight">Lumina</span>
          </div>
        </header>

        <main key={`${pathname}?${routeId ?? ""}`} className="min-h-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
