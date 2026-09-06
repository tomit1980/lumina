import type { Task } from "./types";

/**
 * Backend-free calendar interop for Lumina tasks.
 *
 * There's no server to host a live-updating calendar feed, so "sync" here means
 * two standard, offline-friendly exports:
 *   • a downloadable .ics (iCalendar) file — imports into Windows Calendar,
 *     Outlook, Apple Calendar, or Google Calendar, and can carry a reminder
 *     (VALARM);
 *   • a one-click "Add to Google Calendar" template link.
 * For always-current, no-import reminders, the app fires them natively (see
 * components/reminders.tsx). A true auto-syncing subscription would need a
 * hosted feed URL — a v2/backend concern.
 */

export interface TaskEvent {
  start: Date;
  end: Date;
  /** All-day when the task has a date but no specific start time. */
  allDay: boolean;
}

/** Resolve a task's calendar event from its date + optional time/duration.
 *  Returns null when the task has no date — nothing to place on a calendar. */
export function taskEvent(task: Task): TaskEvent | null {
  if (task.dueDate == null) return null;
  const base = new Date(task.dueDate); // local midnight of the due day
  const y = base.getFullYear();
  const mo = base.getMonth();
  const d = base.getDate();

  if (!task.startTime) {
    return {
      start: new Date(y, mo, d),
      end: new Date(y, mo, d + 1),
      allDay: true,
    };
  }

  const [h, m] = task.startTime.split(":").map((n) => Number(n));
  const start = new Date(y, mo, d, h || 0, m || 0);
  const minutes =
    task.durationMinutes && task.durationMinutes > 0 ? task.durationMinutes : 60;
  const end = new Date(start.getTime() + minutes * 60_000);
  return { start, end, allDay: false };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC stamp for iCalendar / Google, e.g. 20260714T133000Z. */
function icsUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Local calendar date, e.g. 20260714 — used for all-day events. */
function icsDate(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Escape a value for an iCalendar text field (RFC 5545). */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** A prefilled "Add to Google Calendar" URL, or null when the task has no date. */
export function googleCalendarUrl(task: Task, projectName?: string): string | null {
  const ev = taskEvent(task);
  if (!ev) return null;
  const dates = ev.allDay
    ? `${icsDate(ev.start)}/${icsDate(ev.end)}`
    : `${icsUtc(ev.start)}/${icsUtc(ev.end)}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: task.title,
    dates,
  });
  const details = [
    task.description,
    projectName ? `Project: ${projectName}` : "",
    "Scheduled in Lumina",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (details) params.set("details", details);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function veventLines(task: Task, ev: TaskEvent): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${task.id}@lumina.local`,
    `DTSTAMP:${icsUtc(new Date())}`,
  ];
  if (ev.allDay) {
    lines.push(
      `DTSTART;VALUE=DATE:${icsDate(ev.start)}`,
      `DTEND;VALUE=DATE:${icsDate(ev.end)}`
    );
  } else {
    lines.push(`DTSTART:${icsUtc(ev.start)}`, `DTEND:${icsUtc(ev.end)}`);
  }
  lines.push(`SUMMARY:${escapeText(task.title)}`);
  if (task.description) lines.push(`DESCRIPTION:${escapeText(task.description)}`);
  // A timed reminder maps cleanly to a VALARM; all-day tasks skip it.
  if (!ev.allDay && task.reminderMinutes != null) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(task.title)}`,
      `TRIGGER:-PT${task.reminderMinutes}M`,
      "END:VALARM"
    );
  }
  lines.push("END:VEVENT");
  return lines;
}

/** Serialize one or more dated tasks to an iCalendar document (CRLF-joined). */
export function tasksToICS(tasks: Task[], calName = "Lumina"): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lumina//Tasks//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calName)}`,
  ];
  for (const task of tasks) {
    const ev = taskEvent(task);
    if (ev) lines.push(...veventLines(task, ev));
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export function taskToICS(task: Task): string {
  return tasksToICS([task], task.title);
}

/** Trigger a browser download of an .ics file built in-memory. */
export function downloadICS(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".ics") ? filename : `${filename}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filesystem-safe slug for filenames. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "lumina"
  );
}
