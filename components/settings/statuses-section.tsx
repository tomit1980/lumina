"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ROLE_COLORS } from "@/lib/permissions";
import { sortedStatuses } from "@/lib/statuses";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * The board's columns, for whoever holds `workspace.statuses` — the Owner.
 *
 * Every refusal here is one the database also enforces (a foreign key for
 * "still holds work", a partial unique index for "exactly one done column"),
 * so this is not the rule — it is the explanation. A person removing a column
 * deserves "3 tasks are still in Backlog" rather than a constraint error, and
 * the store's actions produce exactly that.
 */
export function StatusesSection() {
  const { state, can, createStatus, updateStatus, deleteStatus, reorderStatuses } =
    useStore();
  const mayEdit = can("workspace.statuses");
  const statuses = sortedStatuses(state.statuses);

  const [adding, setAdding] = React.useState(false);
  const [newName, setNewName] = React.useState("");

  const taskCount = (statusId: string) =>
    state.tasks.filter((t) => t.status === statusId).length;

  const move = async (index: number, by: -1 | 1) => {
    const next = [...statuses];
    const to = index + by;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    await reorderStatuses(next.map((s) => s.id));
  };

  const add = async () => {
    const created = await createStatus({
      name: newName,
      // Cycles the same palette the role editor uses, so a new column looks
      // deliberate without asking anyone to pick a colour up front.
      color: ROLE_COLORS[statuses.length % ROLE_COLORS.length],
    });
    if (!created) return;
    setNewName("");
    setAdding(false);
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[13px] font-semibold">Board columns</h2>
          <p className="text-[12px] text-muted-foreground">
            Shared by every project in the workspace.
          </p>
        </div>
        {mayEdit && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add column
          </Button>
        )}
      </div>

      {adding && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border p-3">
          <Input
            autoFocus
            value={newName}
            placeholder="Column name"
            aria-label="Column name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <Button size="sm" onClick={() => void add()}>
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      )}

      <div className="mt-3 overflow-hidden rounded-xl border">
        {statuses.map((status, i) => {
          const held = taskCount(status.id);
          return (
            <div
              key={status.id}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5",
                i > 0 && "border-t"
              )}
            >
              {/* Inline style: the colour is workspace-chosen, and Tailwind
                  only ships classes it can see at build time. */}
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: status.color }}
              />
              {mayEdit ? (
                <Input
                  defaultValue={status.name}
                  aria-label={`Name of the ${status.name} column`}
                  className="h-8 max-w-56 text-[13px]"
                  // Enter commits, Escape puts the old name back, and blur
                  // commits too. Blur ALONE was the first version and it is
                  // the wrong single path: a rename that only saves when
                  // focus happens to move is a rename that silently does not
                  // save when it does not — the same "quietly did less than
                  // you asked" shape this codebase keeps finding. Enter is
                  // the one people actually press.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    } else if (e.key === "Escape") {
                      e.currentTarget.value = status.name;
                      e.currentTarget.blur();
                    }
                  }}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (!name) {
                      // Emptied and left: put the name back rather than
                      // sending a blank the store would only refuse.
                      e.target.value = status.name;
                      return;
                    }
                    if (name !== status.name) {
                      void updateStatus(status.id, { name });
                    }
                  }}
                />
              ) : (
                <span className="text-[13px] font-medium">{status.name}</span>
              )}

              <span className="text-[11px] text-muted-foreground">
                {held} {held === 1 ? "task" : "tasks"}
              </span>

              {status.isDone && (
                <span className="flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-px text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="size-3" /> Finished work
                </span>
              )}

              {mayEdit && (
                <div className="ml-auto flex items-center gap-0.5">
                  {!status.isDone && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Mark ${status.name} as the finished column`}
                          onClick={() => void updateStatus(status.id, { isDone: true })}
                        >
                          <Check className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Mark as the finished column</TooltipContent>
                    </Tooltip>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Move ${status.name} earlier`}
                    disabled={i === 0}
                    onClick={() => void move(i, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Move ${status.name} later`}
                    disabled={i === statuses.length - 1}
                    onClick={() => void move(i, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-destructive hover:text-destructive"
                        aria-label={`Remove the ${status.name} column`}
                        onClick={() => void deleteStatus(status.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    {/* The button is never disabled: the refusal explains
                        itself, and a greyed-out control with no reason is the
                        thing that sends people looking for a bug. */}
                    <TooltipContent>
                      {held > 0
                        ? `Move ${held} ${held === 1 ? "task" : "tasks"} out first`
                        : status.isDone
                          ? "Mark another column as finished first"
                          : `Remove ${status.name}`}
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!mayEdit && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          Only an Owner can change the board&apos;s columns.
        </p>
      )}
    </>
  );
}
