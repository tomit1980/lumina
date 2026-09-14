// The client's account password: where it is, who may see it, and whether
// looking at it leaves a mark.
//
// THE ONE FIELD THAT IS A CREDENTIAL. Everything else on this record is
// personal data guarded by access control; this is a login to somebody else's
// system, given to us by a client who very likely uses it elsewhere. The spec
// said that if the architecture could not hold it securely, the field was to
// be dropped rather than stored in the clear - so 20260914000100 proves Vault
// round-trips on this database before any of this exists, and this file proves
// the doors to it are the shape they claim.
//
// FOUR CLAIMS, each of which would be a real breach if false:
//
//   1. The value is not on the row. `select *` on `project_client_info` never
//      returns it, to anybody, including the service role.
//   2. Only a project editor can get it back.
//   3. Every reveal is recorded, and the record contains no part of it.
//   4. Clearing or deleting actually removes the ciphertext.
//
// SECURITY DEFINER IS WHY THIS FILE IS NOT OPTIONAL. RLS is not consulted
// inside these two functions - not the table policies, not `require_assurance`,
// not `require_password_change`. Every check is a line of plpgsql in
// `assert_client_editor`, and a line of plpgsql is exactly the kind of thing a
// later edit drops. 20260912000100 and 20260912000200 both exist because
// `find_or_create_dm` had this hole.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { addProjectMember, createProject, seedRoles } from "../helpers/workspace";

const stamp = Date.now();

/** The value under test. Distinctive enough that a substring search for it
 *  across a whole API response is a meaningful assertion. */
const SECRET = `client-portal-pw-${stamp}-QhZ7`;

