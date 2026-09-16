// Who may read and write a client's case record, asked of the database.
//
// The Client Info tab renders read-only for a viewer and is absent for
// somebody who cannot see the project at all, and that is worth nothing here:
// the publishable key is in every bundle and any signed-in person can query
// PostgREST directly. This file is the half that actually decides.
//
// WHAT IS ON THIS RECORD makes the stakes different from tasks. A date of
// birth, a home address, a diagnosis and a super-fund member number are, put
// together, enough to impersonate somebody to their own fund. "A member who
// should not have seen it saw it" is not an inconvenience here.
//
// THE BAR IS EDITOR ACCESS TO THE PROJECT, with no permission beside it -
// `can_see_project and not project_is_viewer_only`, which is exactly what the
// app calls an editor. Deliberately NOT `has_permission('project.create')` the
// way `updateProject` is gated: the decision was that anyone trusted to work a
// case may record its facts, and requiring `project.create` would have meant a
// teammate who may edit every task on a case may not write down the client's
// phone number.
//
// CROSS-WORKSPACE ISOLATION IS NOT TESTED HERE AND CANNOT BE. There is no
// `workspace_id` on any table in this schema - Lumina is single-tenant, one
// workspace per Supabase project - so there is no second workspace for a row
// to leak into. Recorded rather than silently skipped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addProjectMember, createProject, seedRoles } from "../helpers/workspace";

const stamp = Date.now();

