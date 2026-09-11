// @vitest-environment jsdom
//
// Changing your own password.
//
// WHY THIS EXISTS AT ALL. Accounts are created by an admin who picks the first
// password. Until this dialog, that password was permanent — and the Members
// screen said "they can change it once they're in" while the app offered
// nothing that could. The copy was written a day before the capability, which
// is the same fault as the false "Saved" and the dead Download anchors: a
// component asserting something it does not know.
//
// So the assertions here are about the two halves of the promise. That the
// password actually reaches Supabase, and that nothing claims success when it
// did not.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

const { authMock, uiMock } = vi.hoisted(() => ({
  authMock: { changePassword: vi.fn() },
  uiMock: { passwordDialogOpen: true, setPasswordDialogOpen: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => authMock }));
vi.mock("@/components/ui-context", () => ({ useUI: () => uiMock }));

import { ChangePasswordDialog } from "@/components/auth/change-password-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  uiMock.passwordDialogOpen = true;
});

/** The dialog, mounted open. */
function mount() {
  render(React.createElement(ChangePasswordDialog));
}

/** Fill both fields and press the button. */
async function submit(next: string, again = next) {
  mount();
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("Type it again"), { target: { value: again } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
}

describe("what reaches the backend", () => {
  it("sends the new password and closes on success", async () => {
    authMock.changePassword.mockResolvedValue(null);

    await submit("brand-new-password");

    await waitFor(() =>
      expect(authMock.changePassword).toHaveBeenCalledWith("brand-new-password")
    );
    expect(uiMock.setPasswordDialogOpen).toHaveBeenCalledWith(false);
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("refuses a mismatch without calling the backend at all", async () => {
    // The round trip is the expensive part and the failure is local, so it
    // should never be spent. Asserting the call count, not the message, is
    // what makes that a real claim.
    await submit("brand-new-password", "brand-new-passwerd");

    expect(authMock.changePassword).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalled();
    expect(uiMock.setPasswordDialogOpen).not.toHaveBeenCalledWith(false);
  });

  it("refuses anything under eight characters, before the round trip", async () => {
    await submit("short");

    expect(authMock.changePassword).not.toHaveBeenCalled();
    expect(uiMock.setPasswordDialogOpen).not.toHaveBeenCalledWith(false);
  });
});

describe("what the person is told when it fails", () => {
  it("shows the server's own sentence and stays open", async () => {
    // "New password should be different from the old password",
    // "reauthentication needed" — those are the ones you can act on. A dialog
    // that flattened them to "something went wrong" would be throwing away the
    // only useful part, and a dialog that closed would be claiming success.
    authMock.changePassword.mockResolvedValue(
      "New password should be different from the old password."
    );

    await submit("brand-new-password");

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't change your password",
      expect.objectContaining({
        description: "New password should be different from the old password.",
      })
    );
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(uiMock.setPasswordDialogOpen).not.toHaveBeenCalledWith(false);
  });

  it("does not send twice when the button is double-clicked", async () => {
    // A state-only guard passes an obvious test and still lets a real
    // double-click through, because two clicks in the same tick see the same
    // state. `useSubmitOnce` holds a ref for that reason.
    let release: (value: string | null) => void = () => {};
    authMock.changePassword.mockReturnValue(
      new Promise<string | null>((resolve) => {
        release = resolve;
      })
    );

    mount();
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "brand-new-password" },
    });
    fireEvent.change(screen.getByLabelText("Type it again"), {
      target: { value: "brand-new-password" },
    });
    const button = screen.getByRole("button", { name: "Change password" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(authMock.changePassword).toHaveBeenCalled());
    expect(authMock.changePassword).toHaveBeenCalledTimes(1);
    release(null);
  });
});
