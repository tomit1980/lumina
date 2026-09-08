"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Flag } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUI } from "@/components/ui-context";
import { useStore } from "@/lib/store";
import { PRIORITIES, PRIORITY_META, type Priority } from "@/lib/types";
import { cn } from "@/lib/utils";
import { projectHref } from "@/lib/routes";

const EMOJIS = ["🚀", "🎨", "📱", "🧪", "📈", "🛠️", "🌱", "🎯", "📦", "✨"];
const COLORS = [
  "#8b5cf6",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#6366f1",
  "#14b8a6",
];

export function ProjectDialog() {
  const router = useRouter();
  const { projectDialog, closeProjectDialog } = useUI();
  const { state, createProject, updateProject } = useStore();

  const editing = projectDialog.editId
    ? state.projects.find((p) => p.id === projectDialog.editId)
    : undefined;

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [emoji, setEmoji] = React.useState(EMOJIS[0]);
  const [color, setColor] = React.useState(COLORS[0]);
  const [priority, setPriority] = React.useState<Priority>("medium");

  React.useEffect(() => {
    if (!projectDialog.open) return;
    if (editing) {
      setName(editing.name);
      setDescription(editing.description);
      setEmoji(editing.emoji);
      setColor(editing.color);
      setPriority(editing.priority);
    } else {
      setName("");
      setDescription("");
      setEmoji(EMOJIS[0]);
      setColor(COLORS[0]);
      setPriority("medium");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDialog.open, projectDialog.editId]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the project a name first.");
      return;
    }
    if (editing) {
      // The store refuses an edit the acting user isn't entitled to (and
      // says why) — don't close the dialog or claim success over a write
      // that never happened.
      const ok = await updateProject(editing.id, {
        name: trimmed,
        description: description.trim(),
        emoji,
        color,
        priority,
      });
      if (!ok) return;
      closeProjectDialog();
      toast.success(`Project “${trimmed}” updated`);
      return;
    }
    const project = await createProject({
      name: trimmed,
      description: description.trim(),
      emoji,
      color,
      priority,
    });
    if (!project) return;
    closeProjectDialog();
    toast.success(`Project “${trimmed}” created`);
    router.push(projectHref(project.id));
  };

  return (
    <Dialog open={projectDialog.open} onOpenChange={(o) => !o && closeProjectDialog()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit project" : "Create a project"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the name, description, or styling of this project."
              : "Projects hold a board of tasks your team can drag through the flow."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              autoFocus
              placeholder="e.g. Summer Launch"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project-desc">Description</Label>
            <Input
              id="project-desc"
              placeholder="One line on what this project is for"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    <Flag className={cn("mr-1.5 inline size-3", PRIORITY_META[p].className)} />
                    {PRIORITY_META[p].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-1.5">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg text-base transition-all",
                    emoji === e
                      ? "bg-primary/10 ring-2 ring-primary"
                      : "bg-muted hover:bg-muted/70"
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Accent</Label>
            <div className="flex flex-wrap gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn(
                    "size-6 rounded-full transition-transform hover:scale-110",
                    color === c && "ring-2 ring-foreground/60 ring-offset-2 ring-offset-background"
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeProjectDialog}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            {editing ? "Save changes" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
