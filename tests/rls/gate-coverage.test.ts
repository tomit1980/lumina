// Both sign-in gates, asserted as a property of the schema rather than of a
// handful of remembered table names.
//
// WHY THIS FILE EXISTS. Lumina gates a half-finished sign-in twice —
// `session_is_assured()` (20260910004000) for a second factor not yet
// answered, `password_is_current()` (20260912000200) for a handed-out password
// not yet replaced — and both are hand-written lists of tables. Both were
// wrong. The assurance list missed `conversations`, `message_attachments` and
// `statuses`, one of them added in the very next migration; the password gate
// had no list because it had no policies at all, and lived entirely in
// `lib/auth.tsx`. The suite stayed green through both, because the only
// assertion about either named `profiles`.
//
// So this asserts the shape of the schema, which is the one job the secret key
// is right for. Nothing here signs anybody in, and nothing here would notice
// if the policies stopped WORKING — it checks that they EXIST.
// forced-enrolment.test.ts is what checks that they bite. Neither is worth
// much without the other.
import { describe, expect, it } from "vitest";

import { serviceClient } from "../helpers/supabase";

const gates = () => serviceClient.rpc("gate_coverage");

const advice = (gate: string, migration: string) =>
  `these tables have row-level security on but no restrictive ${gate} policy, ` +
  `so a session that has not finished signing in reads them. Add them the way ` +
  `${migration} did, or say in a migration why they are deliberately outside ` +
  `the gate`;

describe("every workspace table is inside both sign-in gates", () => {
  it("leaves no table outside require_assurance", async () => {
    const { data, error } = await gates();
    expect(error?.message ?? null).toBeNull();

    const missing = (data ?? [])
      .filter((row) => !row.require_assurance)
      .map((row) => row.table_name);

    expect(missing, advice("require_assurance", "20260912000100_assurance_gaps.sql")).toEqual([]);
  });

  it("leaves no table outside require_password_change", async () => {
    const { data, error } = await gates();
    expect(error?.message ?? null).toBeNull();

    const missing = (data ?? [])
      .filter((row) => !row.require_password_change)
      .map((row) => row.table_name);

    expect(
      missing,
      advice("require_password_change", "20260912000200_password_change_gate.sql")
    ).toEqual([]);
  });

  it("CONTROL: the function sees the whole schema, so an empty answer cannot pass", async () => {
    // The reason `gate_coverage` returns the covered tables too. A function
    // that listed only failures would satisfy both assertions above by finding
    // no tables at all — a typo in the schema name, a `relkind` that stopped
    // matching — and read as "everything is fine". The row count is those
    // assertions' control, so it has to be asserted.
    const { data } = await gates();

    expect((data ?? []).length).toBeGreaterThanOrEqual(22);
    expect((data ?? []).map((row) => row.table_name)).toContain("profiles");
  });
});
