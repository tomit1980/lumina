// @vitest-environment jsdom
//
// Suite — the activity feed actually reaches the backend.
//
// tests/qa/activity-scope.test.ts proves each `activity(...)` call site attaches
// the right SCOPE. It proves nothing about the row ever leaving the tab, and
// until `Backend.putActivity` existed it never did: the store's optimistic
// patch put the line in `AppState`, `SupabaseBackend` had no method to write it
// with, and the line disappeared on the next reload. A feed that shows what did
// not persist is the exact failure this project has spent days hunting, so it
// gets its own gate.
//
// Two halves, and the second is the one that is easy to get wrong:
//
//   1. the line reaches `Backend.putActivity` — one representative action per
//      family (member, channel, project, task, message), plus the multi-line
//      case, plus a negative that a write logging nothing calls it not at all;
//   2. a REFUSED line does not undo the write it describes, and does not stay
//      on screen either. An activity is an append-only record about a change,
//      not part of it. Rolling a real project back because its feed row was
//      rejected would be a worse lie than a missing feed row — but so would
//      leaving a line up that a reload will not show.
//
// `FailingBackend` records every activity it is handed (`activityWrites`) and
// can be told to reject `putActivity`, which is what makes half 2 observable.
// Recording lives on the double rather than on a bespoke stub here so the next
// suite that needs it does not roll its own — and so `putActivity` is in the
// `FailingOp` union, without which naming it would silently give a "failing"
// backend that succeeds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import {
  addChannel, addProject, addTask, asUser, baseState, FailingBackend, mount, run,
} from "./_support";
import type { AppState, MessageAttachment } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

/** An admin (u_vlad in the seed) plus a project, a task and a channel. */
function workspace(): AppState {
  let state = baseState();
  state = addProject(state, { id: "p_log", name: "Payroll", createdBy: "u_vlad" });
  state = addTask(state, {
    id: "t_log", projectId: "p_log", title: "Ship it", createdBy: "u_vlad",
  });
  state = addChannel(state, { id: "c_log", name: "launch", createdBy: "u_vlad" });
  return asUser(state, "u_vlad");
}

const file = (id: string): MessageAttachment => ({
  id, name: "notes.txt", size: 10, type: "text/plain", dataUrl: "data:,",
  uploadedBy: "u_vlad", uploadedAt: Date.now(),
});

/** A backend that records but never rejects: `"putActivity"` would be the
 *  failing op, so naming an op nothing uses keeps every write succeeding. */
function recording() {
  return new FailingBackend("deleteMessage");
}

describe("every family's activity reaches the backend", () => {
  it("member: setUserRole writes its workspace-wide line", async () => {
    const backend = recording();
    const { result } = await mount(workspace(), backend);

    await run(() => result.current.setUserRole("u_maya", "guest"));

    expect(backend.activityWrites).toHaveLength(1);
    const [a] = backend.activityWrites;
    expect(a.kind).toBe("member");
    expect(a.text).toContain("Maya");
    expect(a.projectId).toBeNull();
    expect(a.conversationId).toBeNull();
    // The row handed to the backend is the row on screen — same id, not a
    // second copy composed somewhere else.
    expect(result.current.state.activities.at(-1)!.id).toBe(a.id);
  });

  it("channel: createChannel writes a line scoped to the new conversation", async () => {
    const backend = recording();
    const { result } = await mount(workspace(), backend);

    const channel = await run(() =>
      result.current.createChannel({ name: "ops", description: "", isPrivate: false })
    );

    expect(backend.activityWrites).toHaveLength(1);
    expect(backend.activityWrites[0].conversationId).toBe(channel!.id);
    expect(backend.activityWrites[0].projectId).toBeNull();
  });

  it("project: createProject writes a line scoped to the new project", async () => {
    const backend = recording();
    const { result } = await mount(workspace(), backend);

    const project = await run(() =>
      result.current.createProject({
        name: "Rebrand", description: "", emoji: "🎨", color: "#000", priority: "high",
      })
    );

    expect(backend.activityWrites).toHaveLength(1);
    expect(backend.activityWrites[0].text).toBe("created the Rebrand project");
    expect(backend.activityWrites[0].projectId).toBe(project!.id);
  });

  it("task: createTask writes a line scoped to the owning project", async () => {
    const backend = recording();
    const { result } = await mount(workspace(), backend);

    await run(() =>
      result.current.createTask({
        projectId: "p_log", title: "Fresh", description: "", status: "todo",
        priority: "medium", assigneeId: null, dueDate: null, startTime: null,
        durationMinutes: null, reminderMinutes: null, labels: [], attachments: [],
      })
    );

    expect(backend.activityWrites).toHaveLength(1);
    expect(backend.activityWrites[0].kind).toBe("task");
    expect(backend.activityWrites[0].projectId).toBe("p_log");
  });

  it("message: a file share writes a line scoped to the conversation", async () => {
    const backend = recording();
    const { result } = await mount(workspace(), backend);

    await run(() => result.current.sendMessage("c_log", "here", [file("att_1")]));

    expect(backend.activityWrites).toHaveLength(1);
    expect(backend.activityWrites[0].kind).toBe("message");
    expect(backend.activityWrites[0].conversationId).toBe("c_log");
  });

  it("writes EVERY line when one action logs several", async () => {
    // updateTask emits one line per person added or removed (plus the rename).
    // A `putActivity` wired to `activities.at(-1)` would pass every test above
    // and silently drop all but the last of these.
    const backend = recording();
    const { result } = await mount(workspace(), backend);

    await run(() =>
      result.current.updateTask("t_log", {
        assigneeId: "u_maya",
        collaboratorIds: ["u_jonas"],
      })
    );

    const texts = backend.activityWrites.map((a) => a.text);
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes("assigned"))).toBe(true);
    expect(texts.some((t) => t.includes("added"))).toBe(true);
    expect(backend.activityWrites.every((a) => a.projectId === "p_log")).toBe(true);
  });

  it("does not call putActivity for a write that logs nothing", async () => {
    // Negative control for the six positives above: if `commit` simply wrote
    // the last activity on every write, this would log the seed's most recent
    // line again — a duplicate row, and one attributed to the wrong action.
    const backend = recording();
    const { result } = await mount(workspace(), backend);

    await run(() => result.current.updateRole("member", { description: "Regulars" }));

    expect(backend.activityWrites).toEqual([]);
  });

  it("does not call putActivity when the write itself failed", async () => {
    // The line describes something that did not happen. Rolled back, not logged.
    const backend = new FailingBackend("createProject");
    const { result } = await mount(workspace(), backend);

    const created = await run(() =>
      result.current.createProject({
        name: "Doomed", description: "", emoji: "💀", color: "#000", priority: "low",
      })
    );

    expect(created).toBeNull();
    expect(backend.activityWrites).toEqual([]);
  });
});

