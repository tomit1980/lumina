"use client";

import * as React from "react";

import { useSubmitOnce } from "@/components/use-submit-once";
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

/** Radix's Select treats "" as "no value", so the none option needs a real
 *  one. Never reaches the store: it is mapped back to null on submit. */
const NO_TASK_SET = "__none__";

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
  /** "" means no task set — the ordinary case, and the default. */
  const [taskSetId, setTaskSetId] = React.useState("");

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
      setTaskSetId("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDialog.open, projectDialog.editId]);

  // Archived sets stay in Settings and drop out of here. The store applies
  // the same rule, so passing one anyway changes nothing.
  const available = state.taskSets.filter((t) => t.archivedAt === null);
  const chosen = available.find((t) => t.id === taskSetId);

  const saveOnce = async () => {
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
      taskSetId: taskSetId || null,
    });
    if (!project) return;
    closeProjectDialog();
    // The count comes from the set that was chosen, not from a guess about
    // what the store did: if instantiation had been refused, `project` would
    // be null and this line would never run.
    toast.success(`Project “${trimmed}” created`, {
      description: chosen
        ? `${chosen.items.length} ${chosen.items.length === 1 ? "task" : "tasks"} added from ${chosen.name}.`
        : undefined,
    });
    router.push(projectHref(project.id));
  };

  const [save, savePending] = useSubmitOnce(saveOnce);
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

          {/* Task sets, on create only. Editing a project must not offer to
              pour a second set into it: instantiation happens once, and an
              "apply a set to an existing project" action is a different
              feature with different rules about duplicates. */}
          {!editing && available.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="project-task-set">Task set</Label>
              <Select
                value={taskSetId || NO_TASK_SET}
                onValueChange={(v) => setTaskSetId(v === NO_TASK_SET ? "" : v)}
              >
                <SelectTrigger id="project-task-set">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TASK_SET}>No task set</SelectItem>
                  {available.map((set) => (
                    <SelectItem key={set.id} value={set.id}>
                      {set.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {chosen && (
                <div className="rounded-lg border bg-muted/30 p-2.5">
                  <p className="text-[12px] font-medium">
                    {chosen.items.length}{" "}
                    {chosen.items.length === 1 ? "task" : "tasks"} will be created
                  </p>
                  {chosen.items.length > 0 && (
                    <ol className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto text-[12px] text-muted-foreground">
                      {[...chosen.items]
                        .sort((a, b) => a.position - b.position)
                        .map((item, i) => (
                          <li key={item.id}>
                            {i + 1}. {item.title}
                          </li>
                        ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          )}
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
          <Button size="sm" onClick={save} disabled={savePending}>
            {editing ? "Save changes" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
