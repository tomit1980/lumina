// Task 4 — the row → model mapping in lib/backend/supabase/mapping.ts.
//
// Pure functions against fixture rows. No network, no client, no credentials:
// this file must run in the ordinary `npm test` suite, which never holds
// Supabase env vars. Importing the mapping module (and, below, `@/lib/backend`
// itself) without those vars set is itself part of what is under test — see
// "the static module graph" at the bottom.
//
// Every mismatch the mapping resolves gets a case here, because each one is a
// place where a wrong answer would be silently plausible: a task ordered by
// the wrong field still renders, a timestamp off by a timezone still renders,
// a collaborator quietly dropped still renders.
import { describe, expect, it } from "vitest";

import { ALL_PERMISSIONS } from "@/lib/permissions";
import { SEED_VERSION } from "@/lib/seed";
import type { Activity } from "@/lib/types";
import {
  fromActivity,
  signedOutState,
  toActivity,
  toAppState,
  toDms,
  toEpoch,
  toEpochOrNull,
  toLastRead,
  toReactions,
  type ActivityRow,
  type AttachmentRow,
  type ChannelRow,
  type HydrateRows,
  type MessageRow,
  type ProfileRow,
  type ProjectRow,
  type RoleRow,
  type TaskRow,
} from "@/lib/backend/supabase/mapping";

const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

/** Epoch values are built from date *components*, never by re-parsing the
 *  same string the mapping parses — otherwise the assertion would just be
 *  `Date.parse(x) === Date.parse(x)` and could not fail. */
const AT_10_UTC = Date.UTC(2026, 8, 8, 10, 0, 0);

function empty(): HydrateRows {
  return {
    currentUserId: ME,
    profiles: [],
    roles: [],
    channels: [],
    channelMembers: [],
    dms: [],
    dmMembers: [],
    messages: [],
    reactions: [],
    messageAttachments: [],
    attachments: [],
    projects: [],
    projectMembers: [],
    projectAttachments: [],
    tasks: [],
    taskCollaborators: [],
    taskAttachments: [],
    activities: [],
    readState: [],
  };
}

function profile(over: Partial<ProfileRow> & Pick<ProfileRow, "id">): ProfileRow {
  return {
    email: `${over.id}@lumina.test`,
    name: "Someone",
    handle: "someone",
    title: "",
    role_id: "member",
    color: "#7c3aed",
    created_at: "2026-09-08T10:00:00+00:00",
    mfa_required: false,
    ...over,
  };
}

function role(over: Partial<RoleRow> & Pick<RoleRow, "id">): RoleRow {
  return {
    name: over.id,
    description: "",
    color: "#64748b",
    permissions: [],
    is_system: false,
    locked: false,
    ...over,
  };
}

function channel(over: Partial<ChannelRow> & Pick<ChannelRow, "id">): ChannelRow {
  return {
    name: over.id,
    description: "",
    is_private: false,
    is_team: false,
    created_by: ME,
    created_at: "2026-09-08T10:00:00+00:00",
    ...over,
  };
}

function message(over: Partial<MessageRow> & Pick<MessageRow, "id">): MessageRow {
  return {
    conversation_id: "c_general",
    author_id: ME,
    content: "hello",
    created_at: "2026-09-08T10:00:00+00:00",
    edited_at: null,
    ...over,
  };
}

function project(over: Partial<ProjectRow> & Pick<ProjectRow, "id">): ProjectRow {
  return {
    name: over.id,
    description: "",
    emoji: "📁",
    color: "#7c3aed",
    priority: "medium",
    restricted: false,
    created_by: ME,
    created_at: "2026-09-08T10:00:00+00:00",
    ...over,
  };
}

function task(over: Partial<TaskRow> & Pick<TaskRow, "id">): TaskRow {
  return {
    project_id: "p_1",
    title: over.id,
    description: "",
    status: "todo",
    priority: "medium",
    assignee_id: null,
    due_date: null,
    start_time: null,
    duration_minutes: null,
    reminder_minutes: null,
    labels: [],
    position: 0,
    created_by: ME,
    created_at: "2026-09-08T10:00:00+00:00",
    ...over,
  };
}

