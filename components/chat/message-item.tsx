"use client";

import * as React from "react";
import { format } from "date-fns";
import { Check, Pencil, SmilePlus, Trash2, X } from "lucide-react";
import { motion } from "framer-motion";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { UserCard } from "@/components/user-card";
import { RichText } from "@/components/chat/rich-text";
import { canEditMessage } from "@/lib/permissions";
import { useStore } from "@/lib/store";
import { QUICK_EMOJIS, type Message, type User } from "@/lib/types";
import { cn } from "@/lib/utils";

function EmojiPicker({
  onPick,
  children,
}: {
  onPick: (emoji: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" className="w-auto p-1.5">
        <div className="flex gap-0.5">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              className="flex size-8 items-center justify-center rounded-lg text-lg transition-transform hover:scale-125 hover:bg-muted"
              onClick={() => {
                onPick(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function MessageItem({
  message,
  author,
  compact,
}: {
  message: Message;
  author: User;
  /** True when this message continues a run from the same author. */
  compact: boolean;
}) {
  const { state, currentUser, canDeleteMessage, toggleReaction, editMessage, deleteMessage } =
    useStore();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(message.content);

  const mayEdit = canEditMessage(currentUser, message);
  const mayDelete = canDeleteMessage(message);

  const saveEdit = () => {
    const content = draft.trim();
    if (!content) return;
    editMessage(message.id, content);
    setEditing(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn(
        "group relative flex gap-3 px-5 py-0.5 hover:bg-muted/40",
        !compact && "mt-3"
      )}
    >
      <div className="w-8 shrink-0 pt-0.5">
        {!compact ? (
          <UserCard user={author}>
            <button className="rounded-full transition-transform hover:scale-105">
              <UserAvatar user={author} size="md" />
            </button>
          </UserCard>
        ) : (
          <span className="hidden text-[10px] leading-6 text-muted-foreground group-hover:block">
            {format(message.createdAt, "HH:mm")}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1 pb-0.5">
        {!compact && (
          <div className="flex items-baseline gap-2">
            <UserCard user={author} side="bottom">
              <button className="text-[13px] font-semibold hover:underline">
                {author.name}
              </button>
            </UserCard>
            <span className="text-[11px] text-muted-foreground">
              {format(message.createdAt, "h:mm a")}
            </span>
          </div>
        )}

        {editing ? (
          <div className="mt-1 flex flex-col gap-1.5">
            <Textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
                if (e.key === "Escape") setEditing(false);
              }}
              rows={2}
              className="text-[13px]"
            />
            <div className="flex gap-1.5">
              <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={saveEdit}>
                <Check className="size-3" /> Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => {
                  setDraft(message.content);
                  setEditing(false);
                }}
              >
                <X className="size-3" /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-[13px] leading-relaxed text-foreground/90">
            <RichText
              content={message.content}
              users={state.users}
              currentUserId={currentUser.id}
            />
            {message.editedAt && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">(edited)</span>
            )}
          </p>
        )}

        {message.reactions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {message.reactions.map((reaction) => {
              const mine = reaction.userIds.includes(currentUser.id);
              const names = reaction.userIds
                .map((uid) => state.users.find((u) => u.id === uid)?.name ?? "Someone")
                .join(", ");
              return (
                <Tooltip key={reaction.emoji}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => toggleReaction(message.id, reaction.emoji)}
                      className={cn(
                        "flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors",
                        mine
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border bg-background hover:border-foreground/25"
                      )}
                    >
                      <span className="text-[13px] leading-none">{reaction.emoji}</span>
                      <span className="font-medium">{reaction.userIds.length}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{names}</TooltipContent>
                </Tooltip>
              );
            })}
            <EmojiPicker onPick={(emoji) => toggleReaction(message.id, emoji)}>
              <button className="flex h-6 items-center rounded-full border border-dashed px-1.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:border-foreground/25 hover:text-foreground">
                <SmilePlus className="size-3.5" />
              </button>
            </EmojiPicker>
          </div>
        )}
      </div>

      {/* Hover toolbar */}
      {!editing && (
        <div className="absolute -top-3 right-4 hidden items-center rounded-lg border bg-background shadow-sm group-hover:flex">
          <EmojiPicker onPick={(emoji) => toggleReaction(message.id, emoji)}>
            <Button variant="ghost" size="icon" className="size-7 rounded-lg">
              <SmilePlus className="size-3.5" />
            </Button>
          </EmojiPicker>
          {mayEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg"
              onClick={() => {
                setDraft(message.content);
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
          {mayDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg text-destructive hover:text-destructive"
              onClick={() => {
                deleteMessage(message.id);
                toast("Message deleted");
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </motion.div>
  );
}
