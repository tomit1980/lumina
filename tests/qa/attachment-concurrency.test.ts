// QA-101 (Critical) — a stale attachment list permanently destroyed another
// person's file, bytes and row.
//
// `syncAttachmentLinks` used to read the `attachments` array it was handed as
// the complete, current set and delete anything linked on the server but
// missing from it. No caller has a current set: the task dialog holds the
// snapshot it took when it opened, and the projects page holds the one its
// render closed over. So two people working on one task or project silently
// destroyed each other's files — a save that changed only a title took a
// colleague's upload with it, bytes and row, with no error and nothing to
// recover from.
//
// THE SHAPE THAT MATTERS IS TWO WRITERS. A single caller with a correct list
// passes either way and proves nothing, which is exactly why the unit suites
// could not see this: nothing in them has a second human. So this file runs a
// stateful stand-in for the server and drives two `SupabaseBackend`s at it,
// each holding a snapshot taken at a different moment — the real sequence,
// not a re-statement of the diff.
//
// The double is stateful on purpose. A per-table fixture cannot express "the
// server changed between when this caller read it and when it wrote", and
// that gap IS the bug.
import { describe, expect, it } from "vitest";

import { SupabaseBackend } from "@/lib/backend/supabase";
import type { LuminaClient } from "@/lib/backend/supabase/client";
import type { Attachment } from "@/lib/types";

// ---------------------------------------------------------------------------
// A tiny stateful server: the four tables these two writes touch, plus the
// bucket. Every statement below is one this code really issues.
// ---------------------------------------------------------------------------

interface Row {
  [column: string]: unknown;
}

function createServer() {
  const tables: Record<string, Row[]> = {
    projects: [{ id: "p1", name: "Docs", created_by: "u_moshe" }],
    tasks: [{ id: "t1", assignee_id: null }],
    attachments: [],
    project_attachments: [],
    task_attachments: [],
  };
  /** bucket -> set of object paths that really hold bytes. */
  const objects: Record<string, Set<string>> = {
    "project-files": new Set(),
    "task-files": new Set(),
  };

  const matches = (row: Row, filters: Array<[string, unknown[]]>) =>
    filters.every(([column, values]) => values.includes(row[column]));

  const from = (table: string) => {
    const filters: Array<[string, unknown[]]> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] = [];

    const rows = () => (tables[table] ??= []);

    const run = () => {
      const hit = rows().filter((r) => matches(r, filters));
      if (op === "select") return { data: hit.map((r) => ({ ...r })), error: null };
      if (op === "insert") {
        const incoming = Array.isArray(payload) ? payload : [payload];
        rows().push(...incoming.map((r) => ({ ...r })));
        return { data: incoming.map((r) => ({ ...r })), error: null };
      }
      if (op === "update") {
        for (const row of hit) Object.assign(row, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      tables[table] = rows().filter((r) => !matches(r, filters));
      if (table === "attachments") {
        // `project_attachments.attachment_id` / `task_attachments.attachment_id`
        // are both `on delete cascade`, and the fact that a link disappears
        // with the row it points at is part of what these tests assert.
        const gone = new Set(hit.map((r) => r.id));
        for (const link of ["project_attachments", "task_attachments"]) {
          tables[link] = (tables[link] ?? []).filter(
            (r) => !gone.has(r.attachment_id as string)
          );
        }
      }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };

    const self: Record<string, unknown> = {
      select: () => self,
      order: () => self,
      limit: () => self,
      eq: (column: string, value: unknown) => {
        filters.push([column, [value]]);
        return self;
      },
      in: (column: string, values: unknown[]) => {
        filters.push([column, values]);
        return self;
      },
      insert: (value: Row | Row[]) => {
        op = "insert";
        payload = value;
        return self;
      },
      update: (value: Row) => {
        op = "update";
        payload = value;
        return self;
      },
      upsert: (value: Row | Row[]) => {
        op = "insert";
        payload = value;
        return self;
      },
      delete: () => {
        op = "delete";
        return self;
      },
      maybeSingle: () => Promise.resolve(run()).then((r) => ({ data: r.data[0] ?? null, error: null })),
      single: () => Promise.resolve(run()).then((r) => ({ data: r.data[0] ?? null, error: null })),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return self;
  };

  const storage = {
    from: (bucket: string) => ({
      upload: (path: string) => {
        objects[bucket].add(path);
        return Promise.resolve({ data: { path }, error: null });
      },
      update: (path: string) => {
        objects[bucket].add(path);
        return Promise.resolve({ data: { path }, error: null });
      },
      remove: (paths: string[]) => {
        const gone = paths.filter((p) => objects[bucket].delete(p));
        return Promise.resolve({ data: gone.map((name) => ({ name })), error: null });
      },
    }),
  };

  const client = {
    from,
    storage,
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: "u_moshe" } } }, error: null }),
    },
    rpc: () => Promise.resolve({ data: true, error: null }),
  };

  /** Put a file on the server the way an upload does: row, bytes, link. */
  const seedFile = (
    owner: "project" | "task",
    id: string,
    uploadedBy: string
  ): Attachment => {
    const bucket = owner === "project" ? "project-files" : "task-files";
    tables.attachments.push({
      id,
      name: `${id}.md`,
      storage_path: `${bucket}/${id}`,
      size: 10,
      uploaded_by: uploadedBy,
    });
    objects[bucket].add(id);
    tables[`${owner}_attachments`].push(
      owner === "project"
        ? { project_id: "p1", attachment_id: id }
        : { task_id: "t1", attachment_id: id }
    );
    return {
      id,
      name: `${id}.md`,
      size: 10,
      type: "text/markdown",
      dataUrl: `${bucket}/${id}`,
      uploadedBy,
      uploadedAt: 0,
    };
  };

  return {
    backend: () => new SupabaseBackend(client as unknown as LuminaClient),
    seedFile,
    linkedTo: (owner: "project" | "task") =>
      tables[`${owner}_attachments`].map((r) => r.attachment_id as string).sort(),
    rowIds: () => tables.attachments.map((r) => r.id as string).sort(),
    bytesIn: (bucket: string) => [...objects[bucket]].sort(),
  };
}

