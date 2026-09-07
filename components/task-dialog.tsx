"use client";

import * as React from "react";
import { format } from "date-fns";
import { CalendarPlus, Download, Flag, Trash2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";

import {
  downloadICS,
  googleCalendarUrl,
  slugify,
  taskToICS,
} from "@/lib/calendar";
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
import { Textarea } from "@/components/ui/textarea";
import { AttachmentsField } from "@/components/attachments";
import { UserAvatar } from "@/components/user-avatar";
import { useUI } from "@/components/ui-context";
import { canUserSeeProject, normaliseCollaborators, useStore } from "@/lib/store";
import {
  PRIORITIES,
  PRIORITY_META,
  STATUS_META,
  TASK_STATUSES,
  type Attachment,
  type Priority,
  type Task,
  type TaskStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface FormState {
  title: string;
  description: string;
  projectId: string;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string;
  collaboratorIds: string[];
  dueDate: string;
  /** "HH:MM" or "" when the task is date-only / unscheduled. */
  startTime: string;
  /** Minutes, as a Select string. */
  duration: string;
  /** "none" or minutes-before as a Select string. */
  reminder: string;
  labels: string[];
  attachments: Attachment[];
}

const DURATION_OPTIONS = [
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "45", label: "45 min" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
  { value: "120", label: "2 hours" },
];

const REMINDER_OPTIONS = [
  { value: "none", label: "No reminder" },
  { value: "0", label: "At start time" },
  { value: "5", label: "5 min before" },
  { value: "10", label: "10 min before" },
  { value: "15", label: "15 min before" },
  { value: "30", label: "30 min before" },
  { value: "60", label: "1 hour before" },
];

/** Open Google Calendar's event template for a task. A user-gesture
 *  `window.open` is reliable where a `target="_blank"` anchor can be silently
 *  blocked; fall back to same-tab navigation if the popup is blocked. */
function openGoogleCalendar(task: Task, projectName?: string): void {
  const url = googleCalendarUrl(task, projectName);
  if (!url) return;
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) window.location.href = url;
}

export function TaskDialog() {
  const { taskDialog, closeTaskDialog } = useUI();
  const { state, can, canSeeProject, projectAccessLevel, createTask, updateTask, deleteTask } =
    useStore();

  const editing = taskDialog.taskId
    ? state.tasks.find((t) => t.id === taskDialog.taskId)
    : undefined;

  // Projects you can actually create tasks in — visible and editor-level.
  const editableProjects = state.projects.filter(
    (p) => canSeeProject(p) && projectAccessLevel(p) === "editor"
  );

  const [form, setForm] = React.useState<FormState | null>(null);
  // Tracks edit-vs-create mode independently of the live task lookup, so
  // deleting the task mid-dialog doesn't flip the closing dialog into
  // "New task" while it's still animating out with the old field values.
  const [mode, setMode] = React.useState<"create" | "edit">("create");
  // Transient UI state for the collaborators picker — not part of the saved
  // form, reset alongside it whenever the dialog (re)opens.
  const [addCollaboratorId, setAddCollaboratorId] = React.useState("");
  const [pruneNotice, setPruneNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!taskDialog.open) return;
    setAddCollaboratorId("");
    setPruneNotice(null);
    if (editing) {
      setMode("edit");
      setForm({
        title: editing.title,
        description: editing.description,
        projectId: editing.projectId,
        status: editing.status,
        priority: editing.priority,
        assigneeId: editing.assigneeId ?? "none",
        collaboratorIds: [...editing.collaboratorIds],
        dueDate: editing.dueDate ? format(editing.dueDate, "yyyy-MM-dd") : "",
        startTime: editing.startTime ?? "",
        duration: String(editing.durationMinutes ?? 60),
        reminder:
          editing.reminderMinutes == null ? "none" : String(editing.reminderMinutes),
        labels: editing.labels,
        attachments: editing.attachments,
      });
    } else {
      setMode("create");
      setForm({
        title: "",
        description: "",
        projectId: taskDialog.projectId ?? editableProjects[0]?.id ?? "",
        status: taskDialog.status ?? "todo",
        priority: "medium",
        assigneeId: "none",
        collaboratorIds: [],
        dueDate: "",
        startTime: "",
        duration: "60",
        reminder: "none",
        labels: [],
        attachments: [],
      });
    }
    // Re-initialize whenever the dialog is (re)opened for a different target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskDialog.open, taskDialog.taskId, taskDialog.projectId, taskDialog.status]);

  if (!form) return null;

  const isEditing = mode === "edit";
  const editingProject = editing
    ? state.projects.find((p) => p.id === editing.projectId)
    : undefined;
  const projectViewerOnly = editingProject
    ? projectAccessLevel(editingProject) === "viewer"
    : false;

  const readOnly = (isEditing ? !can("task.edit") : !can("task.create")) || projectViewerOnly;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => (f && !readOnly ? { ...f, [key]: value } : f));

  // Scheduling a time only makes sense with a date to hang it on.
  const canSchedule = !!form.dueDate;
  const hasTime = canSchedule && !!form.startTime;

  // Owner + collaborators. `visibleCollaboratorIds` runs the same
  // normalisation the store applies on save, so the picker never shows a
  // state (e.g. the owner also listed as a collaborator) that couldn't
  // actually be persisted.
  const ownerId = form.assigneeId === "none" ? null : form.assigneeId;
  const selectedProject = state.projects.find((p) => p.id === form.projectId);
  const visibleCollaboratorIds = normaliseCollaborators(ownerId, form.collaboratorIds);
  const collaboratorCandidates = selectedProject
    ? state.users.filter(
        (u) =>
          u.id !== ownerId &&
          !visibleCollaboratorIds.includes(u.id) &&
          canUserSeeProject(state, selectedProject, u.id)
      )
    : [];

  const addCollaborator = (userId: string) => {
    if (!userId || readOnly) return;
    set("collaboratorIds", [...form.collaboratorIds, userId]);
    setAddCollaboratorId("");
    setPruneNotice(null);
  };

  const removeCollaborator = (userId: string) => {
    if (readOnly) return;
    set(
      "collaboratorIds",
      form.collaboratorIds.filter((id) => id !== userId)
    );
    setPruneNotice(null);
  };

  // Changing the project can leave collaborators who can't see the new
  // project — prune them and say so, rather than silently dropping them or
  // letting a save fail later.
  const changeProject = (projectId: string) => {
    if (readOnly) return;
    const project = state.projects.find((p) => p.id === projectId);
    const stillVisible = form.collaboratorIds.filter(
      (id) => !project || canUserSeeProject(state, project, id)
    );
    const removed = form.collaboratorIds.length - stillVisible.length;
    setPruneNotice(
      removed > 0
        ? `Removed ${removed} ${removed === 1 ? "person" : "people"} who can't see this project`
        : null
    );
    setForm((f) =>
      f
        ? { ...f, projectId, collaboratorIds: normaliseCollaborators(ownerId, stillVisible) }
        : f
    );
  };

  const save = () => {
    if (readOnly) return;
    const title = form.title.trim();
    if (!title) {
      toast.error("Give the task a title first.");
      return;
    }
    const startTime = hasTime ? form.startTime : null;
    const reminderMinutes =
      startTime && form.reminder !== "none" ? Number(form.reminder) : null;
    // A future reminder needs notification permission — ask now, on this click
    // (a user gesture), so the desktop alert can fire later. The toast + sound
    // fallback work regardless of the answer.
    if (
      reminderMinutes != null &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      void Notification.requestPermission().catch(() => {});
    }
    const payload = {
      title,
      description: form.description.trim(),
      status: form.status,
      priority: form.priority,
      assigneeId: form.assigneeId === "none" ? null : form.assigneeId,
      collaboratorIds: form.collaboratorIds,
      dueDate: form.dueDate
        ? new Date(`${form.dueDate}T00:00:00`).getTime()
        : null,
      startTime,
      durationMinutes: startTime ? Number(form.duration) : null,
      reminderMinutes,
      // Labels are disabled in the UI; preserve any existing values untouched.
      labels: form.labels,
      attachments: form.attachments,
    };
    if (editing) {
      updateTask(editing.id, payload);
      toast.success("Task updated");
    } else {
      if (!form.projectId) {
        toast.error("Pick a project for this task.");
        return;
      }
      createTask({ ...payload, projectId: form.projectId });
      toast.success("Task created", { description: title });
    }
    closeTaskDialog();
  };

  const remove = () => {
    if (!editing) return;
    deleteTask(editing.id);
    toast.success("Task deleted", { description: editing.title });
    closeTaskDialog();
  };

  return (
    <Dialog open={taskDialog.open} onOpenChange={(o) => !o && closeTaskDialog()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {readOnly ? "Task details" : isEditing ? "Edit task" : "New task"}
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? projectViewerOnly
                ? "You have view-only access to this project."
                : "Guests have view-only access to boards."
              : isEditing
                ? "Update the details below."
                : "Add a task to the board. You can refine it anytime."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              autoFocus={!readOnly}
              disabled={readOnly}
              placeholder="e.g. Polish the onboarding flow"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="task-desc">Description</Label>
            <Textarea
              id="task-desc"
              disabled={readOnly}
              placeholder="Add context, links, acceptance criteria…"
              rows={3}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          {!isEditing && (
            <div className="grid gap-1.5">
              <Label>Project</Label>
              <Select
                value={form.projectId}
                onValueChange={changeProject}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a project" />
                </SelectTrigger>
                <SelectContent>
                  {editableProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="mr-1.5">{p.emoji}</span>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select
                value={form.status}
                disabled={readOnly}
                onValueChange={(v) => set("status", v as TaskStatus)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      <span
                        className={cn(
                          "mr-1.5 inline-block size-2 rounded-full",
                          STATUS_META[s].dot
                        )}
                      />
                      {STATUS_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Priority</Label>
              <Select
                value={form.priority}
                disabled={readOnly}
                onValueChange={(v) => set("priority", v as Priority)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      <Flag
                        className={cn(
                          "mr-1.5 inline size-3",
                          PRIORITY_META[p].className
                        )}
                      />
                      {PRIORITY_META[p].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Owner</Label>
              <Select
                value={form.assigneeId}
                disabled={readOnly}
                onValueChange={(v) => set("assigneeId", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    <span className="text-muted-foreground">Unassigned</span>
                  </SelectItem>
                  {state.users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      <span className="flex items-center gap-1.5">
                        <UserAvatar user={u} size="xs" />
                        {u.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input
                id="task-due"
                type="date"
                disabled={readOnly}
                value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Collaborators</Label>
            {visibleCollaboratorIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {visibleCollaboratorIds.map((id) => {
                  const user = state.users.find((u) => u.id === id);
                  if (!user) return null;
                  return (
                    <span
                      key={id}
                      className="flex items-center gap-1.5 rounded-full border bg-muted/40 py-1 pr-1 pl-1.5"
                    >
                      <UserAvatar user={user} size="xs" />
                      <span className="text-[12px] font-medium">{user.name}</span>
                      {!readOnly && (
                        <button
                          type="button"
                          aria-label={`Remove ${user.name} as a collaborator`}
                          onClick={() => removeCollaborator(id)}
                          className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-destructive"
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
            {!readOnly && collaboratorCandidates.length > 0 && (
              <Select value={addCollaboratorId} onValueChange={addCollaborator}>
                <SelectTrigger className="h-8 text-xs">
                  <UserPlus className="size-3.5 text-muted-foreground" />
                  <SelectValue placeholder="Add person…" />
                </SelectTrigger>
                <SelectContent>
                  {collaboratorCandidates.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      <span className="flex items-center gap-1.5">
                        <UserAvatar user={u} size="xs" />
                        {u.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {visibleCollaboratorIds.length === 0 &&
              (readOnly || collaboratorCandidates.length === 0) && (
                <p className="text-[11px] text-muted-foreground">No collaborators yet.</p>
              )}
            {pruneNotice && (
              <p className="text-[11px] text-muted-foreground">{pruneNotice}</p>
            )}
          </div>

          {/* Scheduling — time, duration, and an in-app reminder. */}
          <div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-1.5">
              <CalendarPlus className="size-3.5 text-muted-foreground" />
              <Label className="text-xs">Schedule</Label>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="task-time" className="text-[11px] text-muted-foreground">
                  Start time
                </Label>
                <Input
                  id="task-time"
                  type="time"
                  disabled={readOnly || !canSchedule}
                  value={form.startTime}
                  onChange={(e) => set("startTime", e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-[11px] text-muted-foreground">Duration</Label>
                <Select
                  value={form.duration}
                  disabled={readOnly || !hasTime}
                  onValueChange={(v) => set("duration", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-[11px] text-muted-foreground">Reminder</Label>
                <Select
                  value={form.reminder}
                  disabled={readOnly || !hasTime}
                  onValueChange={(v) => set("reminder", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REMINDER_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {!canSchedule ? (
              <p className="text-[11px] text-muted-foreground">
                Add a due date to schedule a time and reminder.
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {hasTime
                  ? "Reminders pop up in Lumina with a sound and a desktop notification."
                  : "Set a start time to enable duration and reminders."}
              </p>
            )}

            {/* Optional one-off export of the saved task to an external calendar. */}
            {isEditing && editing?.dueDate != null && (
              <div className="flex flex-wrap items-center gap-2 border-t pt-2">
                <span className="text-[11px] text-muted-foreground">
                  Add to calendar:
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[11px]"
                  onClick={() => openGoogleCalendar(editing, editingProject?.name)}
                >
                  <CalendarPlus className="size-3.5" />
                  Google Calendar
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[11px]"
                  onClick={() =>
                    downloadICS(slugify(editing.title), taskToICS(editing))
                  }
                >
                  <Download className="size-3.5" />
                  Download .ics
                </Button>
              </div>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>Attachments</Label>
            <AttachmentsField
              attachments={form.attachments}
              disabled={readOnly}
              onAdd={(added) => set("attachments", [...form.attachments, ...added])}
              onRemove={(id) =>
                set(
                  "attachments",
                  form.attachments.filter((a) => a.id !== id)
                )
              }
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {isEditing && can("task.delete") ? (
            <Button variant="ghost" size="sm" onClick={remove} className="text-destructive hover:text-destructive">
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={closeTaskDialog}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button size="sm" onClick={save}>
                {isEditing ? "Save changes" : "Create task"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
