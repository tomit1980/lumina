import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseBackend } from "@/lib/backend/supabase";
import type { Activity } from "@/lib/types";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addChannelMember, createChannel, createProject, seedRoles } from "../helpers/workspace";

// `SupabaseBackend.putActivity` against lumina-dev — the write half of the
// activity feed, under the real policies.
//
// tests/rls/activities.test.ts already gates `activities_read` /
// `activities_insert` by talking to PostgREST directly. This file is about the
// SEAM: until `putActivity` existed, `lib/backend/types.ts` had no mention of an
// activity at all, so the store's optimistic line reached `AppState` and never
// Postgres, and the feed emptied itself on reload. What is asserted here is
// that a row written through the backend the app actually uses lands with the
// scope the store gave it, and is then filtered by that scope.
//
// Every negative is paired with a positive control on the SAME client and the
// SAME method — a `putActivity` that had simply stopped working, or a read that
// returned nothing at all, would otherwise satisfy every "cannot see it" below.
//
// Frugal with identities for the reason the other files here document: Supabase
// rate-limits sign-ins per project across the whole parallel run. Two, both of
// which must authenticate because both do real work.
const clientFor = (email: string) => signInAs(email, TEST_PASSWORD);

const stamp = Date.now();
const openProject = `p_pa_open_${stamp}`;
const secretProject = `p_pa_secret_${stamp}`;
const privateChannel = `c_pa_priv_${stamp}`;

const wideRow = `a_pa_wide_${stamp}`;
const openRow = `a_pa_open_${stamp}`;
const secretRow = `a_pa_secret_${stamp}`;
const channelRow = `a_pa_chan_${stamp}`;
const forgedProjectRow = `a_pa_forge_p_${stamp}`;
const forgedChannelRow = `a_pa_forge_c_${stamp}`;
const outsiderWideRow = `a_pa_out_wide_${stamp}`;
const cascadeRow = `a_pa_cascade_${stamp}`;
const afterDeleteRow = `a_pa_after_${stamp}`;

/** The project deleted mid-file to demonstrate the cascade. Separate from the
 *  two above so no other assertion depends on its lifetime. */
const doomedProject = `p_pa_doomed_${stamp}`;

const allRows = [
  wideRow, openRow, secretRow, channelRow, forgedProjectRow, forgedChannelRow,
  outsiderWideRow, cascadeRow, afterDeleteRow,
];

