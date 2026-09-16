// @vitest-environment jsdom
//
// The store's half of the client record.
//
// The access rules are the database's — `client_info_*`, `client_documents_*`
// and the two `security definer` functions in 20260914000200 decide every one
// of them, and tests/rls/client-info.test.ts and client-password.test.ts
// assert that from real sessions. This file covers what the store owes the
// person at the keyboard: refusing a viewer before the network, refusing a
// value the column would not accept, keeping the optimistic record honest, and
// putting the old value back when a write is refused.
//
// TWO THINGS ARE PINNED HERE THAT ARE EASY TO LOSE LATER:
//
//   * The record belongs to ONE project. Every test that writes asserts the
//     other project is untouched, because "showed client A's details under
//     client B's name" is the failure this feature could actually do harm
//     with, and it would look like a working feature from every other angle.
//   * The password is never in `AppState`. `hasPassword` is, and that is all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { FailingBackend, addProject, adminState, asUser, baseState, mount, run } from "./_support";
import { CLIENT_DOCUMENT_TYPES } from "@/lib/client-info";
import type { ClientInfoPatch } from "@/lib/backend/types";
import type { AppState } from "@/lib/types";

/** A restricted project this user may only read — the shape `client_info_insert`
 *  refuses in the database and `clientEditGuard` refuses here. */
