"use client";

import * as React from "react";
import { format } from "date-fns";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";

import { taskEvent } from "@/lib/calendar";
import { useStore } from "@/lib/store";

/**
 * Native, backend-free reminders for the current user's scheduled tasks.
 *
 * Since there's no calendar server to subscribe to, reminders fire in-app off a
 * lightweight poll: a sonner toast (always), a desktop Notification (when the
 * user has granted permission), and a short WebAudio chime (unless muted). It
 * always reads live task data, so there's no import/export loop to keep current.
 * Only timed tasks assigned to (or personally owned by) the current user fire.
 */

const SOUND_KEY = "lumina:reminder-sound";
const FIRED_KEY = "lumina:reminded";
const MAX_FIRED = 300;

export function getReminderSound(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(SOUND_KEY) !== "0";
}

export function setReminderSound(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable — sound stays on for this session.
  }
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function loadFired(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FIRED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveFired(set: Set<string>): void {
  try {
    window.localStorage.setItem(
      FIRED_KEY,
      JSON.stringify([...set].slice(-MAX_FIRED))
    );
  } catch {
    // Non-fatal: at worst a reminder could repeat after a reload.
  }
}

/** A brief two-note chime via WebAudio (no asset needed). */
function playChime(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const start = ctx.currentTime;
    [880, 1174.66].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = start + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 1200);
  } catch {
    // Autoplay blocked or WebAudio missing — the toast still shows.
  }
}

export function Reminders() {
  const { state, currentUser } = useStore();

  // Keep the interval reading fresh data without re-subscribing every render.
  const dataRef = React.useRef({ tasks: state.tasks, userId: currentUser.id });
  dataRef.current = { tasks: state.tasks, userId: currentUser.id };

  React.useEffect(() => {
    const fired = loadFired();

    const fire = (title: string, start: Date, startMs: number, now: number) => {
      const mins = Math.round((startMs - now) / 60_000);
      const lead =
        mins <= 0
          ? "now"
          : mins === 1
            ? "in 1 minute"
            : mins < 60
              ? `in ${mins} minutes`
              : `at ${format(start, "p")}`;
      const body = `Starts ${lead} · ${format(start, "p")}`;
      toast(title, {
        description: body,
        icon: <CalendarClock className="size-4" />,
        duration: 10_000,
      });
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification(`⏰ ${title}`, { body, tag: `lumina-${startMs}` });
        } catch {
          // Some browsers throw when constructing without a service worker.
        }
      }
      if (getReminderSound()) playChime();
    };

    const tick = () => {
      const { tasks, userId } = dataRef.current;
      const now = Date.now();
      for (const task of tasks) {
        if (
          task.reminderMinutes == null ||
          !task.startTime ||
          task.dueDate == null ||
          task.status === "done"
        ) {
          continue;
        }
        const mine =
          task.assigneeId === userId ||
          (task.assigneeId == null && task.createdBy === userId);
        if (!mine) continue;

        const ev = taskEvent(task);
        if (!ev || ev.allDay) continue;

        const startMs = ev.start.getTime();
        const endMs = ev.end.getTime();
        const fireAt = startMs - task.reminderMinutes * 60_000;
        const key = `${task.id}:${startMs}:${task.reminderMinutes}`;

        // Fire once the lead time is reached, up until the event ends — so a
        // tab opened mid-window still gets reminded, but stale past events don't.
        if (now >= fireAt && now < endMs && !fired.has(key)) {
          fired.add(key);
          saveFired(fired);
          fire(task.title, ev.start, startMs, now);
        }
      }
    };

    tick();
    const interval = window.setInterval(tick, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  return null;
}
