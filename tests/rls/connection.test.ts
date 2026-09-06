import { afterAll, describe, expect, it } from "vitest";

import {
  createTestUser,
  deleteTestUser,
  serviceClient,
  signInAs,
  TEST_PASSWORD,
} from "../helpers/supabase";

/**
 * Proves the test plumbing itself works against the lumina-dev project before
 * any schema exists: credentials load, the service client reaches the project,
 * and a created user can actually sign in. Every later RLS suite builds on
 * exactly these three things.
 *
 * Lives under tests/rls/ because it needs credentials, and only that suite is
 * kept out of CI. A credential-dependent test anywhere else would fail every
 * CI run.
 */
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await deleteTestUser(id);
});

describe("supabase test plumbing", () => {
  it("loads credentials from .env.test.local", () => {
    expect(process.env.SUPABASE_URL).toMatch(/^https:\/\/.+\.supabase\.co$/);
    expect(process.env.SUPABASE_SECRET_KEY).toBeTruthy();
  });

  it("reaches the project with the service client", async () => {
    const { error } = await serviceClient.auth.admin.listUsers({ perPage: 1 });
    expect(error).toBeNull();
  });

  it("creates a user that can then sign in", async () => {
    const email = `plumbing-${Date.now()}@lumina.test`;
    const id = await createTestUser({
      email,
      password: TEST_PASSWORD,
      name: "Plumbing Probe",
      handle: `plumbing${Date.now()}`,
      roleId: "member",
    });
    created.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const client = await signInAs(email, TEST_PASSWORD);
    const { data } = await client.auth.getUser();
    expect(data.user?.id).toBe(id);
  });

  it("gives a signed-out client no authenticated identity", async () => {
    const { anonClient } = await import("../helpers/supabase");
    const { data } = await anonClient().auth.getUser();
    expect(data.user).toBeNull();
  });
});
