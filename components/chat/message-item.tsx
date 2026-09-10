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
import { MessageAttachments } from "@/components/chat/message-attachments";
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
  /**
   * The person who wrote this, or `undefined` when the client cannot resolve
   * them — a profile that was deleted (`author_id` is `on delete set null`),
   * or a teammate who joined after this tab loaded.
   *
   * It is optional on purpose. This used to be a required `User` and the
   * caller supplied `state.users[0]` when the lookup missed, which put a real,
   * named colleague's avatar, colour and profile card on somebody else's
   * words — QA-116. A missing name is a small gap; the wrong name is a false
   * statement about who said something, and it never self-corrected.
   */
  author?: User;
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
    // QA-123: the edit box used to close immediately and unconditionally. If
    // the write was refused, `commit` restored the original text and toasted
    // "Couldn't save" — and the rewrite the user had just typed was gone,
    // with no way to get it back except from memory.
    //
    // This is the pattern the composer one file over already uses
    // (components/chat/conversation.tsx): let the box close optimistically,
    // and put the words back if the write does not survive. The `d ? d : ...`
    // guard is the same one for the same reason — if the user has started
    // typing again in the meantime, theirs wins.
    setEditing(false);
    void editMessage(message.id, content).then((ok) => {
      if (ok) return;
      setDraft((d) => (d.trim() ? d : content));
      setEditing(true);
    });
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
          author ? (
            <UserCard user={author}>
              <button className="rounded-full transition-transform hover:scale-105">
                <UserAvatar user={author} size="md" />
              </button>
            </UserCard>
          ) : (
            // No card and no button: there is no profile to open, and offering
            // one would imply this resolves to somebody.
            <div
              aria-hidden
              className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
            >
              ?
            </div>
          )
        ) : (
          <span className="hidden text-[10px] leading-6 text-muted-foreground group-hover:block">
            {format(message.createdAt, "HH:mm")}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1 pb-0.5">
        {!compact && (
          <div className="flex items-baseline gap-2">
            {author ? (
              <UserCard user={author} side="bottom">
                <button className="text-[13px] font-semibold hover:underline">
                  {author.name}
                </button>
              </UserCard>
            ) : (
              // The word the rest of the app already uses for an actor it
              // cannot name — app/page.tsx's activity feed and the reaction
              // tooltips both say "Someone".
              <span className="text-[13px] font-semibold text-muted-foreground">
                Someone
              </span>
            )}
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
        ) : message.content.trim() ? (
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
        ) : null}

        {message.attachments.length > 0 && (
          <MessageAttachments attachments={message.attachments} />
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
                      onClick={() => void toggleReaction(message.id, reaction.emoji)}
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
            <EmojiPicker onPick={(emoji) => void toggleReaction(message.id, emoji)}>
              <button
                aria-label="Add reaction"
                className="flex h-6 items-center rounded-full border border-dashed px-1.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:border-foreground/25 hover:text-foreground"
              >
                <SmilePlus className="size-3.5" />
              </button>
            </EmojiPicker>
          </div>
        )}
      </div>

      {/* Hover toolbar */}
      {!editing && (
        <div className="absolute -top-3 right-4 hidden items-center rounded-lg border bg-background shadow-sm group-hover:flex">
          <EmojiPicker onPick={(emoji) => void toggleReaction(message.id, emoji)}>
            <Button variant="ghost" size="icon" className="size-7 rounded-lg" aria-label="Add reaction">
              <SmilePlus className="size-3.5" />
            </Button>
          </EmojiPicker>
          {mayEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg"
              aria-label="Edit message"
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
              aria-label="Delete message"
              onClick={async () => {
                // QA-122: don't say it was deleted until it was. `commit`
                // rolls the message back and toasts its own failure, so
                // "Message deleted" appearing beside it was the app
                // contradicting itself about something the user was watching.
                if (!(await deleteMessage(message.id))) return;
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
