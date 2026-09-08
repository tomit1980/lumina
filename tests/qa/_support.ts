// Shared harness for the QA suites in tests/qa/. Not a test file itself
// (doesn't match tests/**/*.test.ts), just imported by the ones that are.
import * as React from "react";
import { act, renderHook } from "@testing-library/react";

import { StoreProvider, useStore } from "@/lib/store";
import { createSeed } from "@/lib/seed";
import type {
  AppState,
  Channel,
  Permission,
  Project,
  RoleDef,
  Task,
  TaskStatus,
  Priority,
  User,
} from "@/lib/types";

export const STORAGE_KEY = "lumina:v1";

export type Store = ReturnType<typeof useStore>;

/** Deep clone via JSON — safe since AppState is exactly what's persisted. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A fresh copy of the seeded demo workspace (u_vlad/admin, u_maya|u_jonas|
 *  u_priya|u_sam/member, u_elena/guest). Mutate the copy, don't share it. */
export function baseState(): AppState {
  return createSeed();
}

export function asUser(state: AppState, userId: string): AppState {
  return { ...state, currentUserId: userId };
}

export function addUser(
  state: AppState,
  user: { id: string; roleId: string } & Partial<Omit<User, "id" | "roleId">>
): AppState {
  const withDefaults: User = {
    name: user.id,
    handle: user.id,
    title: "",
    color: "#000000",
    presence: "online",
    ...user,
  };
  return { ...state, users: [...state.users, withDefaults] };
}

export function addRole(
  state: AppState,
  role: { id: string; name: string; permissions: Permission[] } & Partial<
    Omit<RoleDef, "id" | "name" | "permissions">
  >
): AppState {
  const withDefaults: RoleDef = {
    description: "",
    color: "#000000",
    ...role,
  };
  return { ...state, roles: [...state.roles, withDefaults] };
}

export function addChannel(
  state: AppState,
  channel: { id: string; name: string; createdBy: string } & Partial<
    Omit<Channel, "id" | "name" | "createdBy">
  >
): AppState {
  const withDefaults: Channel = {
    description: "",
    isPrivate: false,
    members: [],
    createdAt: Date.now(),
    ...channel,
  };
  return { ...state, channels: [...state.channels, withDefaults] };
}

export function addProject(
  state: AppState,
  project: { id: string; name: string; createdBy: string } & Partial<
    Omit<Project, "id" | "name" | "createdBy">
  >
): AppState {
  const withDefaults: Project = {
    description: "",
    emoji: "🧪",
    color: "#000000",
    priority: "medium",
    restricted: false,
    members: [],
    attachments: [],
    createdAt: Date.now(),
    ...project,
  };
  return { ...state, projects: [...state.projects, withDefaults] };
}

export function addTask(
  state: AppState,
  task: { id: string; projectId: string; title: string; createdBy: string } & Partial<
    Omit<Task, "id" | "projectId" | "title" | "createdBy">
  >
): AppState {
  const withDefaults: Task = {
    description: "",
    status: "todo" as TaskStatus,
    priority: "medium" as Priority,
    assigneeId: null,
    dueDate: null,
    startTime: null,
    durationMinutes: null,
    reminderMinutes: null,
    labels: [],
    attachments: [],
    order: 0,
    createdAt: Date.now(),
    collaboratorIds: [],
    ...task,
  };
  return { ...state, tasks: [...state.tasks, withDefaults] };
}

/** Seeds localStorage and mounts StoreProvider, returning the live
 *  (auto-refreshing) store handle. Wrap actions in `run()` to flush them. */
export function mount(state: AppState) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(StoreProvider, null, children);
  }
  const { result, unmount } = renderHook(() => useStore(), { wrapper: Wrapper });
  return { result, unmount };
}

/** Mounts StoreProvider against whatever is already in localStorage,
 *  without writing to it first — for tests that craft a raw (pre-migration
 *  shaped) payload by hand and want to see how `migrate()` handles it. */
export function mountFromExistingStorage() {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(StoreProvider, null, children);
  }
  const { result, unmount } = renderHook(() => useStore(), { wrapper: Wrapper });
  return { result, unmount };
}

/** Runs a store action inside act() and returns whatever it returned, so
 *  `result.current` reflects the resulting state by the time this resolves.
 *
 *  Await-ready for the store-swap: every store action becomes `Promise<T>`
 *  once the backend seam lands (Task 1), and `await`ing a value that is
 *  already a plain `T` is a no-op — so this same signature works unchanged
 *  against today's fully synchronous store. `act`'s async form is used
 *  unconditionally so that, once actions are truly async, React gets to
 *  flush the state update the promise resolution triggers before this
 *  returns; against a synchronous action that flush is already done by the
 *  time `fn()` returns, so nothing changes for the tests running today. */
export async function run<T>(fn: () => T | Promise<T>): Promise<T> {
  let out!: T;
  await act(async () => {
    out = await fn();
  });
  return out;
}
