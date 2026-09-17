// A repeat rule crossing the two boundaries it has to survive: the localStorage
// blob the demo persists, and the four database columns.
//
// Both directions fail CLOSED. A rule is four values that only mean something
// together, and the check constraint that normally guarantees that
// (`tasks_repeat_shape`) protects the database — not a blob a browser has been
// holding since before this feature existed, and not a row somebody edited by
// hand. Either can present three of the four. The answer in both cases is
// "does not repeat", never a rule with an invented interval, because a task
// that silently repeats on a guessed cadence is worse than one that does not
// repeat at all.
import { describe, expect, it } from "vitest";

import { migrate } from "@/lib/backend/local";
import { toAppState } from "@/lib/backend/supabase/mapping";
import { createSeed } from "@/lib/seed";
import type { RepeatRule } from "@/lib/types";

const SYD = "Australia/Sydney";
const RULE: RepeatRule = { unit: "week", interval: 2, anchorDay: null, timeZone: SYD };

/** A persisted blob shaped like one written before recurrence shipped. */
function legacyBlob(taskOverrides: Record<string, unknown> = {}) {
  const seed = createSeed();
  const [first, ...rest] = seed.tasks;
  return {
    ...seed,
    tasks: [{ ...first, ...taskOverrides }, ...rest],
  };
}

describe("a persisted workspace crossing into recurrence", () => {
  it("gives an older task `repeat: null`, not undefined", () => {
    // The distinction matters: `undefined` type-checks against an optional
    // field and then fails `isRepeatRule`, so the bug would surface far from
    // here as "this task does not repeat" with no explanation.
    const { repeat, ...withoutRepeat } = legacyBlob().tasks[0] as { repeat?: unknown };
    void repeat;
    const state = migrate(
      { ...legacyBlob(), tasks: [withoutRepeat] } as never,
      1
    );
    expect(state.tasks[0].repeat).toBeNull();
    expect("repeat" in state.tasks[0]).toBe(true);
  });

  it("keeps a complete rule intact", () => {
    const state = migrate(legacyBlob({ repeat: RULE }) as never, 1);
    expect(state.tasks[0].repeat).toEqual(RULE);
  });

  it.each([
    ["no timezone", { unit: "week", interval: 2, anchorDay: null }],
    ["no interval", { unit: "week", anchorDay: null, timeZone: SYD }],
    ["monthly with no anchor", { unit: "month", interval: 1, anchorDay: null, timeZone: SYD }],
    ["an anchor on a weekly rule", { unit: "week", interval: 1, anchorDay: 9, timeZone: SYD }],
    ["an interval of zero", { unit: "day", interval: 0, anchorDay: null, timeZone: SYD }],
  ])("drops a half-written rule (%s) rather than guessing", (_label, broken) => {
    const state = migrate(legacyBlob({ repeat: broken }) as never, 1);
    expect(state.tasks[0].repeat).toBeNull();
  });
});

describe("four columns crossing into one value", () => {
  const rows = (task: Record<string, unknown>) =>
    ({
      currentUserId: "u_1",
      profiles: [], roles: [], statuses: [], channels: [], channelMembers: [],
      dms: [], dmMembers: [], messages: [], reactions: [], messageAttachments: [],
      attachments: [], projects: [], projectMembers: [], projectAttachments: [],
      clientInfo: [], clientDocuments: [], clientNotes: [],
      tasks: [{
        id: "t_1", project_id: "p_1", title: "T", description: "",
        status: "todo", priority: "medium", assignee_id: null,
        due_date: "2026-06-10T14:00:00+00:00", start_time: null,
        duration_minutes: null, reminder_minutes: null, labels: [],
        position: 0, created_by: "u_1", created_at: "2026-06-01T00:00:00+00:00",
        repeat_unit: null, repeat_interval: null, repeat_anchor_day: null,
        repeat_tz: null, recurred_from: null,
        ...task,
      }],
      taskCollaborators: [], taskAttachments: [], taskSets: [], taskSetItems: [],
      activities: [], readState: [],
    }) as never;

  it("reads a weekly rule", () => {
    const state = toAppState(rows({ repeat_unit: "week", repeat_interval: 2, repeat_tz: SYD }));
    expect(state.tasks[0].repeat).toEqual(RULE);
  });

  it("reads a monthly rule with its anchor", () => {
    const state = toAppState(
      rows({ repeat_unit: "month", repeat_interval: 1, repeat_anchor_day: 31, repeat_tz: SYD })
    );
    expect(state.tasks[0].repeat).toEqual({
      unit: "month", interval: 1, anchorDay: 31, timeZone: SYD,
    });
  });

  it("reads all-null columns as no rule", () => {
    expect(toAppState(rows({})).tasks[0].repeat).toBeNull();
  });

  it("reads a half-written row as no rule", () => {
    // Unreachable through the app — `tasks_repeat_shape` forbids it — so this
    // pins what happens if someone reaches past it with the service key.
    const state = toAppState(rows({ repeat_unit: "week", repeat_interval: null, repeat_tz: SYD }));
    expect(state.tasks[0].repeat).toBeNull();
  });

  it("CONTROL: the same row WITH its interval does read as a rule", () => {
    // Without this, the case above would pass just as happily if the mapping
    // ignored these columns altogether.
    const state = toAppState(rows({ repeat_unit: "week", repeat_interval: 2, repeat_tz: SYD }));
    expect(state.tasks[0].repeat).not.toBeNull();
  });
});
