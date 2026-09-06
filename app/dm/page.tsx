"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MessageCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DmView } from "@/components/chat/dm-view";
import { useStore } from "@/lib/store";

export default function DmPage() {
  // useSearchParams needs a Suspense boundary for static export.
  return (
    <React.Suspense fallback={null}>
      <DmPageInner />
    </React.Suspense>
  );
}

function DmPageInner() {
  const dmId = useSearchParams().get("id");
  const { state, currentUser } = useStore();

  const dm = dmId ? state.dms.find((d) => d.id === dmId) : undefined;
  const other = dm
    ? state.users.find(
        (u) => dm.memberIds.includes(u.id) && u.id !== currentUser.id
      )
    : undefined;

  // A DM is only visible to its two participants.
  if (!dm || !dm.memberIds.includes(currentUser.id) || !other) {
    const none = !dmId;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
          <MessageCircle className="size-6 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-base font-semibold">
            {none ? "Pick a conversation" : "Conversation not found"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {none
              ? "Choose someone from the Direct messages list in the sidebar."
              : "This direct message doesn’t exist — or it isn’t yours to read."}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/">Back home</Link>
        </Button>
      </div>
    );
  }

  return <DmView key={dm.id} dm={dm} other={other} />;
}
