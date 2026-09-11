"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Copy, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { TaskSet } from "@/lib/types";

/**
 * Task sets — reusable lists of tasks for work that repeats.
 *
 * Every refusal here is one `task_sets_write` also enforces, so this is not
 * the rule: it is the explanation. A Member calling PostgREST directly is
 * turned away by the database whatever this screen shows.
 *
 * Structure follows statuses-section.tsx, which is the closest precedent and
 * was built on the same lessons: an inline add row rather than a dialog, a
 * rename with all three commit paths, arrow buttons rather than drag, and a
 * destructive button that is never disabled because a greyed-out control with
 * no reason is what sends people looking for a bug.
 */
export function TaskSetsSection() {
  const {
    state,
    can,
    createTaskSet,
    duplicateTaskSet,
    updateTaskSet,
    archiveTaskSet,
    createTaskSetItem,
    updateTaskSetItem,
    deleteTaskSetItem,
    reorderTaskSetItems,
  } = useStore();

  const mayEdit = can("workspace.taskSets");
  const [adding, setAdding] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [addingItemTo, setAddingItemTo] = React.useState<string | null>(null);
  const [newItem, setNewItem] = React.useState("");

  // Live, not a copy: the store is the single source and the list is derived
  // every render, so an optimistic write and its rollback both show up here
  // without a second piece of state to keep in step.
  const sets = [...state.taskSets].sort((a, b) => b.updatedAt - a.updatedAt);

  const add = async () => {
    const created = await createTaskSet({ name: newName });
    if (!created) return;
    setNewName("");
    setAdding(false);
    setOpenId(created.id);
    toast.success(`Added the ${created.name} task set`);
  };

  const addItem = async (setId: string) => {
    const created = await createTaskSetItem(setId, { title: newItem });
    if (!created) return;
    setNewItem("");
  };

  const move = async (set: TaskSet, index: number, by: -1 | 1) => {
    const ordered = [...set.items].sort((a, b) => a.position - b.position);
    const to = index + by;
    if (to < 0 || to >= ordered.length) return;
    [ordered[index], ordered[to]] = [ordered[to], ordered[index]];
    await reorderTaskSetItems(set.id, ordered.map((i) => i.id));
  };

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Task sets</h2>
          <p className="text-[12px] text-muted-foreground">
            Reusable lists for work that repeats. Pick one when you create a project and
            its tasks are created with it.
          </p>
        </div>
        {mayEdit && !adding && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" />
            New task set
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border p-3">
          <Input
            autoFocus
            aria-label="Task set name"
            placeholder="Pension Release — Standard"
            value={newName}
            className="h-8"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
              if (e.key === "Escape") {
                setNewName("");
                setAdding(false);
              }
            }}
          />
          <Button size="sm" className="h-8 text-xs" onClick={() => void add()}>
            Add
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => {
              setNewName("");
              setAdding(false);
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {sets.length === 0 && !adding && (
        <p className="rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          No task sets yet.
          {mayEdit
            ? " Create one and every project of that kind starts with its tasks already there."
            : ""}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border">
        {sets.map((set, index) => {
          const open = openId === set.id;
          const archived = set.archivedAt !== null;
          const ordered = [...set.items].sort((a, b) => a.position - b.position);
          return (
            <div key={set.id} className={cn(index > 0 && "border-t")}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setOpenId(open ? null : set.id)}
                  aria-expanded={open}
                >
                  <span
                    className={cn(
                      "truncate text-[13px] font-medium",
                      archived && "text-muted-foreground line-through"
                    )}
                  >
                    {set.name}
                  </span>
                  <span className="ml-2 text-[12px] text-muted-foreground">
                    {ordered.length} {ordered.length === 1 ? "task" : "tasks"}
                  </span>
                </button>

                {archived && (
                  <Badge variant="secondary" className="text-[10px]">
                    Archived
                  </Badge>
                )}

                {mayEdit && (
                  <div className="flex items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          aria-label={`Duplicate ${set.name}`}
                          onClick={async () => {
                            const copy = await duplicateTaskSet(set.id);
                            if (copy) toast.success(`Copied to ${copy.name}`);
                          }}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Duplicate {set.name}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className={cn("size-7", !archived && "text-destructive")}
                          aria-label={
                            archived ? `Restore ${set.name}` : `Archive ${set.name}`
                          }
                          onClick={() => void archiveTaskSet(set.id, !archived)}
                        >
                          {archived ? (
                            <RotateCcw className="size-3.5" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      {/* Archived rather than deleted, and the tooltip says so:
                          projects created from this set keep pointing at it. */}
                      <TooltipContent>
                        {archived
                          ? `Restore ${set.name} to the project picker`
                          : `Archive ${set.name} — projects already created keep their tasks`}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>

              {open && (
                <div className="border-t bg-muted/20 px-3 py-3">
                  {mayEdit && (
                    <div className="mb-3">
                      <Input
                        aria-label={`Rename ${set.name}`}
                        defaultValue={set.name}
                        className="h-8 text-[13px]"
                        // Three commit paths, because blur-only is a rename
                        // that silently does not save when focus does not
                        // happen to move — the fault statuses-section.tsx
                        // records fixing.
                        onKeyDown={(e) => {
                          const el = e.currentTarget;
                          if (e.key === "Enter") el.blur();
                          if (e.key === "Escape") {
                            el.value = set.name;
                            el.blur();
                          }
                        }}
                        onBlur={(e) => {
                          const name = e.currentTarget.value.trim();
                          if (!name) {
                            e.currentTarget.value = set.name;
                            return;
                          }
                          if (name !== set.name) void updateTaskSet(set.id, { name });
                        }}
                      />
                    </div>
                  )}

                  {ordered.length === 0 && (
                    <p className="py-2 text-[12px] text-muted-foreground">
                      No tasks in this set yet.
                    </p>
                  )}

                  <ol className="space-y-1">
                    {ordered.map((item, i) => (
                      <li key={item.id} className="flex items-center gap-2">
                        <span className="w-5 shrink-0 text-right text-[11px] text-muted-foreground">
                          {i + 1}.
                        </span>
                        {mayEdit ? (
                          <Input
                            aria-label={`Title of task ${i + 1} in ${set.name}`}
                            defaultValue={item.title}
                            className="h-7 flex-1 text-[13px]"
                            onKeyDown={(e) => {
                              const el = e.currentTarget;
                              if (e.key === "Enter") el.blur();
                              if (e.key === "Escape") {
                                el.value = item.title;
                                el.blur();
                              }
                            }}
                            onBlur={(e) => {
                              const title = e.currentTarget.value.trim();
                              if (!title) {
                                e.currentTarget.value = item.title;
                                return;
                              }
                              if (title !== item.title) {
                                void updateTaskSetItem(item.id, { title });
                              }
                            }}
                          />
                        ) : (
                          <span className="flex-1 text-[13px]">{item.title}</span>
                        )}
                        {mayEdit && (
                          <div className="flex items-center gap-0.5">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              aria-label={`Move ${item.title} earlier`}
                              disabled={i === 0}
                              onClick={() => void move(set, i, -1)}
                            >
                              <ArrowUp className="size-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              aria-label={`Move ${item.title} later`}
                              disabled={i === ordered.length - 1}
                              onClick={() => void move(set, i, 1)}
                            >
                              <ArrowDown className="size-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6 text-destructive"
                              aria-label={`Remove ${item.title}`}
                              onClick={() => void deleteTaskSetItem(item.id)}
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>

                  {mayEdit &&
                    (addingItemTo === set.id ? (
                      <div className="mt-2 flex items-center gap-2 pl-7">
                        <Input
                          autoFocus
                          aria-label={`New task for ${set.name}`}
                          placeholder="Collect client identification"
                          value={newItem}
                          className="h-7 text-[13px]"
                          onChange={(e) => setNewItem(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void addItem(set.id);
                            if (e.key === "Escape") {
                              setNewItem("");
                              setAddingItemTo(null);
                            }
                          }}
                        />
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => void addItem(set.id)}
                        >
                          Add
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => {
                            setNewItem("");
                            setAddingItemTo(null);
                          }}
                        >
                          Done
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-2 ml-7 h-7 text-xs"
                        onClick={() => setAddingItemTo(set.id)}
                      >
                        <Plus className="size-3.5" />
                        Add a task
                      </Button>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!mayEdit && (
        <p className="mt-4 text-[12px] text-muted-foreground">
          Only an Owner or Admin can change task sets.
        </p>
      )}
    </>
  );
}
