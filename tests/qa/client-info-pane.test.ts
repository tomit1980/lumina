// @vitest-environment jsdom
//
// The project tab row and the Client Info pane, rendered.
//
// WHY A RENDERING TEST AND NOT ONLY STORE TESTS. The Change password work
// shipped a store action, a dialog and five passing tests around a menu item
// that did not exist, because two edits in one script silently did not run. A
// control nobody renders is a control nobody can prove is there — and this
// feature's entire surface is one tab that has to appear on every project.
//
// It also pins the two things a store test structurally cannot reach: the tab
// ORDER, and that a viewer gets the page without its inputs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(), replace: vi.fn(), back: vi.fn(),
    forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams("id=p_website"),
  usePathname: () => "/projects",
}));

import { addProject, asUser, baseState, installMenuShims, renderHydrated } from "./_support";
import ProjectPage from "@/app/projects/page";
import { AuthProvider } from "@/lib/auth";
import { StoreProvider } from "@/lib/store";
import { UIProvider } from "@/components/ui-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CLIENT_DOCUMENT_TYPES } from "@/lib/client-info";
import * as React from "react";
import type { AppState } from "@/lib/types";

const h = React.createElement;

installMenuShims();

/**
 * Switches to a tab the way Radix actually listens for it.
 *
 * `fireEvent.click` alone does NOT work: `TabsTrigger` activates on
 * `mousedown` (plus focus, in automatic mode), so a click event by itself
 * leaves the tab exactly where it was — and every assertion about the pane
 * then fails for a reason that has nothing to do with the pane. Same shape as
 * the `pointerdown` polyfill the Select and DropdownMenu suites need.
 */
async function selectTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  await act(async () => {
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  });
}

/** The date of birth on whichever project holds a client record, read straight
 *  out of the persisted workspace — so a test asserts what was STORED rather
 *  than what the box happens to be displaying. */
function storedDateOfBirth(): string | null {
  const stored = JSON.parse(localStorage.getItem("lumina:v1") ?? "{}") as {
    projects?: { client?: { dateOfBirth?: string | null } | null }[];
  };
  for (const project of stored.projects ?? []) {
    const dob = project.client?.dateOfBirth;
    if (dob) return dob;
  }
  return null;
}

/** Same, for the last day of work. */
function storedLastDayOfWork(): string | null {
  const stored = JSON.parse(localStorage.getItem("lumina:v1") ?? "{}") as {
    projects?: { client?: { lastDayOfWork?: string | null } | null }[];
  };
  for (const project of stored.projects ?? []) {
    const value = project.client?.lastDayOfWork;
    if (value) return value;
  }
  return null;
}

async function renderProject(state: AppState) {
  localStorage.setItem("lumina:v1", JSON.stringify(state));
  return renderHydrated(
    h(
      TooltipProvider,
      null,
      h(
        AuthProvider,
        null,
        h(StoreProvider, null, h(UIProvider, null, h(ProjectPage, null)))
      )
    )
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("the tab row", () => {
  it("reads Board, List, Client Info, Files — in that order", async () => {
    // The order is the requirement, so it is asserted as a sequence rather
    // than as four separate "is present" checks, which would pass with Client
    // Info tacked on the end.
    await renderProject(asUser(baseState(), "u_vlad"));

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent?.trim());

    expect(tabs).toEqual(["Board", "List", "Client Info", "Files"]);
  });

  it("is the same row for a member with no project permissions", async () => {
    // The tab is not gated on `project.create`. u_maya is a Member; if the
    // trigger ever picks up the permission the rest of the header uses, this
    // is where it shows.
    await renderProject(asUser(baseState(), "u_maya"));

    expect(screen.getAllByRole("tab").map((t) => t.textContent?.trim())).toEqual([
      "Board", "List", "Client Info", "Files",
    ]);
  });

  it("is the same row on a project with no client record yet", async () => {
    // Which is every project that existed before this shipped. `client` is
    // null in the seed, so this is that case — nothing is backfilled and the
    // tab appears regardless.
    const state = asUser(baseState(), "u_vlad");
    expect(state.projects.find((p) => p.id === "p_website")!.client).toBeNull();
    await renderProject(state);

    expect(screen.getByRole("tab", { name: "Client Info" })).toBeInTheDocument();
  });

  it("honours a saved preference: List hidden, Client Info first", async () => {
    localStorage.setItem(
      "lumina:project-tabs",
      JSON.stringify({ order: ["client", "board", "files", "list"], hidden: ["list"] })
    );
    await renderProject(asUser(baseState(), "u_vlad"));

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent?.trim());
    expect(tabs).toEqual(["Client Info", "Board", "Files"]);
    // The way to change it is on the row, and it is named.
    expect(screen.getByRole("button", { name: "Customise tabs" })).toBeInTheDocument();
  });
});