function withViewerProject(userId: string): AppState {
  return addProject(asUser(baseState(), userId), {
    id: "p_locked",
    name: "Locked Case",
    createdBy: "u_sam",
    restricted: true,
    members: [{ userId, level: "viewer" as const }],
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  toastMock.error.mockClear();
});

// ---------------------------------------------------------------------------
// Who may write
// ---------------------------------------------------------------------------

describe("who may edit the record", () => {
  it("refuses a viewer BEFORE any network call", async () => {
    // "Refused" and "attempted and then refused" produce the same sentence on
    // screen, so the only way to tell them apart is to ask the backend what it
    // was asked to do. A store that called anyway would leave the write in
    // `attempted` and would depend on the policy to catch it.
    const backend = new FailingBackend("updateClientInfo");
    const { result } = await mount(withViewerProject("u_maya"), backend);

    const ok = await run(() =>
      result.current.updateClientInfo("p_locked", { fullName: "Dana Reed" })
    );

    expect(ok).toBe(false);
    expect(backend.attempted).toEqual([]);
    expect(
      result.current.state.projects.find((p) => p.id === "p_locked")!.client
    ).toBeNull();
  });

  it("CONTROL: an editor on the same restricted project gets through", async () => {
    // Without this the refusal above would pass just as happily against a
    // guard that refused everybody, or a project nobody could see at all.
    const state = addProject(asUser(baseState(), "u_maya"), {
      id: "p_locked",
      name: "Locked Case",
      createdBy: "u_sam",
      restricted: true,
      members: [{ userId: "u_maya", level: "editor" as const }],
    });
    const { result } = await mount(state);

    const ok = await run(() =>
      result.current.updateClientInfo("p_locked", { fullName: "Dana Reed" })
    );

    expect(ok).toBe(true);
    expect(
      result.current.state.projects.find((p) => p.id === "p_locked")!.client!.fullName
    ).toBe("Dana Reed");
  });

  it("lets an ordinary member edit an unrestricted project's record", async () => {
    // The decision that separates this from `updateProject`: u_maya is a
    // Member and holds neither `project.create` nor ownership of p_website, so
    // `projectIsManageable` is false for her. Editor access to the project is
    // the bar, and she has it — mirroring `client_info_insert`, which asks
    // only `can_see_project and not project_is_viewer_only`.
    const { result } = await mount(asUser(baseState(), "u_maya"));

    const ok = await run(() =>
      result.current.updateClientInfo("p_website", { phone: "+61 412 345 678" })
    );

    expect(ok).toBe(true);
  });

  it("CONTROL: that same member cannot edit the project itself", async () => {
    // The other half of the line above. If this ever passes, the two bars have
    // been collapsed into one and the decision has been quietly reversed.
    const { result } = await mount(asUser(baseState(), "u_maya"));

    const ok = await run(() =>
      result.current.updateProject("p_website", { name: "Renamed" })
    );

    expect(ok).toBe(false);
  });

  it("refuses a viewer the document checkboxes too", async () => {
    const backend = new FailingBackend("setClientDocument");
    const { result } = await mount(withViewerProject("u_maya"), backend);

    const ok = await run(() =>
      result.current.setClientDocument("p_locked", "certified_id", true)
    );

    expect(ok).toBe(false);
    expect(backend.attempted).toEqual([]);
  });

  it("refuses a viewer the password, in both directions", async () => {
    const backend = new FailingBackend("updateClientInfo");
    const { result } = await mount(withViewerProject("u_maya"), backend);

    const set = await run(() =>
      result.current.setClientPassword("p_locked", "hunter2")
    );
    const shown = await run(() => result.current.revealClientPassword("p_locked"));

    expect(set).toBe(false);
    expect(shown).toBeNull();
    // Neither reached the seam. A reveal that got as far as the RPC would have
    // written a "revealed the password" line for a request nobody was entitled
    // to make.
    expect(backend.attempted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every field
// ---------------------------------------------------------------------------

describe("every field saves and is readable back", () => {
  // Table-driven, one `it` per field: a single test writing all sixteen would
  // go red on any one of them and name none.
  const FIELDS = [
    ["fullName", "Dana Reed"],
    ["dateOfBirth", "1968-03-02"],
    ["phone", "+61 412 345 678"],
    ["email", "dana.reed@example.com"],
    ["address", "12 Wattle St, Fitzroy VIC 3065"],
    ["superCompany", "AustralianSuper"],
    ["memberId", "AS-99120043"],
    ["amount", 128450.5],
    ["diagnosis", "Stage 3 renal failure"],
    ["lastDayOfWork", "2025-11-28"],
    ["employerName", "Barwon Freight Pty Ltd"],
    ["contractSigned", true],
    ["newPhone", "(03) 9876 5432"],
    ["newEmail", "d.reed.new@example.com"],
  ] as const;

  for (const [field, value] of FIELDS) {
    it(`saves ${field}`, async () => {
      const { result } = await mount(adminState());

      const ok = await run(() =>
        result.current.updateClientInfo("p_website", { [field]: value })
      );

      expect(ok).toBe(true);
      const client = result.current.state.projects.find((p) => p.id === "p_website")!.client!;
      expect(client[field]).toEqual(value);
    });
  }

  it("creates the record on the first edit and keeps it on the second", async () => {
    // The lazy backfill, stated as behaviour: no project has a record until
    // somebody types, and the second edit must not wipe the first.
    const { result } = await mount(adminState());
    expect(
      result.current.state.projects.find((p) => p.id === "p_website")!.client
    ).toBeNull();

    await run(() => result.current.updateClientInfo("p_website", { fullName: "Dana Reed" }));
    await run(() => result.current.updateClientInfo("p_website", { memberId: "AS-1" }));

    const client = result.current.state.projects.find((p) => p.id === "p_website")!.client!;
    expect(client.fullName).toBe("Dana Reed");
    expect(client.memberId).toBe("AS-1");
  });

  it("keeps the original phone and email when new ones are recorded", async () => {
    // The requirement stated as an assertion rather than a comment: this is
    // the one field pair where an "obvious" implementation (overwrite) loses
    // information that cannot be recovered.
    const { result } = await mount(adminState());

    await run(() =>
      result.current.updateClientInfo("p_website", {
        phone: "+61 412 345 678",
        email: "dana@old.example.com",
      })
    );
    await run(() =>
      result.current.updateClientInfo("p_website", {
        newPhone: "+61 400 111 222",
        newEmail: "dana@new.example.com",
      })
    );

    const client = result.current.state.projects.find((p) => p.id === "p_website")!.client!;
    expect(client.phone).toBe("+61 412 345 678");
    expect(client.email).toBe("dana@old.example.com");
    expect(client.newPhone).toBe("+61 400 111 222");
    expect(client.newEmail).toBe("dana@new.example.com");
  });

  it("sends only the fields in the patch", async () => {
    // Everything else must be absent rather than null: a patch carrying
    // `diagnosis: undefined` as `null` would blank a colleague's entry every
    // time somebody edited an unrelated box.
    const seen: Array<Record<string, unknown>> = [];
    const backend = new FailingBackend("createProject");
    const original = backend.updateClientInfo.bind(backend);
    backend.updateClientInfo = ((_projectId: string, patch: ClientInfoPatch) => {
      seen.push(patch as Record<string, unknown>);
      return original();
    }) as typeof backend.updateClientInfo;
    const { result } = await mount(adminState(), backend);

    await run(() => result.current.updateClientInfo("p_website", { memberId: "AS-1" }));

    expect(seen).toEqual([{ memberId: "AS-1" }]);
  });
});

describe("the five documents", () => {
  for (const doc of CLIENT_DOCUMENT_TYPES) {
    it(`records ${doc.id} on its own`, async () => {
      const { result } = await mount(adminState());

      const ok = await run(() =>
        result.current.setClientDocument("p_website", doc.id, true)
      );

      expect(ok).toBe(true);
      const client = result.current.state.projects.find((p) => p.id === "p_website")!.client!;
      // Exactly this one, and nothing else — a write that set the whole map
      // would pass a test that only checked its own key.
      expect(client.documents).toEqual({ [doc.id]: true });
    });
  }

  it("unticks without disturbing the others", async () => {
    const { result } = await mount(adminState());

    await run(() => result.current.setClientDocument("p_website", "photo_id_front", true));
    await run(() => result.current.setClientDocument("p_website", "certified_id", true));
    await run(() => result.current.setClientDocument("p_website", "photo_id_front", false));

    const client = result.current.state.projects.find((p) => p.id === "p_website")!.client!;
    expect(client.documents).toEqual({ photo_id_front: false, certified_id: true });
  });

  it("creates the record when a checkbox is the first thing touched", async () => {
    // The other lazy-creation path. A record that only came into being through
    // `updateClientInfo` would leave this one writing into `null`.
    const { result } = await mount(adminState());

    await run(() => result.current.setClientDocument("p_website", "bank_statement", true));

    expect(
      result.current.state.projects.find((p) => p.id === "p_website")!.client!.documents
    ).toEqual({ bank_statement: true });
  });
});

// ---------------------------------------------------------------------------
// One project, one record
// ---------------------------------------------------------------------------

describe("a record belongs to exactly one project", () => {
  it("does not put one project's details on another", async () => {
    const { result } = await mount(adminState());

    await run(() =>
      result.current.updateClientInfo("p_website", {
        fullName: "Dana Reed",
        memberId: "AS-99120043",
      })
    );
    await run(() => result.current.setClientDocument("p_website", "certified_id", true));

    expect(
      result.current.state.projects.find((p) => p.id === "p_mobile")!.client
    ).toBeNull();
  });

  it("keeps two records apart when both are filled in", async () => {
    const { result } = await mount(adminState());

    await run(() => result.current.updateClientInfo("p_website", { fullName: "Dana Reed" }));
    await run(() => result.current.updateClientInfo("p_mobile", { fullName: "Sam Okafor" }));

    const projects = result.current.state.projects;
    expect(projects.find((p) => p.id === "p_website")!.client!.fullName).toBe("Dana Reed");
    expect(projects.find((p) => p.id === "p_mobile")!.client!.fullName).toBe("Sam Okafor");
  });
});

// ---------------------------------------------------------------------------
// Values the column would not accept
// ---------------------------------------------------------------------------

describe("what the store refuses before the round trip", () => {
  const REFUSED: Array<[string, Record<string, unknown>]> = [
    ["an email with no @", { email: "dana.example.com" }],
    ["an email with no domain", { email: "dana@" }],
    ["a new email that is not one", { newEmail: "nope" }],
    ["a phone that is a name", { phone: "Dana Reed" }],
    ["a phone with too few digits", { phone: "12345" }],
    ["a new phone that is not one", { newPhone: "call me" }],
    ["a date that is not a date", { dateOfBirth: "02/03/1968" }],
    ["a day that does not exist", { lastDayOfWork: "2025-02-30" }],
    ["a negative amount", { amount: -1 }],
    ["an amount that is not finite", { amount: Number.POSITIVE_INFINITY }],
  ];

  for (const [what, patch] of REFUSED) {
    it(`refuses ${what}, without calling the backend`, async () => {
      const backend = new FailingBackend("createProject");
      const { result } = await mount(adminState(), backend);

      const ok = await run(() => result.current.updateClientInfo("p_website", patch));

      expect(ok).toBe(false);
      expect(backend.attempted).toEqual([]);
      expect(
        result.current.state.projects.find((p) => p.id === "p_website")!.client
      ).toBeNull();
    });
  }

  it("CONTROL: the same fields with good values do reach the backend", async () => {
    // Without this every refusal above would pass against a store that
    // refused `updateClientInfo` outright.
    const backend = new FailingBackend("createProject");
    const { result } = await mount(adminState(), backend);

    const ok = await run(() =>
      result.current.updateClientInfo("p_website", {
        email: "dana@example.com",
        phone: "+61 412 345 678",
        dateOfBirth: "1968-03-02",
        amount: 12500,
      })
    );

    expect(ok).toBe(true);
    expect(backend.attempted).toEqual(["updateClientInfo"]);
  });

  it("accepts an emptied field, because clearing one is a real edit", async () => {
    // The rule is "if there is a value it must be plausible", not "there must
    // be a value". A validator that refused "" would make a mistyped email
    // impossible to take back out.
    const { result } = await mount(adminState());

    await run(() => result.current.updateClientInfo("p_website", { email: "dana@example.com" }));
    const ok = await run(() => result.current.updateClientInfo("p_website", { email: "" }));

    expect(ok).toBe(true);
    expect(
      result.current.state.projects.find((p) => p.id === "p_website")!.client!.email
    ).toBe("");
  });

  it("accepts a null amount and a null date, which mean 'not known'", async () => {
    const { result } = await mount(adminState());

    const ok = await run(() =>
      result.current.updateClientInfo("p_website", { amount: null, dateOfBirth: null })
    );

    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Refusals put it back
// ---------------------------------------------------------------------------

describe("a refused write leaves the old value on screen", () => {
  it("rolls a field back to what it was", async () => {
    // Asserted as "the old value is back", not "a toast fired". A store that
    // toasted and kept the new value would pass the second and fail the first,
    // and the second is the one a person actually experiences.
    const backend = new FailingBackend("updateClientInfo");
    const { result } = await mount(adminState(), backend);

    // Land one good value first — through the same failing op, so this uses a
    // separate mount rather than pretending the backend is selective.
    const good = await mount(adminState());
    await run(() => good.result.current.updateClientInfo("p_website", { fullName: "Dana Reed" }));
    good.unmount();

    const ok = await run(() =>
      result.current.updateClientInfo("p_website", { fullName: "Wrong Name" })
    );

    expect(ok).toBe(false);
    expect(
      result.current.state.projects.find((p) => p.id === "p_website")!.client
    ).toBeNull();
    expect(toastMock.error).toHaveBeenCalled();
  });

  it("rolls a document checkbox back", async () => {
    const backend = new FailingBackend("setClientDocument");
    const { result } = await mount(adminState(), backend);

    const ok = await run(() =>
      result.current.setClientDocument("p_website", "certified_id", true)
    );

    expect(ok).toBe(false);
    expect(
      result.current.state.projects.find((p) => p.id === "p_website")!.client
    ).toBeNull();
  });

  it("rolls `hasPassword` back when Vault refuses", async () => {
    // The most important rollback in the file. If this flag stuck on a refused
    // write, the page would say a password was stored when none was — and
    // somebody would delete their own copy of it on the strength of that.
    const backend = new FailingBackend("setClientPassword");
    const { result } = await mount(adminState(), backend);

    const ok = await run(() => result.current.setClientPassword("p_website", "hunter2"));

    expect(ok).toBe(false);
    const project = result.current.state.projects.find((p) => p.id === "p_website")!;
    expect(project.client?.hasPassword ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The password
// ---------------------------------------------------------------------------

describe("the password never enters the workspace state", () => {
  it("stores one and records only that there is one", async () => {
    // A backend that CAN store one. `LocalBackend` refuses outright (see the
    // demo test below), so mounting without this would assert the refusal
    // while appearing to assert the storing.
    const { result } = await mount(adminState(), new FailingBackend("createProject"));

    const ok = await run(() =>
      result.current.setClientPassword("p_website", "correct-horse-battery")
    );

    expect(ok).toBe(true);
    const client = result.current.state.projects.find((p) => p.id === "p_website")!.client!;
    expect(client.hasPassword).toBe(true);
    // The whole state, serialised. Nothing anywhere in the workspace — not on
    // the project, not in the feed, not in a field this test forgot to name —
    // may contain the value. This is the assertion that would catch somebody
    // later "helpfully" caching it for the Reveal button.
    expect(JSON.stringify(result.current.state)).not.toContain("correct-horse-battery");
  });

  it("keeps it out of localStorage as well", async () => {
    // The demo backend snapshots the whole AppState to localStorage after
    // every change, so "not in state" and "not on disk" are the same claim
    // here — but they would stop being the same the moment anything cached it
    // separately, and this is where that would show up.
    const { result } = await mount(adminState(), new FailingBackend("createProject"));

    await run(() => result.current.setClientPassword("p_website", "correct-horse-battery"));

    expect(JSON.stringify(localStorage)).not.toContain("correct-horse-battery");
  });

  it("hands the value to the caller and to nobody else", async () => {
    const { result } = await mount(adminState(), new FailingBackend("createProject"));

    const value = await run(() => result.current.revealClientPassword("p_website"));

    // FailingBackend's reveal resolves "the-secret" for any op it is not
    // failing, so this is the value coming back through the seam.
    expect(value).toBe("the-secret");
    expect(JSON.stringify(result.current.state)).not.toContain("the-secret");
  });

  it("clearing takes the flag off", async () => {
    const { result } = await mount(adminState(), new FailingBackend("createProject"));

    await run(() => result.current.setClientPassword("p_website", "hunter2"));
    const ok = await run(() => result.current.setClientPassword("p_website", null));

    expect(ok).toBe(true);
    expect(
      result.current.state.projects.find((p) => p.id === "p_website")!.client!.hasPassword
    ).toBe(false);
  });

  it("REFUSES to store one on the demo backend, rather than pretending", async () => {
    // `LocalBackend` keeps the whole workspace as one JSON blob in
    // localStorage, so there is nowhere to put a client credential that is not
    // readable by anything running on the page. Resolving would leave
    // `hasPassword` true for a password stored nowhere, and the Reveal button
    // would then be a promise the demo cannot keep.
    //
    // `mount` with no backend argument IS the demo path.
    const { result } = await mount(adminState());

    const ok = await run(() => result.current.setClientPassword("p_website", "hunter2"));

    expect(ok).toBe(false);
    const project = result.current.state.projects.find((p) => p.id === "p_website")!;
    expect(project.client?.hasPassword ?? false).toBe(false);
  });

  it("resolves null and toasts when the server refuses a reveal", async () => {
    const { result } = await mount(adminState(), new FailingBackend("revealClientPassword"));

    const value = await run(() => result.current.revealClientPassword("p_website"));

    expect(value).toBeNull();
    expect(toastMock.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

describe("what reaches the activity feed", () => {
  it("says nothing for an ordinary field edit", async () => {
    // Autosave fires on every blur. A line per field would make the feed
    // unreadable within one phone call, and `updated_at`/`updated_by` on the
    // row is the audit trail that matters.
    const { result } = await mount(adminState());
    const before = result.current.state.activities.length;

    await run(() => result.current.updateClientInfo("p_website", { fullName: "Dana Reed" }));
    await run(() => result.current.updateClientInfo("p_website", { memberId: "AS-1" }));
    await run(() => result.current.setClientDocument("p_website", "certified_id", true));

    expect(result.current.state.activities).toHaveLength(before);
  });

  it("says so when the contract is signed", async () => {
    const { result } = await mount(adminState());

    await run(() => result.current.updateClientInfo("p_website", { contractSigned: true }));

    const latest = result.current.state.activities.at(-1)!;
    expect(latest.text).toContain("contract signed");
    // Scoped, so it reaches only people who can see this project —
    // 20260909000900 exists because an unscoped line named a restricted
    // project to everybody.
    expect(latest.projectId).toBe("p_website");
  });

  it("says nothing when the contract is re-saved at the same value", async () => {
    const { result } = await mount(adminState());
    await run(() => result.current.updateClientInfo("p_website", { contractSigned: true }));
    const after = result.current.state.activities.length;

    await run(() => result.current.updateClientInfo("p_website", { contractSigned: true }));

    expect(result.current.state.activities).toHaveLength(after);
  });

  it("never writes the password's own feed line from the browser", async () => {
    // The "set" and "revealed" lines are written by the database, inside the
    // same transaction as the write they describe. A client-side line would be
    // a claim about a request rather than a record of one — and could be
    // skipped by anybody calling the RPC directly, which is the whole point of
    // logging it at all.
    const { result } = await mount(adminState(), new FailingBackend("createProject"));
    const before = result.current.state.activities.length;

    await run(() => result.current.setClientPassword("p_website", "hunter2"));
    await run(() => result.current.revealClientPassword("p_website"));

    expect(result.current.state.activities).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

describe("adding a note", () => {
  it("appends an entry carrying the caller as author and a time", async () => {
    const { result } = await mount(asUser(baseState(), "u_vlad"));
    const before = Date.now();
    expect(await run(() => result.current.addClientNote("p_website", "Called, left a message."))).toBe(true);
    const notes = result.current.state.projects.find((p) => p.id === "p_website")!.client!.notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("Called, left a message.");
    expect(notes[0].createdBy).toBe("u_vlad");
    expect(notes[0].createdAt).toBeGreaterThanOrEqual(before);
  });

  it("refuses a blank note before any network call", async () => {
    const backend = new FailingBackend("addClientNote");
    const { result } = await mount(asUser(baseState(), "u_vlad"), backend);
    expect(await run(() => result.current.addClientNote("p_website", "   "))).toBe(false);
    expect(backend.attempted).toEqual([]);
  });

  it("CONTROL: a real note does reach the backend", async () => {
    const backend = new FailingBackend("addClientNote");
    const { result } = await mount(asUser(baseState(), "u_vlad"), backend);
    await run(() => result.current.addClientNote("p_website", "Real"));
    expect(backend.attempted).toContain("addClientNote");
  });

  it("rolls the entry back when the backend refuses", async () => {
    const { result } = await mount(asUser(baseState(), "u_vlad"), new FailingBackend("addClientNote"));
    expect(await run(() => result.current.addClientNote("p_website", "Lost?"))).toBe(false);
    expect(result.current.state.projects.find((p) => p.id === "p_website")!.client?.notes ?? []).toEqual([]);
  });

  it("refuses a viewer", async () => {
    // Same fixture the other viewer refusals in this file use: a restricted
    // project where u_maya is listed as a viewer, and a FailingBackend so
    // the refusal can be shown to happen BEFORE any network call, not just
    // to have returned false.
    const backend = new FailingBackend("addClientNote");
    const { result } = await mount(withViewerProject("u_maya"), backend);
    expect(await run(() => result.current.addClientNote("p_locked", "Nope"))).toBe(false);
    expect(backend.attempted).toEqual([]);
  });

  it("keeps one project's notes off another", async () => {
    const { result } = await mount(asUser(baseState(), "u_vlad"));
    await run(() => result.current.addClientNote("p_website", "Only here"));
    expect(result.current.state.projects.find((p) => p.id === "p_mobile")!.client).toBeNull();
  });
});
