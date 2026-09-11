// Creating a project and its tasks in one transaction.
//
// This is the claim the whole feature rests on: a project and twelve tasks
// arrive together or not at all. It cannot be asserted through the store,
// because the store is what would be doing the half-creating. So every test
// here invokes `create_project_with_tasks` directly, as a real signed-in
// caller, and then asks the database what is actually there.
//
// THE ATOMICITY TEST IS THE THIRD ONE. A caller holding `project.create` but
// not `task.create` gets past the project insert and is refused on the tasks.
// If the function were a convenience wrapper rather than a transaction, that
// caller would be left with an empty project and no way to know why. The test
// asserts the project is *gone*.
//
// The role it needs does not exist by default - Member has `task.create`
// without `project.create`, which is the opposite pairing - so this file
// creates one. That role is also exactly the "ordinary project manager"
// 20260906000350_fix_project_policies.sql contemplates, and the reason task
// set management is not bundled into `project.create`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser, deleteTestUser, serviceClient, signInAs, TEST_PASSWORD,
} from "../helpers/supabase";
import { seedRoles } from "../helpers/workspace";

const stamp = Date.now();
const emails = {
  owner: `inst-owner-${stamp}@lumina.test`,
  member: `inst-member-${stamp}@lumina.test`,
  projectsOnly: `inst-po-${stamp}@lumina.test`,
};
const ids: Record<string, string> = {};
const PROJECTS_ONLY_ROLE = `role_projects_only_${stamp}`;

/** Every project id this file may cause to exist, swept in afterAll. */
const projects = {
  byOwner: `p_inst_owner_${stamp}`,
  retried: `p_inst_retry_${stamp}`,
  refusedNoProject: `p_inst_nopro_${stamp}`,
  refusedNoTasks: `p_inst_notask_${stamp}`,
};

/** The definition being instantiated: five items, in a deliberate order. */
const TITLES = [
  "Collect client identification",
  "Obtain pension fund statement",
  "Verify eligibility",
  "Request medical documentation",
  "Close case",
];

/** Task rows in the shape the RPC's jsonb_to_recordset expects. */
function taskRows(projectKey: string) {
  return TITLES.map((title, i) => ({
    id: `t_${projectKey}_${i}_${stamp}`,
    title,
    description: "",
    status: "backlog",
    priority: "medium",
    labels: [] as string[],
    position: i,
    created_at: new Date().toISOString(),
  }));
}

function projectRow(id: string) {
  return {
    id,
    name: `Pension Release — Client ${id.slice(-4)}`,
    description: "",
    emoji: "📁",
    color: "#7c3aed",
    priority: "medium",
    restricted: false,
    created_at: new Date().toISOString(),
  };
}

beforeAll(async () => {
  await seedRoles();

  // project.create WITHOUT task.create. The pairing does not exist among the
  // four default roles, and it is the only way to reach the second insert's
  // refusal with the first one having succeeded.
  const role = await serviceClient.from("roles").upsert({
    id: PROJECTS_ONLY_ROLE,
    name: "Projects only",
    description: "Can create projects, cannot create tasks.",
    color: "#64748b",
    permissions: ["project.create"],
    is_system: false,
    locked: false,
    rank: 50,
  });
  if (role.error) throw new Error(`role seed failed: ${role.error.message}`);

  ids.owner = await createTestUser({
    email: emails.owner, password: TEST_PASSWORD,
    name: "Ola Owner", handle: `instola${stamp}`, roleId: "owner",
  });
  ids.member = await createTestUser({
    email: emails.member, password: TEST_PASSWORD,
    name: "Mo Member", handle: `instmo${stamp}`, roleId: "member",
  });
  ids.projectsOnly = await createTestUser({
    email: emails.projectsOnly, password: TEST_PASSWORD,
    name: "Pat Projects", handle: `instpat${stamp}`, roleId: PROJECTS_ONLY_ROLE,
  });
});

afterAll(async () => {
  await serviceClient.from("projects").delete().in("id", Object.values(projects));
  for (const id of Object.values(ids)) await deleteTestUser(id);
  await serviceClient.from("roles").delete().eq("id", PROJECTS_ONLY_ROLE);
});

type Client = Awaited<ReturnType<typeof signInAs>>;

async function instantiate(client: Client, projectId: string) {
  return client.rpc("create_project_with_tasks", {
    p_project: projectRow(projectId),
    p_tasks: taskRows(projectId),
  });
}