describe("the pane, for an editor", () => {
  async function openClientInfo(state: AppState) {
    await renderProject(state);
    await selectTab("Client Info");
  }

  it("shows every section", async () => {
    await openClientInfo(asUser(baseState(), "u_vlad"));

    for (const heading of [
      "Personal details",
      "Super / case details",
      "Required documents",
      "Contract",
      "Updated contact details",
      "Account access",
      "Notes",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
  });

  it("gives every field an editable input with a label", async () => {
    // By accessible name, because that is what a screen reader and a person
    // both navigate by — and a field with a placeholder and no label passes a
    // querySelector check while being unusable.
    await openClientInfo(asUser(baseState(), "u_vlad"));

    for (const label of [
      "Full name", "Date of birth", "Phone", "Email", "Address",
      "Super company", "Member ID", "Amount", "Diagnosis",
      "Last day of work", "Employer", "New phone", "New email", "New note",
    ]) {
      const field = screen.getByLabelText(label);
      expect(field).toBeInTheDocument();
      expect(field).toBeEnabled();
    }
  });

  it("shows the five documents and how many have arrived", async () => {
    await openClientInfo(asUser(baseState(), "u_vlad"));

    for (const doc of CLIENT_DOCUMENT_TYPES) {
      expect(screen.getByLabelText(doc.label)).toBeInTheDocument();
    }
    expect(screen.getByText("0 / 5 received")).toBeInTheDocument();
  });

  it("counts the ones already received", async () => {
    const state = addProject(asUser(baseState(), "u_vlad"), {
      id: "p_counted",
      name: "Counted",
      createdBy: "u_vlad",
    });
    // Rendered from a record that already has three ticked, rather than by
    // clicking three boxes — the count has to be right on arrival, which is
    // when somebody actually reads it.
    const withDocs: AppState = {
      ...state,
      projects: state.projects.map((p) =>
        p.id !== "p_website"
          ? p
          : {
              ...p,
              client: {
                fullName: "Dana Reed", dateOfBirth: null, phone: "", email: "",
                address: "", superCompany: "", memberId: "", amount: null,
                currency: "AUD", diagnosis: "", lastDayOfWork: null,
                employerName: "", contractSigned: false, newPhone: "",
                newEmail: "", notes: [],
                documents: {
                  photo_id_front: true,
                  photo_id_back: true,
                  bank_statement: true,
                  certified_id: false,
                },
                hasPassword: false, updatedAt: 1, updatedBy: "u_vlad",
              },
            }
      ),
    };
    await openClientInfo(withDocs);

    expect(screen.getByText("3 / 5 received")).toBeInTheDocument();
  });

  it("offers to store a password, and says a reveal is recorded", async () => {
    // The sentence is part of the design, not decoration: somebody about to
    // click Reveal is entitled to know it will be logged before they do it.
    await openClientInfo(asUser(baseState(), "u_vlad"));

    expect(screen.getByRole("button", { name: "Set password" })).toBeInTheDocument();
    expect(
      screen.getByText(/reveals this is recorded in the project's activity/i)
    ).toBeInTheDocument();
  });
});

describe("a refused save does not leave the rejected text in the box", () => {
  // FOUND BY RUNNING THE APP, not by reading it. `commit` rolls `AppState`
  // back on a refusal and a refusal BEFORE the round trip never patches state
  // at all - but the inputs here are uncontrolled, so their `defaultValue` was
  // read at mount and neither path touches what is on screen. The box went on
  // showing `not-an-email` beside a red "Couldn't save" while the record held
  // the old address: a field asserting something it does not know.
  async function openClientInfo() {
    await renderProject(asUser(baseState(), "u_vlad"));
    await selectTab("Client Info");
  }

  it("puts the old value back when the store refuses", async () => {
    await openClientInfo();
    const email = screen.getByLabelText("Email") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(email, { target: { value: "dana@example.com" } });
      fireEvent.blur(email);
    });
    await act(async () => {
      fireEvent.change(email, { target: { value: "not-an-email" } });
      fireEvent.blur(email);
    });

    expect(screen.getByText("Couldn't save")).toBeInTheDocument();
    expect(email.value).toBe("dana@example.com");
  });

  it("takes dates as DD/MM/YYYY, day-first, and refuses ones the calendar lacks", async () => {
    // TWO FIELDS, ONE RENDER. Each full-page render here costs seconds, and
    // this repo has already had a build fail because a suite of small render
    // tests starved the reporter. The combinations live in
    // ./client-info-dates.test.ts and run in milliseconds; this proves the box
    // is wired to them.
    //
    // `02/03/1968` is the string the whole change is about: the 2nd of March,
    // never the 3rd of February, on anybody's machine.
    await openClientInfo();
    const dob = screen.getByLabelText("Date of birth") as HTMLInputElement;
    const lastDay = screen.getByLabelText("Last day of work") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(dob, { target: { value: "02/03/1968" } });
      fireEvent.blur(dob);
    });
    expect(storedDateOfBirth()).toBe("1968-03-02");

    await act(async () => {
      fireEvent.change(lastDay, { target: { value: "31/02/1968" } });
      fireEvent.blur(lastDay);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Not merely "not the 31st of February" — nothing was written at all.
    expect(storedLastDayOfWork()).toBeNull();
    // And the text is left alone, so the correction is an edit rather than a
    // retype from memory.
    expect(lastDay.value).toBe("31/02/1968");
  });

  it("retires a refusal when the person edits the value it was about", async () => {
    // FOUND IN THE LIVE APP. A half-typed address was blurred, refused, and the
    // label stuck; the finished address was then typed into the same box and
    // "Couldn't save" was still sitting beside it. It read exactly like the
    // database rejecting a good address, and nothing had been sent.
    //
    // Same defect class as the box that kept the rejected text, one level up: a
    // field asserting something it does not know.
    await openClientInfo();
    const email = screen.getByLabelText("New email") as HTMLInputElement;
    const notes = screen.getByLabelText("New note") as HTMLTextAreaElement;
    const amount = screen.getByLabelText("Amount") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(email, { target: { value: "Rodneywayne@proton" } });
      fireEvent.blur(email);
    });

    // CONTROL: the refusal really happened and really is on screen. Without it
    // the disappearance below would pass against a pane that never showed it.
    expect(screen.getByText("Couldn't save")).toBeInTheDocument();

    // Typing in a DIFFERENT field must not clear it — each field owns its own
    // message, and a blanket reset would hide a refusal nobody had read yet.
    await act(async () => {
      fireEvent.input(notes, { target: { value: "Called, left a message." } });
    });
    expect(screen.getByText("Couldn't save")).toBeInTheDocument();

    await act(async () => {
      fireEvent.input(email, { target: { value: "Rodneywayne@proton.me" } });
    });
    expect(screen.queryByText("Couldn't save")).not.toBeInTheDocument();

    // The amount keeps its own inline message beside the save state, and it
    // retires on the same rule.
    await act(async () => {
      fireEvent.change(amount, { target: { value: "about a hundred grand" } });
      fireEvent.blur(amount);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await act(async () => {
      fireEvent.input(amount, { target: { value: "100000" } });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the box back to empty when the very first value is refused", async () => {
    // The path with no previous value at all, which is the one a person hits
    // first: there is no record yet, so "the old value" is "".
    await openClientInfo();
    const phone = screen.getByLabelText("Phone") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(phone, { target: { value: "call me" } });
      fireEvent.blur(phone);
    });

    expect(phone.value).toBe("");
  });

  it("does NOT overwrite a correction the person has already typed", async () => {
    // The guard that makes the restore safe. A refusal arrives a round trip
    // late; by then the box may hold a fix. Taking the keyboard off somebody
    // to undo something they had already corrected would be worse than the
    // bug this restores.
    await openClientInfo();
    const phone = screen.getByLabelText("Phone") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(phone, { target: { value: "call me" } });
      fireEvent.blur(phone);
      // Typed before the refusal settles.
      fireEvent.change(phone, { target: { value: "+61 412 345 678" } });
    });

    expect(phone.value).toBe("+61 412 345 678");
  });

  it("CONTROL: an accepted value stays in the box", async () => {
    // Without this, all three above would pass against a pane that blanked
    // every field on every blur.
    await openClientInfo();
    const name = screen.getByLabelText("Full name") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(name, { target: { value: "Dana Reed" } });
      fireEvent.blur(name);
    });

    expect(name.value).toBe("Dana Reed");
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
});