function attachment(
  over: Partial<AttachmentRow> & Pick<AttachmentRow, "id">
): AttachmentRow {
  return {
    storage_path: `files/${over.id}`,
    name: "notes.md",
    size: 42,
    mime: "text/markdown",
    uploaded_by: ME,
    uploaded_at: "2026-09-08T10:00:00+00:00",
    edited_by: null,
    edited_at: null,
    ...over,
  };
}

function activity(over: Partial<ActivityRow> & Pick<ActivityRow, "id">): ActivityRow {
  return {
    ts: "2026-09-08T10:00:00+00:00",
    actor_id: ME,
    text: "did a thing",
    kind: "task",
    project_id: null,
    conversation_id: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("timestamps: timestamptz string → epoch ms", () => {
  it("parses a UTC timestamp to the epoch its components describe", () => {
    expect(toEpoch("2026-09-08T10:00:00+00:00")).toBe(AT_10_UTC);
  });

  it("honours a non-UTC offset instead of reading the wall clock", () => {
    // 23:30 in +05:30 is 18:00 UTC the same day. A mapping that ignored the
    // offset (or parsed as local time) would land hours away and still look
    // like a plausible date on screen.
    expect(toEpoch("2026-09-07T23:30:00+05:30")).toBe(Date.UTC(2026, 8, 7, 18, 0, 0));
  });

  it("truncates Postgres's microseconds to milliseconds", () => {
    expect(toEpoch("2026-09-08T10:00:00.123456+00:00")).toBe(AT_10_UTC + 123);
  });

  it("keeps null null rather than turning it into 0 (the epoch)", () => {
    expect(toEpochOrNull(null)).toBeNull();
    expect(toEpochOrNull("2026-09-08T10:00:00+00:00")).toBe(AT_10_UTC);
  });
});

describe("tasks", () => {
  it("maps the `position` column onto the model's `order` field", () => {
    const state = toAppState({
      ...empty(),
      tasks: [task({ id: "t_1", position: 7 })],
    });
    expect(state.tasks[0].order).toBe(7);
    // Guards against a mapping that happened to leave `order` at its default:
    // a different position must produce a different order.
    const other = toAppState({
      ...empty(),
      tasks: [task({ id: "t_1", position: 0 })],
    });
    expect(other.tasks[0].order).toBe(0);
  });

  it("carries the trigger's -1 sentinel through unchanged", () => {
    const state = toAppState({ ...empty(), tasks: [task({ id: "t_1", position: -1 })] });
    expect(state.tasks[0].order).toBe(-1);
  });

  it("collects collaboratorIds from several join rows, per task", () => {
    const state = toAppState({
      ...empty(),
      tasks: [task({ id: "t_1" }), task({ id: "t_2" }), task({ id: "t_3" })],
      taskCollaborators: [
        { task_id: "t_1", user_id: ME },
        { task_id: "t_2", user_id: THIRD },
        { task_id: "t_1", user_id: THEM },
        { task_id: "t_1", user_id: THIRD },
      ],
    });
    const byId = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
    // Three rows, interleaved with another task's row, must land on one task.
    expect(byId.t_1.collaboratorIds).toEqual([ME, THEM, THIRD]);
    // Positive control: a different task gets its own, not t_1's.
    expect(byId.t_2.collaboratorIds).toEqual([THIRD]);
    // And a task with no join rows gets an empty array, not undefined.
    expect(byId.t_3.collaboratorIds).toEqual([]);
  });

  it("converts due_date to epoch ms and leaves an unset one null", () => {
    const state = toAppState({
      ...empty(),
      tasks: [
        task({ id: "t_1", due_date: "2026-09-08T10:00:00+00:00" }),
        task({ id: "t_2", due_date: null }),
      ],
    });
    expect(state.tasks[0].dueDate).toBe(AT_10_UTC);
    expect(state.tasks[1].dueDate).toBeNull();
  });

  it("narrows the widened status/priority columns back to their unions", () => {
    const state = toAppState({
      ...empty(),
      tasks: [task({ id: "t_1", status: "in-review", priority: "high" })],
    });
    expect(state.tasks[0].status).toBe("in-review");
    expect(state.tasks[0].priority).toBe("high");
  });

  it("substitutes '' for a task whose creator's profile was deleted", () => {
    const state = toAppState({ ...empty(), tasks: [task({ id: "t_1", created_by: null })] });
    expect(state.tasks[0].createdBy).toBe("");
  });
});

describe("read_state → lastRead", () => {
  it("keys by `${userId}:${conversationId}` and stores epoch ms", () => {
    expect(
      toLastRead([
        { user_id: ME, conversation_id: "c_general", last_read_at: "2026-09-08T10:00:00+00:00" },
        { user_id: ME, conversation_id: "dm_1", last_read_at: "2026-09-07T23:30:00+05:30" },
      ])
    ).toEqual({
      [`${ME}:c_general`]: AT_10_UTC,
      [`${ME}:dm_1`]: Date.UTC(2026, 8, 7, 18, 0, 0),
    });
  });

  it("reaches AppState.lastRead", () => {
    const state = toAppState({
      ...empty(),
      readState: [
        { user_id: ME, conversation_id: "c_general", last_read_at: "2026-09-08T10:00:00+00:00" },
      ],
    });
    expect(state.lastRead).toEqual({ [`${ME}:c_general`]: AT_10_UTC });
  });
});

describe("messages", () => {
  it("maps conversation_id onto the model's channelId", () => {
    const state = toAppState({
      ...empty(),
      messages: [message({ id: "m_1", conversation_id: "dm_7" })],
    });
    expect(state.messages[0].channelId).toBe("dm_7");
  });

  it("omits editedAt when the message was never edited, and sets it when it was", () => {
    const state = toAppState({
      ...empty(),
      messages: [
        message({ id: "m_1" }),
        message({ id: "m_2", edited_at: "2026-09-08T10:00:00+00:00" }),
      ],
    });
    expect(state.messages[0].editedAt).toBeUndefined();
    expect(state.messages[1].editedAt).toBe(AT_10_UTC);
  });

  it("groups reaction rows into one entry per emoji", () => {
    expect(
      toReactions([
        { message_id: "m_1", emoji: "👍", user_id: ME },
        { message_id: "m_1", emoji: "🎉", user_id: THEM },
        { message_id: "m_1", emoji: "👍", user_id: THEM },
      ])
    ).toEqual([
      { emoji: "👍", userIds: [ME, THEM] },
      { emoji: "🎉", userIds: [THEM] },
    ]);
  });

  it("attaches each message's own reactions and nobody else's", () => {
    const state = toAppState({
      ...empty(),
      messages: [message({ id: "m_1" }), message({ id: "m_2" })],
      reactions: [
        { message_id: "m_2", emoji: "🚀", user_id: THEM },
        { message_id: "m_1", emoji: "👍", user_id: ME },
      ],
    });
    expect(state.messages[0].reactions).toEqual([{ emoji: "👍", userIds: [ME] }]);
    expect(state.messages[1].reactions).toEqual([{ emoji: "🚀", userIds: [THEM] }]);
  });

  it("substitutes '' for an author whose profile was deleted", () => {
    const state = toAppState({ ...empty(), messages: [message({ id: "m_1", author_id: null })] });
    expect(state.messages[0].authorId).toBe("");
  });

  it("carries sourceProjectId only for a file shared from a project", () => {
    const state = toAppState({
      ...empty(),
      messages: [message({ id: "m_1" })],
      attachments: [attachment({ id: "a_1" }), attachment({ id: "a_2" })],
      messageAttachments: [
        { message_id: "m_1", attachment_id: "a_1", source_project_id: null },
        { message_id: "m_1", attachment_id: "a_2", source_project_id: "p_1" },
      ],
    });
    expect(state.messages[0].attachments[0].sourceProjectId).toBeUndefined();
    expect(state.messages[0].attachments[1].sourceProjectId).toBe("p_1");
  });
});

describe("dm_members → the [string, string] tuple", () => {
  it("builds the pair from two join rows", () => {
    const dms = toDms(
      [{ id: "dm_1", created_at: "2026-09-08T10:00:00+00:00", pair_key: null }],
      [
        { dm_id: "dm_1", user_id: THEM },
        { dm_id: "dm_1", user_id: ME },
      ]
    );
    expect(dms).toHaveLength(1);
    expect(dms[0].memberIds).toHaveLength(2);
    expect([...dms[0].memberIds].sort()).toEqual([ME, THEM].sort());
    expect(dms[0].createdAt).toBe(AT_10_UTC);
  });

  it("drops a thread whose membership does not resolve to exactly two people", () => {
    const rows = [
      { id: "dm_ok", created_at: "2026-09-08T10:00:00+00:00", pair_key: null },
      { id: "dm_one", created_at: "2026-09-08T10:00:00+00:00", pair_key: null },
      { id: "dm_none", created_at: "2026-09-08T10:00:00+00:00", pair_key: null },
    ];
    const dms = toDms(rows, [
      { dm_id: "dm_ok", user_id: ME },
      { dm_id: "dm_ok", user_id: THEM },
      { dm_id: "dm_one", user_id: ME },
    ]);
    // The positive control matters as much as the drops: a mapping that
    // returned [] would otherwise pass the two negative expectations.
    expect(dms.map((d) => d.id)).toEqual(["dm_ok"]);
  });
});

describe("attachments", () => {
  it("renames mime → type and carries storage_path into dataUrl", () => {
    const state = toAppState({
      ...empty(),
      projects: [project({ id: "p_1" })],
      attachments: [attachment({ id: "a_1", mime: "image/png", size: 2048 })],
      projectAttachments: [{ project_id: "p_1", attachment_id: "a_1" }],
    });
    const file = state.projects[0].attachments[0];
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(2048);
    // Task 10: `dataUrl` is a REFERENCE to the bytes, and on this backend the
    // reference is the Storage location. It was the empty string while there
    // was nowhere for bytes to live; dropping the column now would leave every
    // file rendering as broken and look like a bug in the file.
    expect(file.dataUrl).toBe("files/a_1");
    expect(file.uploadedAt).toBe(AT_10_UTC);
  });

  it("sets editedBy/editedAt only on a file that was edited", () => {
    const rows: HydrateRows = {
      ...empty(),
      tasks: [task({ id: "t_1" })],
      attachments: [
        attachment({ id: "a_plain" }),
        attachment({
          id: "a_edited",
          edited_by: THEM,
          edited_at: "2026-09-08T10:00:00+00:00",
        }),
      ],
      taskAttachments: [
        { task_id: "t_1", attachment_id: "a_plain" },
        { task_id: "t_1", attachment_id: "a_edited" },
      ],
    };
    const files = toAppState(rows).tasks[0].attachments;
    expect(files[0].editedBy).toBeUndefined();
    expect(files[0].editedAt).toBeUndefined();
    expect(files[1].editedBy).toBe(THEM);
    expect(files[1].editedAt).toBe(AT_10_UTC);
  });

  it("skips a join row whose attachment RLS did not return", () => {
    const state = toAppState({
      ...empty(),
      projects: [project({ id: "p_1" })],
      attachments: [attachment({ id: "a_visible" })],
      projectAttachments: [
        { project_id: "p_1", attachment_id: "a_visible" },
        { project_id: "p_1", attachment_id: "a_withheld" },
      ],
    });
    expect(state.projects[0].attachments.map((a) => a.id)).toEqual(["a_visible"]);
  });
});

describe("profiles, roles, channels, projects, activities", () => {
  it("marks only the signed-in user online — the schema carries no presence", () => {
    const state = toAppState({
      ...empty(),
      profiles: [profile({ id: ME }), profile({ id: THEM })],
    });
    expect(state.users.find((u) => u.id === ME)!.presence).toBe("online");
    expect(state.users.find((u) => u.id === THEM)!.presence).toBe("offline");
  });

  it("does not carry email or mfa_required into AppState", () => {
    const state = toAppState({ ...empty(), profiles: [profile({ id: ME })] });
    expect(state.users[0]).not.toHaveProperty("email");
    expect(state.users[0]).not.toHaveProperty("mfa_required");
    expect(state.users[0]).not.toHaveProperty("mfaRequired");
  });

  it("keeps known permissions and drops ones this build cannot render", () => {
    const state = toAppState({
      ...empty(),
      roles: [
        role({ id: "admin", permissions: [...ALL_PERMISSIONS, "future.permission"] }),
      ],
    });
    expect(state.roles[0].permissions).toEqual(ALL_PERMISSIONS);
    expect(state.roles[0].permissions).not.toContain("future.permission");
  });

  it("maps is_system/locked and a channel's is_private/is_team", () => {
    const state = toAppState({
      ...empty(),
      roles: [role({ id: "admin", is_system: true, locked: true })],
      channels: [
        channel({ id: "c_general", is_team: true }),
        channel({ id: "c_secret", is_private: true }),
      ],
      channelMembers: [
        { channel_id: "c_secret", user_id: ME, level: "viewer" },
        { channel_id: "c_secret", user_id: THEM, level: "editor" },
      ],
    });
    expect(state.roles[0].isSystem).toBe(true);
    expect(state.roles[0].locked).toBe(true);
    expect(state.channels[0].isTeam).toBe(true);
    expect(state.channels[0].members).toEqual([]);
    expect(state.channels[1].isPrivate).toBe(true);
    expect(state.channels[1].members).toEqual([
      { userId: ME, level: "viewer" },
      { userId: THEM, level: "editor" },
    ]);
  });

  it("maps project members and priority", () => {
    const state = toAppState({
      ...empty(),
      projects: [project({ id: "p_1", restricted: true, priority: "high" })],
      projectMembers: [{ project_id: "p_1", user_id: THEM, level: "editor" }],
    });
    expect(state.projects[0].restricted).toBe(true);
    expect(state.projects[0].priority).toBe("high");
    expect(state.projects[0].members).toEqual([{ userId: THEM, level: "editor" }]);
  });

  it("maps activities, including a null actor", () => {
    const state = toAppState({
      ...empty(),
      activities: [
        activity({ id: "act_1", kind: "project" }),
        activity({ id: "act_2", actor_id: null }),
      ],
    });
    expect(state.activities[0]).toEqual({
      id: "act_1",
      ts: AT_10_UTC,
      actorId: ME,
      text: "did a thing",
      kind: "project",
      projectId: null,
      conversationId: null,
    });
    expect(state.activities[1].actorId).toBe("");
  });

  // The scope columns are what activities_read filters on
  // (20260909000900_activity_scope.sql). If the mapping dropped them, the
  // client would hold a feed it could not tell apart from the old unscoped
  // one — and every consumer downstream would treat a restricted row as
  // workspace-wide.
  it("carries an activity's project and conversation scope through", () => {
    const state = toAppState({
      ...empty(),
      activities: [
        activity({ id: "act_p", kind: "project", project_id: "p_payroll" }),
        activity({ id: "act_c", kind: "channel", conversation_id: "c_board" }),
        activity({ id: "act_w", kind: "member" }),
      ],
    });
    expect(state.activities[0].projectId).toBe("p_payroll");
    expect(state.activities[0].conversationId).toBeNull();
    expect(state.activities[1].conversationId).toBe("c_board");
    expect(state.activities[1].projectId).toBeNull();
    // A workspace-wide row: both null, never undefined. The distinction
    // matters on the way back out — see fromActivity below.
    expect(state.activities[2].projectId).toBeNull();
    expect(state.activities[2].conversationId).toBeNull();
  });

  describe("fromActivity: model → insert row", () => {
    const base: Activity = {
      id: "act_x", ts: AT_10_UTC, actorId: ME, text: "did a thing", kind: "task",
    };

    it("emits a project scope", () => {
      const row = fromActivity({ ...base, projectId: "p_payroll", conversationId: null });
      expect(row.project_id).toBe("p_payroll");
      expect(row.conversation_id).toBeNull();
      expect(row.id).toBe("act_x");
      expect(row.text).toBe("did a thing");
    });

    it("emits a conversation scope", () => {
      const row = fromActivity({ ...base, kind: "channel", conversationId: "c_board" });
      expect(row.conversation_id).toBe("c_board");
      expect(row.project_id).toBeNull();
    });

    // activities_insert checks the scope, so an omitted column is not the same
    // as an explicit null: it would let the column default rather than state
    // that the event belongs to nobody.
    it("writes both columns as explicit null for a workspace-wide event", () => {
      const row = fromActivity({ ...base, kind: "member" });
      expect(row).toHaveProperty("project_id", null);
      expect(row).toHaveProperty("conversation_id", null);
    });

    // `ts` is deliberately excluded from the equality: Postgres hands back
    // "+00:00" and Date#toISOString emits "Z" for the same instant, so
    // comparing the strings would assert a formatting choice rather than a
    // round-trip. The instant itself is compared separately.
    it("round-trips a row through toActivity and back", () => {
      const row = activity({ id: "act_r", kind: "project", project_id: "p_payroll" });
      const back = fromActivity(toActivity(row));
      const { ts: backTs, ...backRest } = back;
      const { ts: rowTs, ...rowRest } = row;
      expect(backRest).toEqual(rowRest);
      expect(new Date(backTs as string).getTime()).toBe(new Date(rowTs).getTime());
    });
  });
});

describe("the whole workspace", () => {
  it("sets currentUserId from the signed-in id, not from the first profile", () => {
    // THEM sorts first in the fixture; a mapping that took users[0] would
    // pass every other test in this file and still be wrong.
    const state = toAppState({
      ...empty(),
      currentUserId: ME,
      profiles: [profile({ id: THEM }), profile({ id: ME })],
    });
    expect(state.currentUserId).toBe(ME);
    expect(state.users.find((u) => u.id === state.currentUserId)).toBeDefined();
  });

  it("maps an empty workspace to a structurally valid, empty AppState", () => {
    const state = toAppState(empty());
    expect(state).toEqual({
      version: SEED_VERSION,
      currentUserId: ME,
      users: [],
      roles: [],
      channels: [],
      dms: [],
      messages: [],
      projects: [],
      tasks: [],
      activities: [],
      lastRead: {},
    });
  });
});

describe("signedOutState", () => {
  it("holds no workspace rows at all", () => {
    const state = signedOutState();
    expect(state.currentUserId).toBe("");
    expect(state.channels).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.projects).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.dms).toEqual([]);
    expect(state.activities).toEqual([]);
    expect(state.roles).toEqual([]);
    expect(state.lastRead).toEqual({});
  });

  it("keeps one placeholder user so `users[0]` is never undefined", () => {
    // lib/store.tsx computes `currentUser` as `find(...) ?? users[0]`, and
    // SessionBridge reads `currentUser.id` outside AuthGate — i.e. on the
    // signed-out screen. An empty array here is a TypeError on every sign-out.
    const state = signedOutState();
    expect(state.users).toHaveLength(1);
    expect(state.users[0].id).toBe("");
    expect(state.users[0].name).toBe("");
    expect(state.users[0].roleId).toBe("");
  });
});