async function projectExists(id: string): Promise<boolean> {
  const { data } = await serviceClient.from("projects").select("id").eq("id", id).maybeSingle();
  return !!data;
}

async function tasksOf(id: string): Promise<{ title: string; position: number; id: string }[]> {
  const { data } = await serviceClient
    .from("tasks").select("id,title,position").eq("project_id", id).order("position");
  return data ?? [];
}

describe("the happy path, over the wire", () => {
  it("creates the project and exactly five tasks, in the definition's order", async () => {
    const owner = await signInAs(emails.owner, TEST_PASSWORD);

    const { error } = await instantiate(owner, projects.byOwner);
    expect(error, error?.message).toBeNull();

    const tasks = await tasksOf(projects.byOwner);
    expect(tasks).toHaveLength(TITLES.length);
    expect(tasks.map((t) => t.title)).toEqual(TITLES);
    // Positions are sent explicitly, so set_task_position's -1 sentinel never
    // fires and the order is the definition's rather than an insertion race.
    expect(tasks.map((t) => t.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it("gives every task its own id, distinct from anything reused", async () => {
    const tasks = await tasksOf(projects.byOwner);
    const unique = new Set(tasks.map((t) => t.id));

    expect(unique.size).toBe(TITLES.length);
  });
});

describe("running it twice", () => {
  it("adds nothing the second time", async () => {
    // Idempotency, and not by a token: ids are generated in the browser, so a
    // retry, a replayed request, or a double-click that slips past
    // useSubmitOnce carries ids the table already holds.
    const owner = await signInAs(emails.owner, TEST_PASSWORD);

    const first = await instantiate(owner, projects.retried);
    expect(first.error).toBeNull();
    expect(await tasksOf(projects.retried)).toHaveLength(TITLES.length);

    const second = await instantiate(owner, projects.retried);

    // The second call must also SUCCEED - a retry is not an error - while
    // creating nothing. Both halves matter: a function that raised here would
    // turn a harmless replay into a visible failure.
    expect(second.error, second.error?.message).toBeNull();
    expect(await tasksOf(projects.retried)).toHaveLength(TITLES.length);
  });
});

describe("what a refusal leaves behind", () => {
  it("REFUSES a caller without project.create, and creates nothing", async () => {
    const member = await signInAs(emails.member, TEST_PASSWORD);

    const { error } = await instantiate(member, projects.refusedNoProject);

    expect(error).toBeTruthy();
    // The policy raises 42501 before the function's own check is reached, and
    // the message names the table it refused. Asserting THAT rather than a
    // sentence this function composes is what separates this case from the
    // next one: here it is `projects`, there it is `tasks`.
    expect(error?.code).toBe("42501");
    expect(error?.message).toMatch(/"projects"/);
    expect(await projectExists(projects.refusedNoProject)).toBe(false);
    expect(await tasksOf(projects.refusedNoProject)).toHaveLength(0);
  });

  it("ROLLS BACK the project when the tasks are refused", async () => {
    // The transaction test. This caller CAN create the project - the first
    // insert genuinely succeeds - and cannot create tasks. A wrapper would
    // leave an empty project behind and report success on the part that
    // worked. The function raises, and the raise takes the project with it.
    const pat = await signInAs(emails.projectsOnly, TEST_PASSWORD);

    const { error } = await instantiate(pat, projects.refusedNoTasks);

    expect(error).toBeTruthy();
    expect(error?.code).toBe("42501");
    // `tasks`, not `projects` — which is the proof the project insert really
    // did succeed and the transaction really did take it back. If the project
    // had been refused too, this would name the other table and the test would
    // be asserting the wrong rollback.
    expect(error?.message).toMatch(/"tasks"/);
    expect(await projectExists(projects.refusedNoTasks)).toBe(false);
    expect(await tasksOf(projects.refusedNoTasks)).toHaveLength(0);
  });

  it("CONTROL: that same caller CAN create a project on its own", async () => {
    // Proves the rollback above was about the tasks. Without this, a role that
    // could not create projects either would produce an identical result and
    // the test would be asserting the wrong refusal.
    const pat = await signInAs(emails.projectsOnly, TEST_PASSWORD);
    const soloId = `p_inst_solo_${stamp}`;

    const { error } = await pat.rpc("create_project_with_tasks", {
      p_project: projectRow(soloId),
      p_tasks: [],
    });

    expect(error, error?.message).toBeNull();
    expect(await projectExists(soloId)).toBe(true);
    await serviceClient.from("projects").delete().eq("id", soloId);
  });
});