describe("the pane, for a viewer", () => {
  async function openAsViewer() {
    const state = addProject(asUser(baseState(), "u_maya"), {
      id: "p_website2",
      name: "Other",
      createdBy: "u_sam",
    });
    // p_website itself, made restricted with u_maya as a viewer — so this is
    // the same project the editor tests use, seen by someone who may only read.
    const restricted: AppState = {
      ...state,
      projects: state.projects.map((p) =>
        p.id !== "p_website"
          ? p
          : { ...p, restricted: true, members: [{ userId: "u_maya", level: "viewer" as const }] }
      ),
    };
    await renderProject(restricted);
    await selectTab("Client Info");
  }

  it("shows the record with no inputs at all", async () => {
    await openAsViewer();

    expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Notes")).not.toBeInTheDocument();
  });

  it("CONTROL: the sections themselves are still there", async () => {
    // Without this, the absence above would pass just as happily against a
    // pane that rendered nothing — the failure mode of a permission check
    // applied one level too high.
    await openAsViewer();

    expect(
      screen.getByRole("heading", { name: "Personal details" })
    ).toBeInTheDocument();
    expect(screen.getByText("0 / 5 received")).toBeInTheDocument();
  });

  it("disables the document checkboxes rather than hiding them", async () => {
    // A viewer needs to see WHICH documents are outstanding — that is most of
    // what this page is for. What they may not do is change one.
    await openAsViewer();

    for (const doc of CLIENT_DOCUMENT_TYPES) {
      expect(screen.getByLabelText(doc.label)).toBeDisabled();
    }
  });

  it("gives them no way to ask for the password", async () => {
    // Not a disabled Reveal button: a disabled one is an invitation to ask an
    // editor to click it for them.
    await openAsViewer();

    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /password/i })).not.toBeInTheDocument();
    expect(screen.getByText("No password stored.")).toBeInTheDocument();
  });
});

