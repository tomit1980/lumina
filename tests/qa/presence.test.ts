// @vitest-environment jsdom
//
// Suite — presence (Plan "realtime-and-presence", Task 4): the apply core's
// handling of `{ kind: "presence"; onlineUserIds: string[] }`.
//
// The decision this task encodes: online means a tab is open, full stop — no
// idle state, no "away". So a presence event is not additive ("these users
// are now online") — it is the WHOLE current set. Everyone in
// `onlineUserIds` is online; everyone else in `AppState.users` is offline,
// including someone who was online a moment ago and is not in this set
// anymore. That second half is the one a lazy implementation skips: it is
// easy to mark the named users online and never touch anyone else, which
// looks right until someone closes their tab and their dot never clears.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";

import { EventBackend, adminState, mount } from "./_support";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("presence events", () => {
  // Deliberately NOT the brief's own u_maya/u_sam pair: the seed already has
  // u_maya "online" and u_sam "offline" (lib/seed.ts), so asserting exactly
  // that pairing passes against a store that ignores presence events
  // entirely — proving nothing, the same trap Task 2's brief warns about.
  // u_sam is seeded OFFLINE and u_maya seeded ONLINE, so this can only pass
  // if the event both (a) actually landed and (b) cleared someone the event
  // did not name.
  it("marks users in the presence set online and everyone else offline", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);

    backend.emit({ kind: "presence", onlineUserIds: ["u_sam"] });

    await waitFor(() => {
      const sam = result.current.state.users.find((u) => u.id === "u_sam")!;
      const maya = result.current.state.users.find((u) => u.id === "u_maya")!;
      expect(sam.presence).toBe("online");
      expect(maya.presence).toBe("offline");
    });
  });

  it("clears a dot when someone leaves", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);

    backend.emit({ kind: "presence", onlineUserIds: ["u_maya"] });
    await waitFor(() => {
      const maya = result.current.state.users.find((u) => u.id === "u_maya")!;
      expect(maya.presence).toBe("online");
    });

    // A distinct, second event — not a re-emit of the first — so waiting for
    // ITS effect actually proves the apply path ran again rather than
    // re-observing the first event's already-landed result. The apply core
    // defers every event by a macrotask (see lib/store.tsx), so the two
    // deferrals run in order and the first has necessarily had its turn by
    // the time this one lands.
    backend.emit({ kind: "presence", onlineUserIds: [] });

    await waitFor(() => {
      const maya = result.current.state.users.find((u) => u.id === "u_maya")!;
      expect(maya.presence).toBe("offline");
    });
  });

  it("marks several users online at once, leaving the rest offline", async () => {
    const backend = new EventBackend();
    const { result } = await mount(adminState(), backend);

    backend.emit({ kind: "presence", onlineUserIds: ["u_maya", "u_jonas"] });

    await waitFor(() => {
      const byId = (id: string) =>
        result.current.state.users.find((u) => u.id === id)!.presence;
      expect(byId("u_maya")).toBe("online");
      expect(byId("u_jonas")).toBe("online");
      expect(byId("u_sam")).toBe("offline");
      expect(byId("u_priya")).toBe("offline");
    });
  });
});
