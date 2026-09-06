"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Hash, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChatView } from "@/components/chat/chat-view";
import { useStore } from "@/lib/store";

export default function ChannelPage() {
  const { channelId } = useParams<{ channelId: string }>();
  const { state, canSeeChannel } = useStore();

  const channel = state.channels.find((c) => c.id === channelId);

  if (!channel) {
    return (
      <EmptyState
        icon={<Hash className="size-6 text-muted-foreground" />}
        title="Channel not found"
        body="It may have been deleted, or the link is stale."
      />
    );
  }

  if (!canSeeChannel(channel)) {
    return (
      <EmptyState
        icon={<Lock className="size-6 text-amber-600 dark:text-amber-400" />}
        title="This channel is private"
        body="Ask an admin to invite you if you need access."
      />
    );
  }

  return <ChatView key={channel.id} channel={channel} />;
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
        {icon}
      </div>
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/">Back home</Link>
      </Button>
    </div>
  );
}