describe("two writers holding divergent snapshots (QA-101)", () => {
  it("a project save from a STALE snapshot does not delete the file the other writer just added", async () => {
    const server = createServer();
    const shared = server.seedFile("project", "a_shared", "u_moshe");

    // Dana opens the project's Files tab. Her closure now holds [a_shared].
    const danaSnapshot = [shared];

    // Moshe uploads a second file while that page is open.
    const added = server.seedFile("project", "a_moshe", "u_moshe");
    await server
      .backend()
      .updateProject("p1", { attachments: [shared, added] });

    // Dana renames the project. She sends the list she has — which is now a
    // file short, through no fault of hers, and says nothing about removal.
    await server.backend().updateProject("p1", {
      name: "Renamed",
      attachments: danaSnapshot,
    });

    // Moshe's file is untouched: link, row and bytes.
    expect(server.linkedTo("project")).toEqual(["a_moshe", "a_shared"]);
    expect(server.rowIds()).toEqual(["a_moshe", "a_shared"]);
    expect(server.bytesIn("project-files")).toEqual(["a_moshe", "a_shared"]);
  });

  it("a task save from a STALE snapshot does not delete the file the other writer just added", async () => {
    // The worst window of the three the finding names: `form.attachments` is
    // seeded once when the dialog opens and lives in local state until Save,
    // so the exposure is the whole time the dialog is up.
    const server = createServer();
    const shared = server.seedFile("task", "a_shared", "u_moshe");
    const danaSnapshot = [shared];

    const added = server.seedFile("task", "a_moshe", "u_moshe");
    await server.backend().updateTask("t1", { attachments: [shared, added] });

    // Dana changes only the title.
    await server.backend().updateTask("t1", {
      title: "Renamed",
      attachments: danaSnapshot,
    });

    expect(server.linkedTo("task")).toEqual(["a_moshe", "a_shared"]);
    expect(server.rowIds()).toEqual(["a_moshe", "a_shared"]);
    expect(server.bytesIn("task-files")).toEqual(["a_moshe", "a_shared"]);
  });

  it("a NAMED removal still deletes the file, bytes and row — the control", async () => {
    // Without this the two tests above would pass against a backend that had
    // simply stopped deleting anything, which is not the fix. Removal still
    // works; it just has to be said rather than inferred.
    const server = createServer();
    const shared = server.seedFile("project", "a_shared", "u_moshe");
    const doomed = server.seedFile("project", "a_doomed", "u_moshe");

    await server.backend().updateProject("p1", {
      attachments: [shared],
      removedAttachmentIds: [doomed.id],
    });

    expect(server.linkedTo("project")).toEqual(["a_shared"]);
    expect(server.rowIds()).toEqual(["a_shared"]);
    expect(server.bytesIn("project-files")).toEqual(["a_shared"]);
  });

  it("a stale snapshot still LINKS a file the caller really added", async () => {
    // The other half of "the array is what you believe, not an assertion":
    // it must keep working as an add.
    const server = createServer();
    const shared = server.seedFile("project", "a_shared", "u_moshe");
    const mine: Attachment = {
      id: "a_mine",
      name: "mine.md",
      size: 4,
      type: "text/markdown",
      dataUrl: "project-files/a_mine",
      uploadedBy: "u_dana",
      uploadedAt: 0,
    };

    await server.backend().updateProject("p1", { attachments: [shared, mine] });

    expect(server.linkedTo("project")).toEqual(["a_mine", "a_shared"]);
  });
});
