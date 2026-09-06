"use client";

import { RoleBadge } from "@/components/role-badge";
import { UserAvatar } from "@/components/user-avatar";
import { Composer, MessageList } from "@/components/chat/conversation";
import { useStore } from "@/lib/store";
import type { DM, User } from "@/lib/types";
import { cn } from "@/lib/utils";

const PRESENCE_LABEL = {
  online: "Online",
  away: "Away",
  offline: "Offline",
} as const;

const PRESENCE_DOT = {
  online: "bg-emerald-500",
  away: "bg-amber-400",
  offline: "bg-zinc-300 dark:bg-zinc-600",
} as const;

export function DmView({ dm, other }: { dm: DM; other: User }) {
  const { userRole } = useStore();
  const firstName = other.name.split(" ")[0];

  const intro = (
    <div className="px-5 pt-8 pb-2">
      <UserAvatar user={other} size="lg" showPresence className="mb-3" />
      <h2 className="text-lg font-semibold tracking-tight">{other.name}</h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        {other.title}. This conversation is just between you and {firstName} —
        no one else can see it.
      </p>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex h-13 shrink-0 items-center gap-3 border-b px-5">
        <UserAvatar user={other} size="md" showPresence />
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-sm font-semibold tracking-tight">
            {other.name}
            <RoleBadge role={userRole(other)} />
          </h1>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", PRESENCE_DOT[other.presence])} />
            {PRESENCE_LABEL[other.presence]} · {other.title}
          </p>
        </div>
      </header>

      <MessageList conversationId={dm.id} intro={intro} />

      {/* DMs are open to every role — including guests. */}
      <Composer conversationId={dm.id} placeholder={`Message ${firstName}`} />
    </div>
  );
}
