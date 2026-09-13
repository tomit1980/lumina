# Brief for an independent QA agent

You are testing **Lumina**, an internal collaboration tool — chat, a kanban board, projects and
tasks, file attachments — used by a small firm for repeatable client casework.

The first audit (2026-09-11) reached only the sign-in screen, because accounts are created by an
administrator and it correctly refused to invent any. That was the right call. This brief exists to
unblock the rest.

## Credentials

> _Fill these in before sending. Do not commit them._

| | Email | Password | Role |
|---|---|---|---|
| Account A | `____` | `____` | Member |
| Account B | `____` | `____` | Guest |

- URL: **https://tomit1980.github.io/lumina/**
- **Both accounts will be held at a "choose your own password" screen on first sign-in.** That is
  deliberate — the password above was chosen by an admin and is treated as compromised by design.
  Replacing it is the first thing to test, not an obstacle.
- Neither account can reach Settings → Roles, Board columns or Task sets, and neither can delete a
  project or a channel. That is the intended permission boundary, not a bug to file.

## Fixtures seeded for you

| Name | What it is | What should be true |
|---|---|---|
| `#qa-open` | Public channel | Both accounts can read and post |
| `#qa-private` | Private channel, **neither account is a member** | **Invisible** — not in the sidebar, not in ⌘K, and a direct link shows a "restricted" page rather than content |
| `QA Restricted Project` | Project with access restricted, **neither account is a member** | Same: invisible everywhere, not merely refused on write |
| `QA Open Project` | Ordinary project | Both can see it; Member can create and move tasks, Guest cannot |

**"Invisible, not merely refused" is the claim worth attacking.** A resource that appears in a list
and then rejects you has already leaked its existence.

## What to test

Everything in your own QA map. In priority order, the items that matter most here:

1. **Sign in, replace the forced password, sign out, sign back in with the new one.** Confirm the
   old password no longer works.
2. **Persistence.** Post a message, create a task, move it across the board, hard-refresh, and
   confirm all three survived. Then confirm they survived in the *other* account's session too.
3. **Isolation.** From both accounts: `#qa-private` and `QA Restricted Project` must be absent from
   the sidebar, the command palette and search. Try direct URLs. Try the REST API directly with the
   publishable key from the page bundle if you want to — that is a fair test and the answer should
   be the same.
4. **Two sessions at once.** Sign in as A and B in separate browser contexts (not two tabs of one).
   A posts; B should see it without reloading. A moves a task; B's board should follow.
5. **Rejected writes.** Guest attempting to create a task, or either account attempting to write to
   the restricted project, should refuse *and leave no trace* — no optimistic card that lingers, no
   half-applied change after a refresh.
6. **Responsive, dark mode, keyboard, console** — now across authenticated screens, which the first
   run could not reach.

## Hygiene

- **Do not use `@handles` in message bodies that match real people.** Mentions are resolved by
  handle at render time; a test message mentioning a real handle will highlight for them.
- Prefix everything you create with `QA` so cleanup is unambiguous.
- Do not change your display name to impersonate anyone.
- If you find something destructive, **stop and report it rather than proving it twice.**

## Known and deliberate — please do not re-file

- **Controls are 28 CSS px tall.** WCAG 2.2 SC 2.5.8 (level AA) requires 24×24; this passes. The
  44 px figure is level AAA and mobile-platform guidance. Lumina is a desktop-first internal tool.
- **"Incorrect email or password" is deliberately generic.** Distinguishing the two would tell an
  attacker which addresses have accounts. A *blank* password is refused locally with a specific
  message, which leaks nothing.
- **The demo accounts and printed password on the sign-in screen do not exist on production.** If
  you see them, that is a real finding — it means the build is pointed at the wrong backend.

## Already fixed from your first report

- **LUM-QA-001** — the sign-in error is now `role="alert"` with the fields carrying `aria-invalid`
  and `aria-describedby`, and focus moves to the field the refusal is about. Please re-check.
- **Blank password** now refused before the request, with "Enter your password."

## Cleanup, afterwards

The administrator will delete both accounts, `#qa-open`, `#qa-private`, `QA Restricted Project` and
`QA Open Project`. Please list anything else you created so nothing is missed.
