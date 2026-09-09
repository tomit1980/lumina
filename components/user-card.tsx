"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MessageCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RoleBadge } from "@/components/role-badge";
import { UserAvatar } from "@/components/user-avatar";
import { PRESENCE_DOT, PRESENCE_LABEL } from "@/lib/presence";
import { useStore } from "@/lib/store";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";
import { dmHref } from "@/lib/routes";

/** Click-to-open profile card with a "Message" action.
 *  Wrap any avatar or name with it. */
export function UserCard({
  user,
  children,
  side = "right",
}: {
  user: User;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const router = useRouter();
  const { currentUser, userRole, openDm } = useStore();
  const [open, setOpen] = React.useState(false);
  const isMe = user.id === currentUser.id;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side={side} className="w-64 p-0">
        <div className="flex items-center gap-3 p-4 pb-3">
          <UserAvatar user={user} size="lg" showPresence />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold">{user.name}</span>
              {isMe && (
                <Badge className="bg-primary/10 text-[10px] text-primary">you</Badge>
              )}
            </div>
            <p className="truncate text-[11px] text-muted-foreground">
              {user.title} · @{user.handle}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between border-t px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn("size-2 rounded-full", PRESENCE_DOT[user.presence])} />
            {PRESENCE_LABEL[user.presence]}
            <RoleBadge role={userRole(user)} className="ml-1" />
          </span>
          {!isMe && (
            <Button
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={() => {
                setOpen(false);
                void openDm(user.id).then((dm) => {
                  if (dm) router.push(dmHref(dm.id));
                });
              }}
            >
              <MessageCircle className="size-3.5" />
              Message
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