describe("notes as a log", () => {
  it("shows each entry with who wrote it and when, oldest first", async () => {
    const state = asUser(baseState(), "u_vlad");
    const withNotes: AppState = {
      ...state,
      projects: state.projects.map((p) => p.id !== "p_website" ? p : {
        ...p,
        client: {
          fullName: "", dateOfBirth: null, phone: "", email: "", address: "",
          superCompany: "", memberId: "", amount: null, currency: "AUD",
          diagnosis: "", lastDayOfWork: null, employerName: "", contractSigned: false,
          newPhone: "", newEmail: "", documents: {}, hasPassword: false,
          updatedAt: 0, updatedBy: null,
          notes: [
            { id: "n_2", body: "Bank statement received.", createdAt: Date.UTC(2026, 8, 16, 9, 10), createdBy: "u_maya" },
            { id: "n_1", body: "Called, left a message.", createdAt: Date.UTC(2026, 8, 15, 14, 32), createdBy: null },
          ],
        },
      }),
    };
    await renderProject(withNotes);
    await selectTab("Client Info");

    const entries = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(entries[0]).toContain("Called, left a message.");
    expect(entries[0]).toContain("Someone");           // unknown author is never a real colleague
    expect(entries[1]).toContain("Maya Chen");
    expect(entries[1]).toMatch(/16 Sep 2026/);
  });

  it("adds a note from the box and keeps the draft if the store refuses", async () => {
    await renderProject(asUser(baseState(), "u_vlad"));
    await selectTab("Client Info");
    const box = screen.getByLabelText("New note") as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(box, { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    });
    expect(screen.getByText("Couldn't save")).toBeInTheDocument();
    expect(box.value).toBe("   ");                     // not wiped

    await act(async () => {
      fireEvent.change(box, { target: { value: "Spoke to the fund." } });
      fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    });
    expect(screen.getByRole("listitem")).toHaveTextContent("Spoke to the fund.");
    expect(box.value).toBe("");
  });

  it("gives a viewer the entries and no box", async () => {
    // Same viewer fixture the existing "shows the record with no inputs at
    // all" test uses: p_website, restricted, u_maya as a viewer.
    const state = addProject(asUser(baseState(), "u_maya"), {
      id: "p_website2",
      name: "Other",
      createdBy: "u_sam",
    });
    const restricted: AppState = {
      ...state,
      projects: state.projects.map((p) =>
        p.id !== "p_website"
          ? p
          : { ...p, restricted: true, members: [{ userId: "u_maya", level: "viewer" as const }] }
      ),
    };
    await renderProject(restricted);
    await selectTab("Client Info");

    expect(screen.queryByLabelText("New note")).not.toBeInTheDocument();
  });
});