const emails = {
  /** Editor on the restricted project. */
  editor: `ci-editor-${stamp}@lumina.test`,
  /** Viewer on the same project: may read the record, may not change it. */
  viewer: `ci-viewer-${stamp}@lumina.test`,
  /** On neither project. A Member, so nothing about their ROLE explains a
   *  refusal - only the membership does. */
  outsider: `ci-outsider-${stamp}@lumina.test`,
  /** Holds members.manage, which `project_is_viewer_only` short-circuits. */
  admin: `ci-admin-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

const projects = {
  /** Restricted: the one whose membership decides everything. */
  locked: `p_ci_locked_${stamp}`,
  /** A second project, to prove one record never answers for another. */
  other: `p_ci_other_${stamp}`,
};

beforeAll(async () => {
  await seedRoles();
  ids.editor = await createTestUser({
    email: emails.editor, password: TEST_PASSWORD,
    name: "Eve Editor", handle: `cieve${stamp}`, roleId: "member",
  });
  ids.viewer = await createTestUser({
    email: emails.viewer, password: TEST_PASSWORD,
    name: "Vic Viewer", handle: `civic${stamp}`, roleId: "member",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Otto Outside", handle: `ciotto${stamp}`, roleId: "member",
  });
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `ciada${stamp}`, roleId: "admin",
  });

  await createProject({
    id: projects.locked, name: `CI Locked ${stamp}`,
    restricted: true, createdBy: ids.admin,
  });
  await createProject({
    id: projects.other, name: `CI Other ${stamp}`,
    restricted: true, createdBy: ids.admin,
  });
  await addProjectMember(projects.locked, ids.editor, "editor");
  await addProjectMember(projects.locked, ids.viewer, "viewer");
  // The outsider is an editor on the OTHER project, which is what makes the
  // isolation test meaningful: they are not a stranger to the system, they
  // simply have no business with this case.
  await addProjectMember(projects.other, ids.outsider, "editor");

  const seeded = await serviceClient.from("project_client_info").insert({
    project_id: projects.locked,
    full_name: "Dana Reed",
    date_of_birth: "1968-03-02",
    diagnosis: "Stage 3 renal failure",
    member_id: `AS-${stamp}`,
    amount: 128450.5,
  });
  if (seeded.error) throw new Error(`seed record failed: ${seeded.error.message}`);

  const doc = await serviceClient.from("project_client_documents").insert({
    project_id: projects.locked, document_type: "certified_id", received: true,
  });
  if (doc.error) throw new Error(`seed document failed: ${doc.error.message}`);
});

afterAll(async () => {
  // Both client tables cascade from `projects`, so deleting the projects is
  // enough - and exercising that cascade here is not accidental: it is the
  // only thing that removes a client's personal details when a case is closed.
  await serviceClient.from("projects").delete().in("id", Object.values(projects));
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

async function recordOf(projectId: string) {
  const { data } = await serviceClient
    .from("project_client_info").select("*").eq("project_id", projectId).maybeSingle();
  return data;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("who may read the record", () => {
  it("REFUSES somebody who is not on the project", async () => {
    // Silently, like every filtered read: no error, no rows. Which is why the
    // control below is not optional.
    const them = await signInAs(emails.outsider, TEST_PASSWORD);

    const { data, error } = await them
      .from("project_client_info").select("*").eq("project_id", projects.locked);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("REFUSES them the document rows too", async () => {
    // Which documents have arrived is itself case information - it says how
    // far along somebody's claim is.
    const them = await signInAs(emails.outsider, TEST_PASSWORD);

    const { data, error } = await them
      .from("project_client_documents").select("*").eq("project_id", projects.locked);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("CONTROL: that same outsider reads a record on THEIR project", async () => {
    // Without this, both refusals above would pass against an empty table, a
    // dropped read policy, or a gate that had started refusing everybody -
    // and would read as "isolation works" in all three cases.
    await serviceClient.from("project_client_info").insert({
      project_id: projects.other, full_name: "Sam Okafor",
    });
    const them = await signInAs(emails.outsider, TEST_PASSWORD);

    const { data, error } = await them
      .from("project_client_info").select("*").eq("project_id", projects.other);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    expect(data![0].full_name).toBe("Sam Okafor");
  });

  it("never returns one project's record under another project's id", async () => {
    // The failure this feature could do real harm with, asked directly: the
    // outsider asks for EVERYTHING they can see and must not find Dana Reed in
    // it. A filter-by-id test would miss a policy that returned every row.
    const them = await signInAs(emails.outsider, TEST_PASSWORD);

    const { data } = await them.from("project_client_info").select("*");

    expect((data ?? []).map((r) => r.project_id)).toEqual([projects.other]);
    expect(JSON.stringify(data)).not.toContain("Dana Reed");
  });

  it("lets a viewer read it", async () => {
    // A viewer is on the case and needs the facts; what they may not do is
    // change them. This is the positive half of the next block.
    const them = await signInAs(emails.viewer, TEST_PASSWORD);

    const { data, error } = await them
      .from("project_client_info").select("*").eq("project_id", projects.locked);

    expect(error).toBeNull();
    expect(data![0].diagnosis).toBe("Stage 3 renal failure");
  });
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

describe("who may write it", () => {
  it("REFUSES a viewer an update", async () => {
    const them = await signInAs(emails.viewer, TEST_PASSWORD);

    await them
      .from("project_client_info").update({ full_name: "Changed By Viewer" })
      .eq("project_id", projects.locked);

    // Asked of the row rather than of the response: a filtered UPDATE reports
    // `error: null` with an empty body, so "no error" is not the claim
    // "nothing happened". Reading the row back is.
    expect((await recordOf(projects.locked))!.full_name).toBe("Dana Reed");
  });

  it("REFUSES a viewer an insert on a project with no record yet", async () => {
    // The lazy-creation path. Without `client_info_insert` being gated the
    // same way as the update, a viewer could create the record that does not
    // exist and own every field in it from the start.
    const them = await signInAs(emails.viewer, TEST_PASSWORD);

    await them.from("project_client_info").insert({
      project_id: projects.other, full_name: "Created By Viewer",
    });

    const row = await recordOf(projects.other);
    expect(row?.full_name).not.toBe("Created By Viewer");
  });

  it("REFUSES a viewer a document tick", async () => {
    const them = await signInAs(emails.viewer, TEST_PASSWORD);

    await them.from("project_client_documents").upsert({
      project_id: projects.locked, document_type: "bank_statement", received: true,
    });

    const { data } = await serviceClient
      .from("project_client_documents").select("*")
      .eq("project_id", projects.locked).eq("document_type", "bank_statement");
    expect(data ?? []).toHaveLength(0);
  });

  it("CONTROL: the editor on the same project does all three", async () => {
    // One test, three writes, because the point is the contrast with the block
    // above rather than the three writes individually - the store suite covers
    // those field by field.
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    const updated = await them
      .from("project_client_info").update({ employer_name: "Barwon Freight" })
      .eq("project_id", projects.locked).select("project_id");
    const inserted = await them.from("project_client_info").upsert(
      { project_id: projects.other, super_company: "AustralianSuper" },
      { onConflict: "project_id" }
    ).select("project_id");
    const ticked = await them.from("project_client_documents").upsert(
      { project_id: projects.locked, document_type: "bank_statement", received: true },
      { onConflict: "project_id,document_type" }
    ).select("project_id");

    expect(updated.error).toBeNull();
    expect(updated.data ?? []).toHaveLength(1);
    // The editor is on `locked` and NOT on `other`, so this one must be
    // refused - proving the bar is per-project rather than per-person.
    expect(inserted.data ?? []).toHaveLength(0);
    expect(ticked.error).toBeNull();
    expect(ticked.data ?? []).toHaveLength(1);

    expect((await recordOf(projects.locked))!.employer_name).toBe("Barwon Freight");
  });

  it("lets an admin write without being a member of the project at all", async () => {
    // `project_is_viewer_only` returns false for anyone holding
    // `members.manage`, so the admin carve-out costs the policy no clause of
    // its own. Pinned because a future tightening of that helper would break
    // admin access silently.
    const them = await signInAs(emails.admin, TEST_PASSWORD);

    const { data, error } = await them
      .from("project_client_info").update({ address: "12 Wattle St, Fitzroy" })
      .eq("project_id", projects.locked).select("project_id");

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  // An outsider-write-is-filtered test lived here, written against the
  // `notes` column. That column is gone (44de001) — notes are now an
  // append-only `project_client_notes` table with no update path at all, so
  // the scenario this test asserted no longer exists to test. Its RLS
  // coverage belongs to the notes-log task, against that table.

  it("REFUSES everybody a delete, including the editor", async () => {
    // There is no delete policy on either table, deliberately: the record's
    // lifetime is the project's. A `for all` write policy - the shape
    // 20260906000350 exists because of - would have granted this silently.
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    await them.from("project_client_info").delete().eq("project_id", projects.locked);

    expect(await recordOf(projects.locked)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The audit columns
// ---------------------------------------------------------------------------

describe("who the database says wrote last", () => {
  it("records the writer, not whatever the client claimed", async () => {
    // The first `updated_by` in this schema, and it is set by a trigger from
    // `auth.uid()` rather than sent by the app. This test is the difference
    // between an audit column and a field: the editor writes, and explicitly
    // claims to be the admin while doing it.
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    await them
      .from("project_client_info")
      .update({ diagnosis: "Stage 3 renal failure", updated_by: ids.admin })
      .eq("project_id", projects.locked);

    const row = await recordOf(projects.locked);
    expect(row!.updated_by).toBe(ids.editor);
  });

  it("moves updated_at forward on every write", async () => {
    const before = (await recordOf(projects.locked))!.updated_at;
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    // Was `{ notes: "..." }` — that column is gone (44de001, replaced by the
    // append-only `project_client_notes` table, whose own tests belong to
    // the notes-log task). The trigger this test pins does not care which
    // column moved, so an empty patch still exercises it.
    await them
      .from("project_client_info").update({})
      .eq("project_id", projects.locked);

    const after = (await recordOf(projects.locked))!.updated_at;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it("stamps the document rows the same way", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    await them.from("project_client_documents").upsert(
      { project_id: projects.locked, document_type: "photo_id_front", received: true },
      { onConflict: "project_id,document_type" }
    );

    const { data } = await serviceClient
      .from("project_client_documents").select("updated_by")
      .eq("project_id", projects.locked).eq("document_type", "photo_id_front").single();
    expect(data!.updated_by).toBe(ids.editor);
  });
});

// ---------------------------------------------------------------------------
// What the columns will not hold
// ---------------------------------------------------------------------------

describe("the shapes the columns refuse", () => {
  it("refuses a currency that is not three letters", async () => {
    // The check constraint, asked directly. The app only ever sends 'AUD', so
    // without this the constraint is untested and could be dropped by a later
    // migration without anything noticing.
    const { error } = await serviceClient
      .from("project_client_info").update({ currency: "dollars" })
      .eq("project_id", projects.locked);

    expect(error).not.toBeNull();
  });

  it("refuses text that is not a date at all", async () => {
    const { error } = await serviceClient
      .from("project_client_info").update({ date_of_birth: "not-a-date" })
      .eq("project_id", projects.locked);

    expect(error?.message ?? "").toMatch(/invalid input syntax for type date/);
  });

  it("refuses a day that does not exist", async () => {
    const { error } = await serviceClient
      .from("project_client_info").update({ last_day_of_work: "2025-02-30" })
      .eq("project_id", projects.locked);

    expect(error?.message ?? "").toMatch(/out of range/);
  });

  it("ACCEPTS '02/03/1968' AND READS IT MONTH-FIRST, which is the whole reason for the client guard", async () => {
    // Found by running this file, not by reasoning about it: the column does
    // NOT refuse a slash date. Postgres parses it under the server's DateStyle
    // - MDY here - so an Australian typing 2 March 1968 gets 3 February 1968
    // stored, silently, with no error anywhere.
    //
    // That is the worst shape a bug can have on this particular record: a date
    // of birth that is wrong by a month and looks entirely plausible, on the
    // field a super fund uses to identify somebody.
    //
    // Nothing in the database can fix it - both readings are valid dates. So
    // the guard is `isIsoDate` in lib/client-info.ts, the store refuses
    // anything that is not YYYY-MM-DD before the round trip
    // (tests/qa/client-info.test.ts), and `<input type="date">` produces
    // nothing else. This test exists so that if somebody later "simplifies"
    // that guard away on the grounds that the column will catch it, the
    // comment they need is already written down and asserted.
    await serviceClient
      .from("project_client_info").update({ date_of_birth: "02/03/1968" })
      .eq("project_id", projects.locked);

    expect((await recordOf(projects.locked))!.date_of_birth).toBe("1968-02-03");

    await serviceClient
      .from("project_client_info").update({ date_of_birth: "1968-03-02" })
      .eq("project_id", projects.locked);
  });

  it("keeps an amount to the cent instead of rounding it away", async () => {
    // numeric(14,2). A float column would have made 128450.5 come back as
    // 128450.49999999999 for some values, and money that drifts is money
    // somebody argues about.
    const { error } = await serviceClient
      .from("project_client_info").update({ amount: 999999999999.99 })
      .eq("project_id", projects.locked);
    expect(error).toBeNull();

    expect(Number((await recordOf(projects.locked))!.amount)).toBe(999999999999.99);
  });

  it("cannot hold two records for one project", async () => {
    // The one-to-one is the primary key rather than a convention, so this is
    // refused by the database and not by anything the app remembers to do.
    const { error } = await serviceClient
      .from("project_client_info").insert({ project_id: projects.locked });

    expect(error?.code).toBe("23505");
  });
});
