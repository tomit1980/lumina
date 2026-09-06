"use client";

import { Hash, Lock, Megaphone, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { UserCard } from "@/components/user-card";
import { Composer, MessageList } from "@/components/chat/conversation";
import { useUI } from "@/components/ui-context";
import { useStore } from "@/lib/store";
import type { Channel } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ChatView({ channel }: { channel: Channel }) {
  const router = useRouter();
  const { openAccessDialog } = useUI();
  const {
    state,
    can,
    canDeleteChannel,
    canSeeChannel,
    channelAccessLevel,
    deleteChannel,
  } = useStore();
  const viewerOnly = channelAccessLevel(channel) === "viewer";

  const members = channel.isPrivate
    ? state.users.filter((u) => canSeeChannel(channel, u))
    : state.users;

  const title = channel.isTeam ? "Team" : channel.name;

  const HeaderIcon = channel.isTeam ? Megaphone : channel.isPrivate ? Lock : Hash;

  const intro = (
    <div className="px-5 pt-8 pb-2">
      <div
        className={cn(
          "mb-3 flex size-12 items-center justify-center rounded-2xl",
          channel.isTeam
            ? "bg-primary/10"
            : channel.isPrivate
              ? "bg-amber-500/12"
              : "bg-primary/10"
        )}
      >
        {channel.isTeam ? (
          <Megaphone className="size-6 text-primary" />
        ) : channel.isPrivate ? (
          <Lock className="size-6 text-amber-600 dark:text-amber-400" />
        ) : (
          <Hash className="size-6 text-primary" />
        )}
      </div>
      <h2 className="text-lg font-semibold tracking-tight">
        {channel.isTeam ? "Team" : `Welcome to #${channel.name}`}
      </h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        {channel.isTeam
          ? `Everyone at Northlight Studio is here — all ${state.users.length} of you. Say something the whole team should see.`
          : channel.description || "This is the very beginning of the channel."}
        {channel.isPrivate && " Only invited people can see this conversation."}
      </p>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex h-13 shrink-0 items-center gap-3 border-b px-5">
        <div className="flex min-w-0 items-center gap-2">
          <HeaderIcon className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-sm font-semibold tracking-tight">{title}</h1>
        </div>
        {channel.description && (
          <>
            <Separator orientation="vertical" className="h-4" />
            <p className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
              {channel.description}
            </p>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex -space-x-1.5">
                {members.slice(0, 4).map((u) => (
                  <UserCard key={u.id} user={u}>
                    <button className="rounded-full transition-transform hover:z-10 hover:scale-110">
                      <UserAvatar
                        user={u}
                        size="sm"
                        className="rounded-full ring-2 ring-background"
                      />
                    </button>
                  </UserCard>
                ))}
                {members.length > 4 && (
                  <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-background">
                    +{members.length - 4}
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {members.length} {members.length === 1 ? "member" : "members"}
            </TooltipContent>
          </Tooltip>
          {canDeleteChannel(channel) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground">
                  <span className="text-base leading-none">⋯</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => openAccessDialog("channel", channel.id)}
                >
                  <ShieldCheck className="size-4" />
                  Manage access
                </DropdownMenuItem>
                {channel.name !== "general" && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      deleteChannel(channel.id);
                      toast.success(`Channel #${channel.name} deleted`);
                      router.push("/");
                    }}
                  >
                    <Trash2 className="size-4" />
                    Delete channel
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <MessageList conversationId={channel.id} intro={intro} />

      <Composer
        conversationId={channel.id}
        placeholder={channel.isTeam ? "Message the whole team" : `Message #${channel.name}`}
        disabled={!can("message.send") || viewerOnly}
        disabledPlaceholder={
          viewerOnly ? "You have view-only access to this channel" : "Your role can't post here"
        }
      />
    </div>
  );
}