describe("a refused line neither undoes the write nor stays on screen", () => {
  it("keeps the project and drops the phantom feed entry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const backend = new FailingBackend("putActivity");
    const { result } = await mount(workspace(), backend);

    const project = await run(() =>
      result.current.createProject({
        name: "Rebrand", description: "", emoji: "🎨", color: "#000", priority: "high",
      })
    );

    // The write stands: an append-only log line must not be able to undo the
    // thing it describes.
    expect(project).not.toBeNull();
    expect(result.current.state.projects.some((p) => p.id === project!.id)).toBe(true);
    // ...and the screen agrees with the server rather than showing a line that
    // would be gone after a reload.
    expect(
      result.current.state.activities.some((a) => a.text === "created the Rebrand project")
    ).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it("drops only the refused line, not the ones that were accepted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Reject the SECOND write only, so "all or nothing" cannot pass this.
    const backend = new FailingBackend("deleteMessage");
    let seen = 0;
    const real = backend.putActivity.bind(backend);
    backend.putActivity = (a) => {
      seen += 1;
      // Still recorded, so `activityWrites` shows both were attempted.
      const attempt = real(a);
      return seen === 2 ? Promise.reject(new Error("nope")) : attempt;
    };
    const { result } = await mount(workspace(), backend);

    await run(() =>
      result.current.updateTask("t_log", {
        assigneeId: "u_maya",
        collaboratorIds: ["u_jonas"],
      })
    );

    const kept = result.current.state.activities.map((a) => a.text);
    const attempted = backend.activityWrites.map((a) => a.text);
    expect(attempted).toHaveLength(2);
    expect(kept).toContain(attempted[0]);
    expect(kept).not.toContain(attempted[1]);
  });

  // The delete case, spelled out because it is not a bug to be fixed later.
  // `activities.project_id` cascades on delete, so `deleted the Payroll
  // project` cannot be stored: before the delete the cascade removes it,
  // after the delete the foreign key refuses it. Switching that FK to `set
  // null` would promote the row to workspace-wide and republish the very name
  // the scope exists to hide. So the delete succeeds, the line is refused, and
  // the feed corrects itself — which is what a reload would show anyway.
  it("deleteProject still deletes, and its un-storable line does not linger", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const backend = new FailingBackend("putActivity");
    const { result } = await mount(workspace(), backend);

    const ok = await run(() => result.current.deleteProject("p_log"));

    expect(ok).toBe(true);
    expect(result.current.state.projects.some((p) => p.id === "p_log")).toBe(false);
    expect(
      result.current.state.activities.some((a) => a.text === "deleted the Payroll project")
    ).toBe(false);
  });
});
