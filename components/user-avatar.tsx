"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { User } from "@/lib/types";

const SIZES = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
} as const;

const PRESENCE = {
  online: "bg-emerald-500",
  away: "bg-amber-400",
  offline: "bg-zinc-300 dark:bg-zinc-600",
} as const;

function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function UserAvatar({
  user,
  size = "md",
  showPresence = false,
  className,
}: {
  user: User;
  size?: keyof typeof SIZES;
  showPresence?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("relative shrink-0", className)}>
      <Avatar className={cn(SIZES[size], "rounded-full")}>
        <AvatarFallback
          className="rounded-full font-semibold text-white"
          style={{ backgroundColor: user.color }}
        >
          {initials(user.name)}
        </AvatarFallback>
      </Avatar>
      {showPresence && (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-2.5 rounded-full ring-2 ring-background",
            PRESENCE[user.presence]
          )}
        />
      )}
    </div>
  );
}
