"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Hash, Lock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useUI } from "@/components/ui-context";
import { useStore } from "@/lib/store";
import { chatHref } from "@/lib/routes";

export function ChannelDialog() {
  const router = useRouter();
  const { channelDialogOpen, setChannelDialogOpen } = useUI();
  const { state, createChannel } = useStore();

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [isPrivate, setIsPrivate] = React.useState(false);

  React.useEffect(() => {
    if (channelDialogOpen) {
      setName("");
      setDescription("");
      setIsPrivate(false);
    }
  }, [channelDialogOpen]);

  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");

  const create = async () => {
    if (!slug) {
      toast.error("Give the channel a name first.");
      return;
    }
    if (state.channels.some((c) => c.name === slug)) {
      toast.error(`#${slug} already exists.`);
      return;
    }
    const channel = await createChannel({
      name: slug,
      description: description.trim(),
      isPrivate,
    });
    if (!channel) return;
    setChannelDialogOpen(false);
    toast.success(`Channel #${slug} created`);
    router.push(chatHref(channel.id));
  };

  return (
    <Dialog open={channelDialogOpen} onOpenChange={setChannelDialogOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
          <DialogDescription>
            Channels are where conversations happen around a topic.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="channel-name">Name</Label>
            <div className="relative">
              {isPrivate ? (
                <Lock className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              ) : (
                <Hash className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              )}
              <Input
                id="channel-name"
                autoFocus
                placeholder="e.g. product-launch"
                className="pl-8"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
            </div>
            {slug && slug !== name.trim() && (
              <p className="text-[11px] text-muted-foreground">
                Will be created as <span className="font-medium">#{slug}</span>
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="channel-desc">Description</Label>
            <Input
              id="channel-desc"
              placeholder="What's this channel about?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="grid gap-0.5">
              <Label htmlFor="channel-private" className="cursor-pointer">
                Make private
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Only invited people and admins can see private channels.
              </p>
            </div>
            <Switch
              id="channel-private"
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setChannelDialogOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={create}>
            Create channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
