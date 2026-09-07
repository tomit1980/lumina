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

### L1-007 — Medium — `moveTask` never closes the gap it leaves in the source column
- **Assertion that failed:** moving a task out of one status column into another should
  leave the *source* column's remaining tasks as a dense `0..n-1` sequence — the same
  guarantee the destination column gets.
- **Expected:** after removing the middle task from a 3-task column (orders `[0,1,2]`),
  the two remaining tasks renumber to `[0,1]`.
- **Actual:** they stay `[0,2]`. `moveTask`'s `reordered` map is built only from
  `s.tasks.filter(t => t.status === toStatus && t.id !== taskId)` — i.e. only the
  *destination* status — so source-column siblings are never included in the map and
  keep their stale `order` values. The destination column *does* get a correct dense
  renumbering (that half of the assumption holds); only the source side leaks gaps.
  Harmless for simple sort-by-order rendering, but it means `order` values silently
  drift away from a dense invariant over the life of a board, which will bite anything
  that assumes contiguity (e.g. a future "insert at position N" computed from column
  length) or that reads `order` as a stable per-column rank.
- **File:** `lib/store.tsx`, `moveTask`, ~lines 977–1011 (the `column`/`reordered`
  computation only ever touches `toStatus`-matching tasks).
- **Test:** `tests/qa/task-ordering.test.ts` → `it.fails("L1-007: ...")`.

### L1-008 — Medium — `migrate()` has no fallback for missing `activities`/`lastRead`, unlike every sibling field
- **Assertion that failed:** a structurally incomplete `lumina:v1` blob — missing a
  whole top-level key — should either fail to migrate (falling back to a fresh seed,
  like a blob missing `users`/`channels`/`projects`/`tasks` does) or at least backfill
  to an empty value, the same way `parsed.dms ?? []`, `parsed.roles ?? DEFAULT_ROLES...`,
  and every per-item `attachments ?? []` do.
- **Expected:** a blob missing only `activities` (everything else intact) results in
  `state.activities` being an array; a blob missing only `lastRead` results in
  `state.lastRead` being an object.
- **Actual:** `migrate()` does `activities: parsed.activities` and
  `lastRead: parsed.lastRead` with **no `??` fallback at all** — the only two
  top-level fields in the whole function without one. Because neither is ever
  `.map()`'d or otherwise touched inside `migrate()`, a missing key doesn't throw, so
  the surrounding `try/catch` never fires and the hydration effect happily accepts
  `next = migrate(parsed)` with `state.activities === undefined` /
  `state.lastRead === undefined`. This isn't just a shape inconsistency: `activity()`
  does `[...state.activities, entry]` (throws on `undefined`) and `getUnreadCount`
  does `state.lastRead[\`${userId}:${conversationId}\`]` with no optional chaining
  (also throws on `undefined`) — so the very first message sent, or the first unread
  count read, after such a "successful" migration crashes the app.
- **File:** `lib/store.tsx`, `migrate()`, ~lines 340–342 (`activities: parsed.activities,`
  and `lastRead: parsed.lastRead,`).
- **Test:** `tests/qa/migration.test.ts` → both `it.fails("L1-008: ...")` cases.

### L1-010 — Low — `createTask`'s return value reports a stale `order: 0`, regardless of the real column size
- **Assertion that failed:** the `Task` object `createTask` returns to its caller
  should carry the same `order` that ends up persisted in state.
- **Expected:** appending a 4th task to a 3-task column returns a `Task` with
  `order: 3`.
