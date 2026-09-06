"use client";

import * as React from "react";
import { format, isToday, isYesterday } from "date-fns";
import { FileText, Paperclip, SendHorizonal, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageItem } from "@/components/chat/message-item";
import { formatBytes, MAX_ATTACHMENT_BYTES, readFileAsAttachment } from "@/lib/attachments";
import { useStore } from "@/lib/store";
import type { Attachment, Message } from "@/lib/types";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

function dayLabel(ts: number): string {
  if (isToday(ts)) return "Today";
  if (isYesterday(ts)) return "Yesterday";
  return format(ts, "EEEE, MMMM d");
}

/** Scrolling message list with day dividers and author grouping.
 *  Works for any conversation id (channel or DM). */
export function MessageList({
  conversationId,
  intro,
}: {
  conversationId: string;
  intro: React.ReactNode;
}) {
  const { state, markChannelRead } = useStore();
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const messages = React.useMemo(
    () =>
      state.messages
        .filter((m) => m.channelId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt),
    [state.messages, conversationId]
  );

  React.useEffect(() => {
    markChannelRead(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, messages.length]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conversationId, messages.length]);

  const rows: Array<
    | { type: "divider"; key: string; label: string }
    | { type: "message"; key: string; message: Message; compact: boolean }
  > = [];
  let prev: Message | null = null;
  for (const message of messages) {
    if (
      !prev ||
      new Date(prev.createdAt).toDateString() !==
        new Date(message.createdAt).toDateString()
    ) {
      rows.push({
        type: "divider",
        key: `d-${message.id}`,
        label: dayLabel(message.createdAt),
      });
      prev = null;
    }
    const compact =
      !!prev &&
      prev.authorId === message.authorId &&
      message.createdAt - prev.createdAt < GROUP_WINDOW_MS;
    rows.push({ type: "message", key: message.id, message, compact });
    prev = message;
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pb-4">
      {intro}
      {rows.map((row) =>
        row.type === "divider" ? (
          <div key={row.key} className="my-4 flex items-center gap-3 px-5">
            <Separator className="flex-1" />
            <span className="rounded-full border bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {row.label}
            </span>
            <Separator className="flex-1" />
          </div>
        ) : (
          <MessageItem
            key={row.key}
            message={row.message}
            author={
              state.users.find((u) => u.id === row.message.authorId) ??
              state.users[0]
            }
            compact={row.compact}
          />
        )
      )}
    </div>
  );
}

export function Composer({
  conversationId,
  placeholder,
  disabled = false,
  disabledPlaceholder = "You can't post here",
}: {
  conversationId: string;
  placeholder: string;
  disabled?: boolean;
  disabledPlaceholder?: string;
}) {
  const { sendMessage, currentUser } = useStore();
  const [draft, setDraft] = React.useState("");
  const [pending, setPending] = React.useState<Attachment[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const canSend = !disabled && (draft.trim().length > 0 || pending.length > 0);

  const send = () => {
    if (!canSend) return;
    const ok = sendMessage(conversationId, draft.trim(), pending);
    if (!ok) return;
    setDraft("");
    setPending([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      const result = await readFileAsAttachment(file, currentUser.id);
      if (result.ok) setPending((p) => [...p, result.attachment]);
      else toast.error(result.error);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div className="px-5 pb-4">
      <div className="rounded-xl border bg-background p-2 shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-1 focus-within:ring-ring/40">
        {pending.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5 px-1">
            {pending.map((a) => (
              <span
                key={a.id}
                className="flex max-w-56 items-center gap-1.5 rounded-lg border bg-muted/60 py-1 pr-1 pl-1.5 text-[12px]"
              >
                {a.type.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.dataUrl} alt="" className="size-6 rounded object-cover" />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium">{a.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setPending((p) => p.filter((x) => x.id !== a.id))}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 rounded-lg text-muted-foreground"
                disabled={disabled || uploading}
                onClick={() => fileRef.current?.click()}
                aria-label="Attach files"
              >
                <Paperclip className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach files · max {formatBytes(MAX_ATTACHMENT_BYTES)} each</TooltipContent>
          </Tooltip>
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              autoResize();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={disabled ? disabledPlaceholder : placeholder}
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                className="size-8 rounded-lg"
                disabled={!canSend || uploading}
                onClick={send}
              >
                <SendHorizonal className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send · Enter</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">
        <span className="font-medium">Enter</span> to send ·{" "}
        <span className="font-medium">Shift+Enter</span> for a new line ·
        supports **bold**, *italic*, `code`, @mentions · 📎 attach files
      </p>
    </div>
  );
}
