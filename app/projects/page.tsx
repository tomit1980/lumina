"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Flag, FolderKanban, ListFilter, Lock, Paperclip, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AttachmentsField } from "@/components/attachments";
import { Board } from "@/components/kanban/board";
import { ListView } from "@/components/kanban/list-view";
import { useUI } from "@/components/ui-context";
import { useStore } from "@/lib/store";
import { PRIORITIES, PRIORITY_META, type Priority } from "@/lib/types";
import { cn } from "@/lib/utils";

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

export default function ProjectPage() {
  // useSearchParams needs a Suspense boundary for static export.
  return (
    <React.Suspense fallback={null}>
      <ProjectPageInner />
    </React.Suspense>
  );
}

function ProjectPageInner() {
  const projectId = useSearchParams().get("id");
  const router = useRouter();
  const { state, can, canSeeProject, projectAccessLevel, updateProject, deleteProject } =
    useStore();
  const { openTaskDialog, openProjectDialog, openAccessDialog, openShareFileDialog } =
    useUI();
  const canEditProject = can("project.create");

  const [view, setView] = React.useState<"board" | "list" | "files">("board");
  const [assigneeFilter, setAssigneeFilter] = React.useState("all");
  const [priorityFilter, setPriorityFilter] = React.useState("all");

  const project = state.projects.find((p) => p.id === projectId);

  if (!project) {
    return (
      <EmptyState
        icon={<FolderKanban className="size-6 text-muted-foreground" />}
        title="Project not found"
        body="It may have been deleted, or the link is stale."
      />
    );
  }

  if (!canSeeProject(project)) {
    return (
      <EmptyState
        icon={<Lock className="size-6 text-amber-600 dark:text-amber-400" />}
        title="This project is restricted"
        body="Ask an admin to invite you if you need access."
      />
    );
  }

  const viewerOnly = projectAccessLevel(project) === "viewer";
  const canManageFiles = canEditProject && !viewerOnly;
  const allTasks = state.tasks.filter((t) => t.projectId === project.id);
  const tasks = allTasks.filter(
    (t) =>
      (assigneeFilter === "all" ||
        (assigneeFilter === "unassigned"
          ? t.assigneeId === null
          : t.assigneeId === assigneeFilter)) &&
      (priorityFilter === "all" || t.priority === priorityFilter)
  );

  const done = allTasks.filter((t) => t.status === "done").length;
  const progress = allTasks.length > 0 ? Math.round((done / allTasks.length) * 100) : 0;
  const filtering = assigneeFilter !== "all" || priorityFilter !== "all";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-6 pt-5 pb-0">
        <div className="flex flex-wrap items-center gap-3">
          <div
            className="flex size-9 items-center justify-center rounded-xl text-lg"
            style={{ backgroundColor: `${project.color}22` }}
          >
            {project.emoji}
          </div>
          <div className="min-w-0 flex-1">
            {canEditProject ? (
              <button
                onClick={() => openProjectDialog(project.id)}
                className="group/name flex max-w-full items-center gap-1.5"
                title="Rename project"
              >
                <h1 className="truncate text-base font-semibold tracking-tight group-hover/name:underline">
                  {project.name}
                </h1>
                <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/name:opacity-100" />
              </button>
            ) : (
              <h1 className="truncate text-base font-semibold tracking-tight">
                {project.name}
              </h1>
            )}
            <p className="truncate text-xs text-muted-foreground">
              {project.description}
            </p>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-1 text-[11px] font-medium",
                  PRIORITY_META[project.priority].className
                )}
              >
                <Flag className="size-3" />
                {PRIORITY_META[project.priority].label}
              </span>
            </TooltipTrigger>
            <TooltipContent>{PRIORITY_META[project.priority].label} priority project</TooltipContent>
          </Tooltip>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 sm:flex">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-[11px] font-medium text-muted-foreground">
                {done}/{allTasks.length} done
              </span>
            </div>

            {can("task.create") && !viewerOnly && (
              <Button
                size="sm"
                onClick={() => openTaskDialog({ projectId: project.id })}
              >
                <Plus className="size-3.5" />
                New task
              </Button>
            )}

            {(canEditProject || can("project.delete")) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8 text-muted-foreground">
                    <span className="text-base leading-none">⋯</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canEditProject && (
                    <DropdownMenuItem onSelect={() => openProjectDialog(project.id)}>
                      <Pencil className="size-4" />
                      Edit project
                    </DropdownMenuItem>
                  )}
                  {canEditProject && (
                    <DropdownMenuItem
                      onSelect={() => openAccessDialog("project", project.id)}
                    >
                      <ShieldCheck className="size-4" />
                      Manage access
                    </DropdownMenuItem>
                  )}
                  {can("project.delete") && (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        deleteProject(project.id);
                        toast.success(`Project “${project.name}” deleted`);
                        router.push("/");
                      }}
                    >
                      <Trash2 className="size-4" />
                      Delete project
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 pb-3">
          <Tabs value={view} onValueChange={(v) => setView(v as "board" | "list" | "files")}>
            <TabsList className="h-8">
              <TabsTrigger value="board" className="text-xs">
                Board
              </TabsTrigger>
              <TabsTrigger value="list" className="text-xs">
                List
              </TabsTrigger>
              <TabsTrigger value="files" className="gap-1.5 text-xs">
                Files
                {project.attachments.length > 0 && (
                  <Badge className="h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums">
                    {project.attachments.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {view !== "files" && (
            <div className="ml-auto flex items-center gap-2">
              <ListFilter
                className={cn(
                  "size-3.5",
                  filtering ? "text-primary" : "text-muted-foreground"
                )}
              />
              <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
                <SelectTrigger size="sm" className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All assignees</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {state.users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                <SelectTrigger size="sm" className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  {PRIORITIES.map((p: Priority) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_META[p].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filtering && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground"
                  onClick={() => {
                    setAssigneeFilter("all");
                    setPriorityFilter("all");
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {view === "board" ? (
          <Board project={project} tasks={tasks} viewerOnly={viewerOnly} />
        ) : view === "list" ? (
          <ListView tasks={tasks} viewerOnly={viewerOnly} />
        ) : (
          <div className="mx-auto h-full max-w-lg overflow-y-auto px-6 py-6">
            {project.attachments.length === 0 && canManageFiles && (
              <div className="mb-4 flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-center">
                <Paperclip className="size-5 text-muted-foreground" />
                <p className="text-sm font-medium">No files yet</p>
                <p className="text-xs text-muted-foreground">
                  Attach briefs, mockups, or reference docs for the whole project.
                </p>
              </div>
            )}
            <AttachmentsField
              attachments={project.attachments}
              disabled={!canManageFiles}
              onShare={
                can("message.send")
                  ? (id) => openShareFileDialog(project.id, id)
                  : undefined
              }
              onAdd={(added) =>
                updateProject(project.id, {
                  attachments: [...project.attachments, ...added],
                })
              }
              onRemove={(id) =>
                updateProject(project.id, {
                  attachments: project.attachments.filter((a) => a.id !== id),
                })
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