const emails = {
  owner: `pawn-${stamp}@lumina.test`,
  outsider: `paout-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

/** What the store hands the seam: `lib/store.tsx`'s `activity(...)` composes
 *  exactly this shape, including both scope columns always present. */
function line(id: string, actorId: string, over: Partial<Activity> = {}): Activity {
  return {
    id, ts: Date.now(), actorId, text: `line ${id}`, kind: "project",
    projectId: null, conversationId: null, ...over,
  };
}

async function backendFor(email: string): Promise<SupabaseBackend> {
  return new SupabaseBackend(await clientFor(email));
}

beforeAll(async () => {
  await seedRoles();
  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Pia", handle: `papia${stamp}`, roleId: "admin",
  });
  // A plain Member: holds no members.manage, so can_see_project /
  // can_see_conversation give them the open resources and nothing else.
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Pax", handle: `papax${stamp}`, roleId: "member",
  });

  await createProject({ id: openProject, name: "Website", restricted: false, createdBy: ids.owner });
  await createProject({ id: secretProject, name: "Payroll", restricted: true, createdBy: ids.owner });
  await createProject({ id: doomedProject, name: "Doomed", restricted: false, createdBy: ids.owner });
  await createChannel({
    id: privateChannel, name: `pa-board-${stamp}`, isPrivate: true, createdBy: ids.owner,
  });
  await addChannelMember(privateChannel, ids.owner, "editor");
});

afterAll(async () => {
  await serviceClient.from("activities").delete().in("id", allRows);
  await serviceClient.from("projects").delete().in("id", [openProject, secretProject, doomedProject]);
  await serviceClient.from("conversations").delete().in("id", [privateChannel]);
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

describe("putActivity actually persists the feed line", () => {
  it("writes a workspace-wide line and a scoped one, both readable by their author", async () => {
    const backend = await backendFor(emails.owner);

    await backend.putActivity(line(wideRow, ids.owner, { kind: "member" }));
    await backend.putActivity(line(openRow, ids.owner, { projectId: openProject }));
    await backend.putActivity(line(secretRow, ids.owner, { projectId: secretProject }));
    await backend.putActivity(
      line(channelRow, ids.owner, { kind: "channel", conversationId: privateChannel })
    );

    // Read back through the author's own client, not the service client: the
    // point is that the rows exist AND survive the read policy. This is also
    // the assertion that fails outright when nothing is written at all — the
    // state the feed was in before this seam existed.
    const client = await clientFor(emails.owner);
    const { data, error } = await client
      .from("activities").select("id,project_id,conversation_id")
      .in("id", [wideRow, openRow, secretRow, channelRow]);

    expect(error).toBeNull();
    const rows = data ?? [];
    expect(rows.map((r) => r.id).sort())
      .toEqual([channelRow, openRow, secretRow, wideRow].sort());
    // The scope the store attached survived the round trip. A backend that
    // dropped the columns would still pass the id check above and would put
    // every one of these back in every browser.
    expect(rows.find((r) => r.id === secretRow)?.project_id).toBe(secretProject);
    expect(rows.find((r) => r.id === channelRow)?.conversation_id).toBe(privateChannel);
    expect(rows.find((r) => r.id === wideRow)?.project_id).toBeNull();
    expect(rows.find((r) => r.id === wideRow)?.conversation_id).toBeNull();
  });
});

describe("a persisted line is filtered by the scope it was written with", () => {
  it("shows an outsider the workspace-wide and open-project lines (positive control)", async () => {
    const client = await clientFor(emails.outsider);
    const { data, error } = await client
      .from("activities").select("id").in("id", [wideRow, openRow]);

    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id).sort()).toEqual([openRow, wideRow].sort());
  });

  it("hides the restricted-project line from that same outsider", async () => {
    const client = await clientFor(emails.outsider);
    const { data, error } = await client.from("activities").select("id").eq("id", secretRow);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("hides the private-channel line from that same outsider", async () => {
    const client = await clientFor(emails.outsider);
    const { data, error } = await client.from("activities").select("id").eq("id", channelRow);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe("putActivity cannot write into a scope the caller cannot see", () => {
  it("lets the outsider write a workspace-wide line (positive control)", async () => {
    const backend = await backendFor(emails.outsider);
    await expect(
      backend.putActivity(line(outsiderWideRow, ids.outsider, { kind: "member" }))
    ).resolves.toBeUndefined();
  });

  it("rejects — not silently drops — a line scoped to an invisible project", async () => {
    // A resolving no-op here would be the worst of both worlds: the store
    // would keep the optimistic line on screen and a reload would lose it.
    const backend = await backendFor(emails.outsider);
    await expect(
      backend.putActivity(line(forgedProjectRow, ids.outsider, { projectId: secretProject }))
    ).rejects.toThrow(/42501/);
  });

  it("rejects a line scoped to an invisible conversation", async () => {
    const backend = await backendFor(emails.outsider);
    await expect(
      backend.putActivity(
        line(forgedChannelRow, ids.outsider, { kind: "channel", conversationId: privateChannel })
      )
    ).rejects.toThrow(/42501/);
  });
});

// The ruling the ledger asks each task to make explicitly, observed rather than
// argued. `activities.project_id` cascades, so a `deleted the X project` line
// has nowhere to live — and the fix that would give it one (switching the FK to
// `set null`) is the leak 66cddf1 closed, dressed up as a bug fix.
describe("a delete-activity genuinely cannot be persisted", () => {
  it("cascades an existing line away with its project, and refuses a new one after", async () => {
    const backend = await backendFor(emails.owner);
    await backend.putActivity(line(cascadeRow, ids.owner, { projectId: doomedProject }));

    // Positive control: it really is there before the delete, so the absence
    // below is the cascade and not a write that never happened.
    const before = await serviceClient.from("activities").select("id").eq("id", cascadeRow);
    expect((before.data ?? []).map((r) => r.id)).toEqual([cascadeRow]);

    const deleted = await serviceClient.from("projects").delete().eq("id", doomedProject);
    expect(deleted.error).toBeNull();

    // Service client, so this is the cascade and not the read policy.
    const after = await serviceClient.from("activities").select("id").eq("id", cascadeRow);
    expect(after.data ?? []).toEqual([]);

    // And sequenced the way `commit` actually sequences it — after the delete
    // — the foreign key refuses it. 23503, not a silent success.
    await expect(
      backend.putActivity(line(afterDeleteRow, ids.owner, { projectId: doomedProject }))
    ).rejects.toThrow(/23503/);
  });
});