const emails = {
  editor: `cp-editor-${stamp}@lumina.test`,
  viewer: `cp-viewer-${stamp}@lumina.test`,
  outsider: `cp-outsider-${stamp}@lumina.test`,
  admin: `cp-admin-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};

const projects = {
  locked: `p_cp_locked_${stamp}`,
  other: `p_cp_other_${stamp}`,
  /** Created and destroyed inside one test, to watch the cascade. */
  doomed: `p_cp_doomed_${stamp}`,
};

beforeAll(async () => {
  await seedRoles();
  ids.editor = await createTestUser({
    email: emails.editor, password: TEST_PASSWORD,
    name: "Eve Editor", handle: `cpeve${stamp}`, roleId: "member",
  });
  ids.viewer = await createTestUser({
    email: emails.viewer, password: TEST_PASSWORD,
    name: "Vic Viewer", handle: `cpvic${stamp}`, roleId: "member",
  });
  ids.outsider = await createTestUser({
    email: emails.outsider, password: TEST_PASSWORD,
    name: "Otto Outside", handle: `cpotto${stamp}`, roleId: "member",
  });
  ids.admin = await createTestUser({
    email: emails.admin, password: TEST_PASSWORD,
    name: "Ada Admin", handle: `cpada${stamp}`, roleId: "admin",
  });

  for (const [key, id] of Object.entries(projects)) {
    await createProject({
      id, name: `CP ${key} ${stamp}`, restricted: true, createdBy: ids.admin,
    });
  }
  await addProjectMember(projects.locked, ids.editor, "editor");
  await addProjectMember(projects.locked, ids.viewer, "viewer");
  await addProjectMember(projects.doomed, ids.editor, "editor");
  await addProjectMember(projects.other, ids.outsider, "editor");
});

afterAll(async () => {
  await serviceClient.from("projects").delete().in("id", Object.values(projects));
  for (const id of Object.values(ids)) await deleteTestUser(id);
});

/** The pointer on the row, read with the service key so RLS explains nothing
 *  away. */
async function secretIdOf(projectId: string): Promise<string | null> {
  const { data } = await serviceClient
    .from("project_client_info").select("password_secret_id")
    .eq("project_id", projectId).maybeSingle();
  return data?.password_secret_id ?? null;
}

/**
 * Every client-password secret still in the vault, by id.
 *
 * Through `client_secret_ids()` (20260914000300) rather than by querying
 * `vault.secrets` directly, because the vault schema is not exposed to
 * PostgREST AT ALL - not even to the service role. A direct query returns
 * `PGRST106` with `data: null`, and a test that read that as "no rows" would
 * report every ciphertext-lifetime claim below as green while every secret sat
 * there untouched. That is the whole reason that migration exists.
 */
async function vaultSecretIds(): Promise<string[]> {
  const { data, error } = await serviceClient.rpc("client_secret_ids");
  if (error) throw new Error(`client_secret_ids failed: ${error.message}`);
  return (data ?? []).map((r) => r.secret_id);
}

/** Every activity line on a project, newest last. */
async function feedFor(projectId: string) {
  const { data } = await serviceClient
    .from("activities").select("*").eq("project_id", projectId).order("ts");
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Where it is
// ---------------------------------------------------------------------------

describe("the value is not on the row", () => {
  it("stores a pointer and nothing else", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    const { error } = await them.rpc("set_client_password", {
      p_project_id: projects.locked, p_value: SECRET,
    });

    expect(error).toBeNull();
    expect(await secretIdOf(projects.locked)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never returns it from a select, not even to the service role", async () => {
    // The service role bypasses RLS entirely, so this is the strongest form of
    // the claim available: the value is not in the table at all, rather than
    // being in it behind a policy. A `select *` is deliberate - naming columns
    // would let a future column holding the value slip past.
    const { data, error } = await serviceClient
      .from("project_client_info").select("*").eq("project_id", projects.locked);

    expect(error).toBeNull();
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it("never returns it to the editor's own select either", async () => {
    // The same claim from the browser's side - this is literally the request
    // `hydrate()` makes on every sign-in, so a value that appeared here would
    // be in every tab's memory.
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    const { data } = await them.from("project_client_info").select("*");

    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it("gives a signed-in session no route to the vault itself", async () => {
    // `vault` is owned by supabase_admin and is not one of PostgREST's exposed
    // schemas, so a browser session cannot reach the ciphertext or the
    // decrypted view directly. Asserted rather than assumed: "the schema is
    // not exposed" is a configuration fact, and configuration changes.
    //
    // Asked by NAMING THE SCHEMA. An earlier version of this test asked for
    // `from("decrypted_secrets")` in the default schema, which does not exist
    // there - so it was asserting that PostgREST 404s an unknown table, and
    // would have passed just as happily with the vault wide open.
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    for (const table of ["secrets", "decrypted_secrets"]) {
      const { data, error } = await them
        // @ts-expect-error -- deliberately reaching outside the generated
        // types, because the question is what the SERVER does with it.
        .schema("vault").from(table).select("*");

      expect(error).not.toBeNull();
      expect(data).toBeNull();
      expect(JSON.stringify(data)).not.toContain(SECRET);
    }
  });

  it("CONTROL: the ciphertext really is in the vault, under that pointer", async () => {
    // Without this, the refusal above would pass equally if the vault were
    // empty, the schema had been renamed, or nothing had ever been stored -
    // none of which would mean the secret was safe.
    //
    // Asked through `client_secret_ids()`, because the service role cannot
    // reach `vault.secrets` over the API either. The value itself comes back
    // through the one sanctioned door, in the reveal tests below.
    const secretId = await secretIdOf(projects.locked);

    expect(await vaultSecretIds()).toContain(secretId);
  });

  it("the vault is closed to the service role as well, and that is deliberate", async () => {
    // Stated plainly so nobody later reads the refusal above as a
    // role-specific grant. The schema is not exposed to PostgREST at all; the
    // only routes in are the two definer functions and this audit function,
    // each of which decides for itself who may call it.
    const { error } = await serviceClient
      // @ts-expect-error -- deliberately outside the generated types.
      .schema("vault").from("secrets").select("id");

    expect(error?.code).toBe("PGRST106");
  });
});

// ---------------------------------------------------------------------------
// Who may get it back
// ---------------------------------------------------------------------------

describe("who may reveal it", () => {
  it("gives it to a project editor", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    const { data, error } = await them.rpc("reveal_client_password", {
      p_project_id: projects.locked,
    });

    expect(error).toBeNull();
    expect(data).toBe(SECRET);
  });

  it("REFUSES a viewer", async () => {
    // A viewer may read every other field on this record - see
    // client-info.test.ts - so this is a genuinely separate gate rather than a
    // second statement of the read rule. That is the point of the control
    // below.
    const them = await signInAs(emails.viewer, TEST_PASSWORD);

    const { data, error } = await them.rpc("reveal_client_password", {
      p_project_id: projects.locked,
    });

    // RAISES rather than filtering: these are plpgsql checks, not policies. A
    // test that assumed the silent-filter shape would pass on `error` being
    // falsy and prove nothing.
    expect(error?.message ?? "").toContain("cannot edit this project");
    expect(data).toBeNull();
  });

  it("CONTROL: that same viewer still reads the rest of the record", async () => {
    // Without this, the refusal above would pass equally against a viewer who
    // had lost access to the project entirely - which would be a different
    // bug wearing the same result.
    const them = await signInAs(emails.viewer, TEST_PASSWORD);

    const { data } = await them
      .from("project_client_info").select("project_id")
      .eq("project_id", projects.locked);

    expect(data ?? []).toHaveLength(1);
  });

  it("REFUSES somebody on another project, with the same sentence", async () => {
    // Identical wording to the viewer's refusal, on purpose: "no such project"
    // and "a project you may not see" must not be distinguishable, or the
    // function becomes an oracle for which project ids exist.
    const them = await signInAs(emails.outsider, TEST_PASSWORD);

    const { error } = await them.rpc("reveal_client_password", {
      p_project_id: projects.locked,
    });

    expect(error?.message ?? "").toContain("cannot edit this project");
  });

  it("REFUSES a project id that does not exist, with the same sentence again", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    const { error } = await them.rpc("reveal_client_password", {
      p_project_id: `p_does_not_exist_${stamp}`,
    });

    expect(error?.message ?? "").toContain("cannot edit this project");
  });

  it("REFUSES a viewer the right to SET one", async () => {
    const them = await signInAs(emails.viewer, TEST_PASSWORD);

    const { error } = await them.rpc("set_client_password", {
      p_project_id: projects.locked, p_value: "set-by-a-viewer",
    });

    expect(error?.message ?? "").toContain("cannot edit this project");
    // And the editor's value is still the one stored - a refused set that
    // nonetheless overwrote would be worse than one that succeeded.
    const editor = await signInAs(emails.editor, TEST_PASSWORD);
    const { data } = await editor.rpc("reveal_client_password", {
      p_project_id: projects.locked,
    });
    expect(data).toBe(SECRET);
  });

  it("lets an admin reveal it without being a member of the project", async () => {
    const them = await signInAs(emails.admin, TEST_PASSWORD);

    const { data, error } = await them.rpc("reveal_client_password", {
      p_project_id: projects.locked,
    });

    expect(error).toBeNull();
    expect(data).toBe(SECRET);
  });

  it("REFUSES an anonymous caller", async () => {
    // `revoke all from public; grant execute to authenticated` - so this fails
    // at the grant rather than inside the function. Either way it must fail,
    // and the publishable key is in the bundle.
    const { anonClient } = await import("../helpers/supabase");
    const them = anonClient();

    const { data, error } = await them.rpc("reveal_client_password", {
      p_project_id: projects.locked,
    });

    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("REFUSES a session that has not finished signing in", async () => {
    // THE DEFINER HOLE, asked directly. RLS is not consulted inside these two
    // functions, so neither `require_assurance` nor `require_password_change`
    // reaches them - the checks are lines of plpgsql in `assert_client_editor`
    // and nothing else. `find_or_create_dm` shipped without them twice
    // (20260912000100, 20260912000200), which is why this is asserted rather
    // than trusted.
    //
    // `must_change_password` is the half that can be set from a test without
    // enrolling a real second factor. Both branches raise the same sentence.
    await serviceClient
      .from("profiles").update({ must_change_password: true }).eq("id", ids.editor);
    try {
      const them = await signInAs(emails.editor, TEST_PASSWORD);

      const reveal = await them.rpc("reveal_client_password", {
        p_project_id: projects.locked,
      });
      const set = await them.rpc("set_client_password", {
        p_project_id: projects.locked, p_value: "set-while-gated",
      });

      expect(reveal.error?.message ?? "").toContain("Finish signing in");
      expect(reveal.data).toBeNull();
      expect(set.error?.message ?? "").toContain("Finish signing in");
    } finally {
      await serviceClient
        .from("profiles").update({ must_change_password: false }).eq("id", ids.editor);
    }
  });

  it("CONTROL: the same editor, no longer gated, gets it back", async () => {
    // Otherwise the refusal above would pass against an editor who had simply
    // lost access to the project, or a function that refused everybody.
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    const { data, error } = await them.rpc("reveal_client_password", {
      p_project_id: projects.locked,
    });

    expect(error).toBeNull();
    expect(data).toBe(SECRET);
  });
});

// ---------------------------------------------------------------------------
// Looking leaves a mark
// ---------------------------------------------------------------------------

describe("every reveal is recorded", () => {
  it("writes exactly one line per reveal, naming nobody's password", async () => {
    const before = (await feedFor(projects.locked)).length;
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    await them.rpc("reveal_client_password", { p_project_id: projects.locked });
    await them.rpc("reveal_client_password", { p_project_id: projects.locked });

    const after = await feedFor(projects.locked);
    expect(after.length).toBe(before + 2);

    const lines = after.slice(-2);
    for (const line of lines) {
      expect(line.text).toContain("revealed the client's stored password");
      expect(line.actor_id).toBe(ids.editor);
      expect(line.project_id).toBe(projects.locked);
      expect(line.kind).toBe("project");
    }
    // Not one character of it, anywhere in the feed.
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });

  it("records a reveal that found nothing stored", async () => {
    // "Who looked" is the question this answers, and an empty look is still a
    // look. A function that returned early before logging would let somebody
    // probe which projects have a password stored, silently.
    const them = await signInAs(emails.editor, TEST_PASSWORD);
    const before = (await feedFor(projects.doomed)).length;

    const { data, error } = await them.rpc("reveal_client_password", {
      p_project_id: projects.doomed,
    });

    expect(error).toBeNull();
    expect(data).toBeNull();
    expect((await feedFor(projects.doomed)).length).toBe(before + 1);
  });

  it("records a set and a clear, without the value", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);
    const before = (await feedFor(projects.doomed)).length;

    await them.rpc("set_client_password", {
      p_project_id: projects.doomed, p_value: `doomed-${SECRET}`,
    });
    await them.rpc("set_client_password", {
      p_project_id: projects.doomed, p_value: null as unknown as string,
    });

    const after = await feedFor(projects.doomed);
    expect(after.length).toBe(before + 2);
    expect(after.at(-2)!.text).toContain("set the client's stored password");
    expect(after.at(-1)!.text).toContain("cleared the client's stored password");
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });

  it("the line is visible to the project, and to nobody else", async () => {
    // `activities_read` (20260909000900) filters on project_id, so the record
    // of who looked reaches exactly the people who could have looked. An
    // unscoped line would tell the whole workspace that this project has a
    // client password worth looking at.
    const outsider = await signInAs(emails.outsider, TEST_PASSWORD);
    const viewer = await signInAs(emails.viewer, TEST_PASSWORD);

    const theirs = await outsider
      .from("activities").select("id").eq("project_id", projects.locked);
    const mine = await viewer
      .from("activities").select("id").eq("project_id", projects.locked);

    expect(theirs.data ?? []).toHaveLength(0);
    // The viewer cannot reveal it but can see that somebody did, which is the
    // point of an audit line.
    expect((mine.data ?? []).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Replacing, clearing, deleting
// ---------------------------------------------------------------------------

describe("the ciphertext's lifetime", () => {
  it("replacing DELETES the old secret rather than orphaning it", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);
    const oldId = await secretIdOf(projects.locked);
    expect(await vaultSecretIds()).toContain(oldId);

    await them.rpc("set_client_password", {
      p_project_id: projects.locked, p_value: `${SECRET}-v2`,
    });

    const newId = await secretIdOf(projects.locked);
    expect(newId).not.toBe(oldId);

    // The half that is easy to get wrong and impossible to notice: the old
    // ciphertext is GONE, not merely unreferenced.
    const inVault = await vaultSecretIds();
    expect(inVault).not.toContain(oldId);
    expect(inVault).toContain(newId);

    const { data } = await them.rpc("reveal_client_password", {
      p_project_id: projects.locked,
    });
    expect(data).toBe(`${SECRET}-v2`);
  });

  it("clearing takes the pointer off AND removes the ciphertext", async () => {
    const them = await signInAs(emails.editor, TEST_PASSWORD);
    const clearedId = await secretIdOf(projects.locked);

    await them.rpc("set_client_password", {
      p_project_id: projects.locked, p_value: null as unknown as string,
    });

    expect(await secretIdOf(projects.locked)).toBeNull();
    expect(await vaultSecretIds()).not.toContain(clearedId);
    const { data } = await them.rpc("reveal_client_password", {
      p_project_id: projects.locked,
    });
    expect(data).toBeNull();
  });

  it("treats an empty string as a clear, not as a password", async () => {
    // Otherwise `hasPassword` would be true for a password of length zero, and
    // the Reveal button would reveal nothing while insisting there is
    // something there.
    const them = await signInAs(emails.editor, TEST_PASSWORD);

    await them.rpc("set_client_password", {
      p_project_id: projects.locked, p_value: `${SECRET}-v3`,
    });
    await them.rpc("set_client_password", {
      p_project_id: projects.locked, p_value: "",
    });

    expect(await secretIdOf(projects.locked)).toBeNull();
  });

  it("creates the record when the password is the first thing set", async () => {
    // The lazy-creation path through the RPC rather than through a table
    // write. Without the upsert inside `set_client_password` this would raise
    // a foreign-key error on a project nobody had typed into yet.
    const them = await signInAs(emails.editor, TEST_PASSWORD);
    await serviceClient.from("project_client_info").delete().eq("project_id", projects.doomed);

    const { error } = await them.rpc("set_client_password", {
      p_project_id: projects.doomed, p_value: `${SECRET}-fresh`,
    });

    expect(error).toBeNull();
    expect(await secretIdOf(projects.doomed)).not.toBeNull();
  });

  it("deleting the project destroys the ciphertext with it", async () => {
    // The end of a case has to be the end of the credential. Without the
    // `before delete` trigger the row would cascade away and leave an
    // undeletable, unreferenced secret in the vault forever.
    const them = await signInAs(emails.editor, TEST_PASSWORD);
    await them.rpc("set_client_password", {
      p_project_id: projects.doomed, p_value: `${SECRET}-doomed`,
    });
    const secretId = await secretIdOf(projects.doomed);
    expect(secretId).not.toBeNull();

    await serviceClient.from("projects").delete().eq("id", projects.doomed);

    expect(await vaultSecretIds()).not.toContain(secretId);
  });

  it("leaves no orphaned ciphertext behind at all", async () => {
    // The sweep, rather than one id at a time: every client-password secret in
    // the vault must still be pointed at by a live record. An orphan is
    // ciphertext that outlived the case it belonged to, and the two tests
    // above only check the ids they happen to know about.
    const { data, error } = await serviceClient.rpc("client_secret_ids");

    expect(error).toBeNull();
    expect((data ?? []).filter((r) => !r.referenced)).toEqual([]);
  });
});
