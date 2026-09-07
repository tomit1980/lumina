# Layer-1 QA findings — RBAC / resource-access / invariants

Produced by `tests/qa/rbac-matrix.test.ts` (A1), `tests/qa/resource-access.test.ts` (A2),
and `tests/qa/invariants.test.ts` (A3). Enforcement lives at the action layer in
`lib/store.tsx` (`guard()` at ~line 400 plus per-action checks); tests drive that API
directly rather than through UI components.

Genuine defects are encoded in the test suite as `it.fails(...)` with the assertion
that *should* hold — they'll flip to real failures (and need converting to `it(...)`)
the moment someone fixes the underlying code.

## Defects

### L1-004 — High — `updateProject` only enforces project-viewer status for attachment patches
- **Assertion that failed:** a project *viewer* (a custom role holding `project.create`
  but not `members.manage`) should not be able to rename/recolor/reprioritize a
  restricted project they only have view access to.
- **Expected:** `updateProject(id, { name: "..." })` denied, project unchanged, same as
  the attachments case.
- **Actual:** the rename succeeds. `projectIsViewerOnly` is only checked
  `if (patch.attachments)` — any other field (`name`, `description`, `emoji`, `color`,
  `priority`) skips the viewer gate entirely.
- **File:** `lib/store.tsx`, `updateProject`, ~lines 843–851 (the `if (patch.attachments)`
  block that's the only place `projectIsViewerOnly` is consulted).
- **Test:** `tests/qa/resource-access.test.ts` → `it.fails("L1-004: ...")`.

### L1-005 — Critical — `setProjectAccess` has no viewer-only check *or* membership check at all
- **Assertion that failed:** a caller with no relationship whatsoever to a restricted
  project (not a member, not the creator) should not be able to rewrite that project's
  access list.
- **Expected:** `setProjectAccess` denied for a custom role holding only
  `project.create` when called against a project it isn't a member of.
- **Actual:** it succeeds unconditionally as long as `guard("project.create")` passes —
  there is no check that the caller is a member, editor, or creator of *this specific*
  project. A `project.create`-only role can grant itself `editor` (or strip everyone
  else's access) on any restricted project workspace-wide, id fished from anywhere the
  UI happens to expose it.
- **File:** `lib/store.tsx`, `setProjectAccess`, ~lines 899–915 — the only gate is
  `if (!guard("project.create")) return false;`, contrast with `setChannelAccess`'s
  `channelIsManageable()` (requires `channel.delete` **or** being the creator).
- **Test:** `tests/qa/resource-access.test.ts` → `it.fails("L1-005: ...")`.
- **Note:** both L1-004 and L1-005 stem from the same root cause — there is no
  `project.update`/`project.access` permission in the schema (`ALL_PERMISSIONS` in
  `lib/permissions.ts`); project editing and access management were both wired to
  reuse `project.create`, and that reuse is missing the same-resource ownership check
  that channels get from `channelIsManageable`. Fixing L1-005 properly likely also
  fixes L1-004 for free (add an object-level check: creator, an existing editor
  member, or `members.manage`).

### L1-006 — Medium/High — a channel named "general" becomes an undeletable pseudo-team channel after any reload
- **Assertion that failed:** a plain, ordinarily-created channel named `"general"`
  (e.g. a duplicate someone creates by mistake, `isTeam` unset in memory) should
  remain a normal, deletable channel after the page reloads.
- **Expected:** `canDeleteChannel` stays `true` and `deleteChannel` succeeds after a
  reload.
- **Actual:** on the next load, `migrate()`'s legacy-data backfill —
  `isTeam: c.isTeam ?? (c.name === "general" ? true : undefined)` — fires and
  permanently flags the channel `isTeam: true`, because `migrate()` runs
  unconditionally on *every* load (the version gate in `StoreProvider`'s hydration
  effect accepts `parsed.version === SEED_VERSION`, not just genuinely older data).
  There is no rename action in the store, so the channel is stuck undeletable.
- **File:** `lib/store.tsx`, `migrate()` ~line 297 (the backfill expression) and the
  hydration effect ~lines 344–360 (the version check that lets `migrate()` run on
  current-version data too).
- **Test:** `tests/qa/invariants.test.ts` → `it.fails("L1-006: ...")`.

## By design, but surprising

These are not bugs — the assertions pass as written — but the behavior is worth
flagging because it isn't what the permission names would suggest.

- **`editMessage` checks authorship only, never `message.send`.** A user whose role
  has zero permissions can still edit their own message once it exists (`lib/store.tsx`
  `editMessage`, ~line 668). Confirmed in
  `tests/qa/resource-access.test.ts` → "editMessage checks authorship only...".
- **`toggleReaction` is gated only by conversation visibility (`canSeeConversation`),
  not by any permission.** Any user who can see a channel/DM can react in it, even
  with a permission-less role (`lib/store.tsx` `toggleReaction`, ~line 699). Confirmed
  in the same file → "toggleReaction is gated only by conversation visibility...".
- **DMs bypass `message.send` entirely.** `sendMessage`/`sendToUser` only call
  `guard("message.send")` on the *channel* branch; the DM branch just checks the
  caller is one of the two participants (`lib/store.tsx` `sendMessage`, ~lines
  606–623). Confirmed → "sendMessage to a DM bypasses the message.send guard
  entirely".
- **`updateProject` and `setProjectAccess` are both gated by `project.create`,
  not a dedicated permission.** There is no `project.update` permission in
  `ALL_PERMISSIONS` (`lib/permissions.ts`); the code comment above `updateProject`
  says this is intentional ("Editing a project is part of the 'manage projects'
  capability"). Reasonable in isolation, but it's the same reuse that makes L1-004/
  L1-005 possible once a role has `project.create` without `members.manage`.
- **`setChannelAccess` and `deleteChannel` let the *creator* bypass the permission
  check** (`channelIsManageable` = `channel.delete` **or** `createdBy === currentUserId`),
  while the equivalent project actions have no such creator carve-out — a project's
  own creator who lacks `project.create` cannot manage or even rename their own
  project. Asymmetric, not tested as a defect since no seeded role hits it, but worth
  a design pass.
- **The `migrate()` name-based `isTeam` backfill** (`c.name === "general" ? true :
  undefined`) is explicitly commented as a legacy-data backfill, but nothing scopes it
  to actual legacy payloads — see L1-006 above for why this crosses from "surprising"
  into "bug".
- **Denial-message wording for `sendMessage` on a private channel doesn't distinguish
  a total non-member from an invited viewer** — both get "You have view-only access to
  this channel," even though a non-member can't `canSeeChannel` at all. Not a security
  issue (the write is correctly blocked either way), just an imprecise message. Not
  logged as a numbered finding.

## Suite summary

- A1 (`rbac-matrix.test.ts`): 51 tests — admin/member/guest × 17 guarded actions.
  All matched the DEFAULT_ROLES permission table exactly; no discrepancies found at
  the pure-permission layer.
- A2 (`resource-access.test.ts`): 19 tests — private channels, restricted projects,
  `ensureEditor`, the `members.manage` bypass, and the message-level "by design"
  behaviors above. Surfaced L1-004 and L1-005.
- A3 (`invariants.test.ts`): 15 tests — self-role-change, last-admin protection,
  locked/system/has-members role deletion rules, case-insensitive name clashes, the
  team channel, and the `#general` migration backfill. Surfaced L1-006.
