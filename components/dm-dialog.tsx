"use client";

import { useRouter } from "next/navigation";

import { RoleBadge } from "@/components/role-badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UserAvatar } from "@/components/user-avatar";
import { useUI } from "@/components/ui-context";
import { useStore } from "@/lib/store";
import { dmHref } from "@/lib/routes";

/** "New message" picker — search a teammate, jump into the conversation. */
export function DmDialog() {
  const router = useRouter();
  const { dmDialogOpen, setDmDialogOpen } = useUI();
  const { state, currentUser, userRole, openDm } = useStore();

  const teammates = state.users.filter((u) => u.id !== currentUser.id);

  return (
    <Dialog open={dmDialogOpen} onOpenChange={setDmDialogOpen}>
      <DialogContent className="gap-0 p-0 sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">New message</DialogTitle>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search teammates…" autoFocus />
          <CommandList>
            <CommandEmpty>Nobody matches that.</CommandEmpty>
            <CommandGroup>
              {teammates.map((user) => (
                <CommandItem
                  key={user.id}
                  value={`${user.name} ${user.handle} ${user.title} ${userRole(user).name}`}
                  onSelect={() => {
                    setDmDialogOpen(false);
                    // Fire-and-forget: the picker closes at once, and the
                    // store toasts if the thread couldn't be opened.
                    void openDm(user.id).then((dm) => {
                      if (dm) router.push(dmHref(dm.id));
                    });
                  }}
                >
                  <UserAvatar user={user} size="sm" showPresence />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {user.title}
                    </span>
                  </span>
                  <RoleBadge role={userRole(user)} className="ml-auto" />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
