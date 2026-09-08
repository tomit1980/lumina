"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  CheckSquare,
  FolderKanban,
  Hash,
  Home,
  Lock,
  Megaphone,
  MessageCircle,
  Moon,
  Plus,
  Sun,
  UserRound,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { RoleBadge } from "@/components/role-badge";
import {
  CommandDialog,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { UserAvatar } from "@/components/user-avatar";
import { useUI } from "@/components/ui-context";
import { useAuth } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { chatHref, dmHref, projectHref } from "@/lib/routes";

export function CommandPalette() {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const {
    paletteOpen,
    setPaletteOpen,
    openTaskDialog,
    setChannelDialogOpen,
    openProjectDialog,
  } = useUI();
  const { state, currentUser, can, canSeeChannel, canSeeProject, userRole, openDm } =
    useStore();
  const { requestSwitch, twoFactorStatus } = useAuth();

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setPaletteOpen]);

  const run = (fn: () => void) => {
    setPaletteOpen(false);
    fn();
  };

  const channels = state.channels.filter((c) => canSeeChannel(c));
  const teamChannel = state.channels.find((c) => c.isTeam);

  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <Command>
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Go to">
            <CommandItem onSelect={() => run(() => router.push("/"))}>
              <Home />
              Home
              <CommandShortcut>G H</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => run(() => router.push("/people"))}>
              <Users />
              People
              <CommandShortcut>G P</CommandShortcut>
            </CommandItem>
            {channels.map((c) =>
              c.isTeam ? (
                <CommandItem
                  key={c.id}
                  value={`team everyone all hands ${c.name}`}
                  onSelect={() => run(() => router.push(chatHref(c.id)))}
                >
                  <Megaphone />
                  Team
                  <span className="ml-1 text-muted-foreground">Everyone</span>
                </CommandItem>
              ) : (
                <CommandItem
                  key={c.id}
                  value={`channel ${c.name}`}
                  onSelect={() => run(() => router.push(chatHref(c.id)))}
                >
                  {c.isPrivate ? <Lock /> : <Hash />}
                  {c.name}
                </CommandItem>
              )
            )}
            {state.projects.filter((p) => canSeeProject(p)).map((p) => (
              <CommandItem
                key={p.id}
                value={`project ${p.name}`}
                onSelect={() => run(() => router.push(projectHref(p.id)))}
              >
                <FolderKanban />
                {p.name}
                <span className="ml-1 text-muted-foreground">{p.emoji}</span>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Message">
            {teamChannel && (
              <CommandItem
                value="message the entire team everyone all hands"
                onSelect={() => run(() => router.push(chatHref(teamChannel.id)))}
              >
                <Megaphone />
                The entire team
                <span className="ml-1 text-muted-foreground">
                  all {state.users.length}
                </span>
              </CommandItem>
            )}
            {state.users
              .filter((u) => u.id !== currentUser.id)
              .map((u) => (
                <CommandItem
                  key={u.id}
                  value={`message dm ${u.name} ${u.handle}`}
                  onSelect={() =>
                    run(() => {
                      void openDm(u.id).then((dm) => {
                        if (dm) router.push(dmHref(dm.id));
                      });
                    })
                  }
                >
                  <MessageCircle />
                  {u.name}
                  <span className="ml-1 text-muted-foreground">@{u.handle}</span>
                </CommandItem>
              ))}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Create">
            {can("task.create") && (
              <CommandItem onSelect={() => run(() => openTaskDialog())}>
                <CheckSquare />
                New task
                <CommandShortcut>T</CommandShortcut>
              </CommandItem>
            )}
            {can("channel.create") && (
              <CommandItem onSelect={() => run(() => setChannelDialogOpen(true))}>
                <Plus />
                New channel
              </CommandItem>
            )}
            {can("project.create") && (
              <CommandItem onSelect={() => run(() => openProjectDialog())}>
                <FolderKanban />
                New project
              </CommandItem>
            )}
            {!can("task.create") && !can("channel.create") && !can("project.create") && (
              <CommandItem disabled>
                <Lock />
                Creating is limited for your role
              </CommandItem>
            )}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Preferences">
            <CommandItem
              onSelect={() =>
                run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))
              }
            >
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
              Toggle {resolvedTheme === "dark" ? "light" : "dark"} mode
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="View as (demo roles)">
            {state.users.map((u) => (
              <CommandItem
                key={u.id}
                value={`view as ${u.name} ${userRole(u).name}`}
                disabled={u.id === currentUser.id}
                onSelect={() =>
                  run(() => {
                    const needs2fa = twoFactorStatus(u.id) === "enrolled";
                    requestSwitch(u.id);
                    if (!needs2fa) {
                      toast(`Now viewing as ${u.name}`, {
                        description: userRole(u).description,
                      });
                    }
                  })
                }
              >
                <UserAvatar user={u} size="xs" />
                {u.name}
                <RoleBadge role={userRole(u)} className="ml-auto" />
              </CommandItem>
            ))}
            <CommandItem value="profile current" disabled>
              <UserRound />
              Signed in as {currentUser.name}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