- **Actual:** it always returns `order: 0`. `createTask` builds the `task` object it
  hands back to the caller *before* calling `update()`, hardcoding `order: 0`; the
  *correct* `order` (the column's current size) is computed only inside the `update()`
  callback, on a separate copy (`{ ...task, order: columnSize, createdBy: ... }`) that
  gets written to state but is never what's returned. `result.current.state.tasks`
  ends up with the right value — only the direct return value lies.
- **File:** `lib/store.tsx`, `createTask`, ~lines 923–952 (the `task` object built at
  ~931 vs. the corrected copy spread at ~946, inside `update()`).
- **Test:** `tests/qa/task-ordering.test.ts` → `it.fails("L1-010: ...")`.

## By design, but surprising (additions from A4–A9)

- **An unrecognized-version `lumina:v1` blob (newer than `SEED_VERSION`) is silently
  discarded and replaced with a fresh demo seed** — no toast, no warning, and the very
  next persistence-effect tick immediately overwrites the original data in
  `localStorage` with the reseeded copy, so there's no way back. The same is true for
  corrupt JSON and for `version < 1`. Reasonable as a *shouldn't happen in practice*
  safety net (there is no real forward-compat story for a future schema), but the
  complete silence around a real data-loss event is worth a product decision, not just
  an engineering one. Confirmed in `tests/qa/migration.test.ts` → the "falls back to a
  fresh seed" describe block. Not logged as a numbered finding since fixing it requires
  deciding what *should* happen, not just correcting a check.
- **The chat tokenizer (`components/chat/rich-text.tsx`) has no nesting support at
  all**, by virtue of being a single alternation regex tried once over the raw string.
  `**bold *italic* still bold**` does not render as nested bold+italic; it misparses
  into stray literal asterisks, two `<em>` fragments for "bold " and " still bold", and
  the word "italic" itself falling through as plain unstyled text. Not a security or
  data-integrity issue, just worth knowing before anyone assumes Markdown-like nesting
  works. Confirmed in `tests/qa/pure-helpers.test.ts` → "'**bold *italic* still bold**'
  misrenders instead of nesting".

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
- A4 (`messages.test.ts`): 19 tests — sendMessage/sendToUser content and gating rules,
  editMessage/deleteMessage authorship rules, toggleReaction's visibility-only gate,
  DM bypass of `message.send`, and per-user markChannelRead/getUnreadCount. No new
  defects; reconfirmed the "by design, but surprising" behaviors from A2 at the
  message-rule level.
- A5 (`task-ordering.test.ts`): 11 tests — createTask append position, moveTask's
  within-column and cross-column renumbering, index clamping, and stability under
  repeated moves. Surfaced L1-007 and L1-010.
- A6 (`migration.test.ts`): 20 tests — every `SEED_VERSION` from 1 to 10 migrating to a
  coherent current-shape state (legacy `role`→`roleId`, `memberIds`→`members`,
  `rolePermissions` map, `"urgent"`→`"high"`, `dms` defaulting), plus the failure paths
  (corrupt JSON, version 0, version newer than `SEED_VERSION`, missing top-level keys)
  and the `lumina:auth` desync case. Surfaced L1-008.
- A7 (`attachments.test.ts`): 19 tests — the 3 MB cap (inclusive boundary), batch-upload
  skip behavior, `resolveMessageAttachment`'s live-lookup/deletion semantics,
  `formatBytes` boundaries, and the `lib/documents.ts` data-URL round-trip (byte-length
  accounting with padding, multi-byte UTF-8, and the 0x8000 chunk boundary). No new
  defects.
- A8 (`auth-crypto.test.ts`): 26 tests — password hashing round-trip and per-account
  salting, `base32Encode` against RFC 4648 test vectors, TOTP generation/verification
  and its ±1-step drift window (accepting adjacent steps, rejecting two steps away),
  malformed-code rejection, and `encryptJSON`/`decryptJSON` round-trip plus tamper
  detection on both ciphertext and IV. No new defects — the crypto layer's own
  documented boundary (client-side secrecy) held up exactly as described in the
  module's own comments.
- A9 (`pure-helpers.test.ts`): 16 tests — `lib/calendar.ts`'s RFC 5545 text escaping
  and well-formed VEVENT/VALARM structure (including the all-day-vs-timed VALARM
  rule), and the chat tokenizer's basic tokens, unmatched/adjacent markers, and its
  no-nesting behavior. No new defects; the nesting behavior is logged under "by
  design, but surprising" above.
