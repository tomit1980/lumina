"use client";

import * as React from "react";
import Link from "next/link";
import { addDays, format, formatDistanceToNow } from "date-fns";
import { motion } from "framer-motion";
import {
  CalendarClock,
  CheckCircle2,
  CheckSquare,
  Circle,
  Flag,
  FolderKanban,
  Hash,
  Inbox,
  Megaphone,
  MessageSquare,
  Plus,
  UserRound,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { useUI } from "@/components/ui-context";
import { isMine } from "@/lib/permissions";
import { canUserSeeTaskProject, getUnreadCount, useStore } from "@/lib/store";
import { PRIORITY_META, type ActivityKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { chatHref, projectHref } from "@/lib/routes";

const ACTIVITY_ICON: Record<ActivityKind, React.ReactNode> = {
  task: <CheckSquare className="size-3" />,
  message: <MessageSquare className="size-3" />,
  channel: <Hash className="size-3" />,
  member: <Users className="size-3" />,
  project: <FolderKanban className="size-3" />,
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Burning the midnight oil";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function HomePage() {
  const { state, currentUser, can, canSeeChannel, updateTask } = useStore();
  const { openTaskDialog, setChannelDialogOpen, openProjectDialog } = useUI();

  const firstName = currentUser.name.split(" ")[0];
  const mayEditTasks = can("task.edit");
  const teamChannel = state.channels.find((c) => c.isTeam);

  // `isMine` alone doesn't ask whether the user can still see the task's
  // project — a revoked collaborator (or an owner whose access changed
  // since) would otherwise keep seeing the task's title here even though
  // the database would no longer return the row at all.
  const myOpenTasks = state.tasks
    .filter(
      (t) =>
        isMine(t, currentUser.id) &&
        canUserSeeTaskProject(state, t, currentUser.id) &&
        t.status !== "done"
    )
    .sort((a, b) => {
      // Owned tasks first, then collaborated-on ones; due date breaks ties
      // within each group.
      const aOwned = a.assigneeId === currentUser.id ? 0 : 1;
      const bOwned = b.assigneeId === currentUser.id ? 0 : 1;
      if (aOwned !== bOwned) return aOwned - bOwned;
      const ad = a.dueDate ?? Number.MAX_SAFE_INTEGER;
      const bd = b.dueDate ?? Number.MAX_SAFE_INTEGER;
      return ad - bd;
    });

  const dueSoon = myOpenTasks.filter(
    (t) => t.dueDate !== null && t.dueDate <= addDays(new Date(), 7).getTime()
  ).length;

  const unreadTotal =
    state.channels
      .filter((c) => canSeeChannel(c))
      .reduce((acc, c) => acc + getUnreadCount(state, currentUser.id, c.id), 0) +
    state.dms
      .filter((d) => d.memberIds.includes(currentUser.id))
      .reduce((acc, d) => acc + getUnreadCount(state, currentUser.id, d.id), 0);

  const completedByMe = state.tasks.filter(
    (t) =>
      isMine(t, currentUser.id) &&
      canUserSeeTaskProject(state, t, currentUser.id) &&
      t.status === "done"
  ).length;

  const activities = [...state.activities].sort((a, b) => b.ts - a.ts).slice(0, 8);

  const stats = [
    {
      label: "Open tasks",
      value: myOpenTasks.length,
      icon: <Circle className="size-4 text-sky-500" />,
    },
    {
      label: "Due in 7 days",
      value: dueSoon,
      icon: <CalendarClock className="size-4 text-amber-500" />,
    },
    {
      label: "Unread messages",
      value: unreadTotal,
      icon: <Inbox className="size-4 text-violet-500" />,
    },
    {
      label: "Completed",
      value: completedByMe,
      icon: <CheckCircle2 className="size-4 text-emerald-500" />,
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[13px] text-muted-foreground">
              {format(new Date(), "EEEE, MMMM d")}
            </p>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight">
              {greeting()}, {firstName} 👋
            </h1>
          </div>
          <div className="flex gap-2">
            {teamChannel && (
              <Button size="sm" variant="outline" asChild>
                <Link href={chatHref(teamChannel.id)}>
                  <Megaphone className="size-3.5" />
                  Message the team
                </Link>
              </Button>
            )}
            {can("task.create") && (
              <Button size="sm" onClick={() => openTaskDialog()}>
                <Plus className="size-3.5" />
                New task
              </Button>
            )}
            {can("channel.create") && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setChannelDialogOpen(true)}
              >
                <Hash className="size-3.5" />
                New channel
              </Button>
            )}
            {can("project.create") && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openProjectDialog()}
              >
                <FolderKanban className="size-3.5" />
                New project
              </Button>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, duration: 0.25, ease: "easeOut" }}
            >
              <Card className="py-4">
                <CardContent className="flex items-center gap-3 px-4">
                  <div className="flex size-9 items-center justify-center rounded-xl bg-muted">
                    {stat.icon}
                  </div>
                  <div>
                    <div className="text-lg leading-none font-semibold tabular-nums">
                      {stat.value}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {stat.label}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-[3fr_2fr]">
          {/* My tasks */}
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
              <UserRound className="size-3.5 text-muted-foreground" />
              My tasks
            </h2>
            {myOpenTasks.length > 0 ? (
              <div className="overflow-hidden rounded-xl border">
                {myOpenTasks.slice(0, 8).map((task, i) => {
                  const project = state.projects.find((p) => p.id === task.projectId);
                  return (
                    <div
                      key={task.id}
                      className={cn(
                        "group flex items-center gap-2.5 bg-card px-3 py-2.5 transition-colors hover:bg-muted/50",
                        i > 0 && "border-t"
                      )}
                    >
                      {mayEditTasks && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              className="text-muted-foreground/50 transition-colors hover:text-emerald-500"
                              aria-label={`Mark "${task.title}" complete`}
                              onClick={async () => {
                                // `task.edit` gates this button, but the store
                                // also refuses viewer-only members of a
                                // restricted project — don't celebrate a write
                                // that was turned down.
                                if (!(await updateTask(task.id, { status: "done" }))) {
                                  return;
                                }
                                toast.success("Nice — task completed!", {
                                  description: task.title,
                                });
                              }}
                            >
                              <Circle className="size-4 group-hover:hidden" />
                              <CheckCircle2 className="hidden size-4 group-hover:block" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Mark done</TooltipContent>
                        </Tooltip>
                      )}
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => openTaskDialog({ taskId: task.id })}
                      >
                        <span className="truncate text-[13px] font-medium">
                          {task.title}
                        </span>
                        <Flag
                          className={cn(
                            "size-3 shrink-0",
                            PRIORITY_META[task.priority].className
                          )}
                        />
                      </button>
                      {task.dueDate !== null && (
                        <span
                          className={cn(
                            "shrink-0 text-[11px]",
                            task.dueDate < Date.now()
                              ? "font-medium text-red-500"
                              : "text-muted-foreground"
                          )}
                        >
                          {format(task.dueDate, "MMM d")}
                        </span>
                      )}
                      {project && (
                        <Link
                          href={projectHref(project.id)}
                          className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {project.emoji} {project.name}
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-center">
                <CheckCircle2 className="size-6 text-emerald-500" />
                <p className="text-sm font-medium">All clear!</p>
                <p className="text-xs text-muted-foreground">
                  Nothing assigned to you right now.
                </p>
              </div>
            )}
          </section>

          {/* Activity */}
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
              <MessageSquare className="size-3.5 text-muted-foreground" />
              Recent activity
            </h2>
            <div className="flex flex-col gap-1">
              {activities.map((a) => {
                const actor = state.users.find((u) => u.id === a.actorId);
                return (
                  <div key={a.id} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5">
                    {actor ? (
                      <UserAvatar user={actor} size="sm" className="mt-0.5" />
                    ) : (
                      <span className="mt-0.5 flex size-6 items-center justify-center rounded-full bg-muted">
                        {ACTIVITY_ICON[a.kind]}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-xs leading-snug">
                        <span className="font-semibold">{actor?.name ?? "Someone"}</span>{" "}
                        <span className="text-foreground/80">{a.text}</span>
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {formatDistanceToNow(a.ts, { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                );
              })}
              {activities.length === 0 && (
                <p className="rounded-xl border border-dashed py-8 text-center text-xs text-muted-foreground">
                  Activity from your team will show up here.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
