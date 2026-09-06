# ✨ Lumina

**Live demo:** https://tomit1980.github.io/lumina/ — sign in as `vlad` / `lumina24`. Everything is stored in your browser (localStorage), so the demo is per-browser, not shared.

**Where work flows.** A beautiful internal collaboration platform that blends Slack-style real-time chat with modern project management — wrapped in enterprise-grade role-based permissions.

Built as a delightful daily driver for small-to-medium teams: fast, obvious, premium.

## Features

### 🔑 Secure login & 2FA
- **Login screen** — PBKDF2-SHA256 hashed passwords (never plaintext), per-user salt. Demo accounts (`vlad`/`maya`/`elena`, password `lumina24`) are one click to fill.
- **Optional Google-Authenticator 2FA** — real RFC-6238 TOTP. Scan the QR (or copy the setup key) in any authenticator app; codes are verified with a ±1 step drift window.
- **Admins control 2FA per user** — on the People page each member has a 2FA menu: *Require* (the user is walked through enrollment at their next sign-in), *Reset* (force re-enrollment), or *Disable*. Users can also self-enroll from the account menu.
- **Encrypted at rest** — the credential store (hashes + TOTP secrets) is AES-GCM encrypted in localStorage.
- **Honest boundary**: with no backend, verification runs client-side, so this is correct-mechanism security, not server-grade. A real deployment moves verification behind an API — see the note in `lib/crypto.ts`.

### 💬 Chat
- **Team room** — a pinned, whole-team space (everyone belongs) surfaced as a top-level “Team” entry in the sidebar, with a Home quick-action and a ⌘K “Message the entire team” command. Every role can post; it can't be deleted.
- Public & **private channels** (guests and non-members can't see private ones)
- **Direct messages**: click any avatar or name to open a profile card and message that person, use the sidebar's DM section (with presence + unread badges), the "+" new-message picker, or ⌘K → Message. One thread per pair, visible only to its two participants
- Rich messages: `**bold**`, `*italic*`, `` `code` ``, and **@mentions** (your own mentions are highlighted)
- Emoji **reactions** with hover tooltips showing who reacted
- Edit & delete your own messages; admins can delete anyone's
- Smart message grouping, day dividers, **unread badges** in the sidebar
- Enter to send, Shift+Enter for newline, auto-growing composer

### 📋 Projects & Kanban
- Per-project boards with 5 columns: Backlog → To Do → In Progress → In Review → Done
- Buttery **drag & drop** (dnd-kit) in **both views**: reorder within a status, drag across statuses (board columns or list sections), animated drag overlay, keyboard-accessible (Space to lift, arrows to move)
- Task details: **priority (High/Medium/Low)**, assignee, due dates (overdue is called out), description
- **Rename & edit projects** — click the project title (or the ⋯ menu / sidebar row → Edit) to change name, description, icon, accent, or **priority (High/Medium/Low)**, shown as a badge next to the project name
- **Board and List views**, filters by assignee & priority, live progress bar
- Quick-add directly into any column

### 🔐 Proper RBAC
Roles are **first-class, admin-editable entities** — not hardcoded strings:

- **Custom roles**: admins create roles (name, color, description, permission set) on the People page — e.g. a "Moderator" who can delete anyone's messages, or a "Contractor" with task access but no channels. Assign any role to any teammate.
- **System roles**: Admin, Member, and Guest ship built-in. Admin is *locked* at full access (can't be edited or deleted — a workspace can never lock itself out); Member and Guest are editable starting points.
- **Enforcement in the store, not the UI**: every mutation (send, create, move, delete, role changes) is guarded at the action layer and denied with a toast if the acting role lacks the permission. Hiding buttons is cosmetic on top of real enforcement.
- **Safety invariants**: can't demote the last admin, can't change your own role, can't delete built-in roles or roles that still have members.
- **Audit trail**: every role/permission change lands in the activity feed.
- **Delete channels & projects**: anyone with the permission (admins by default) gets a hover **⋯ → Delete** on each sidebar channel/project row — plus the existing chat-header and project-page menus. Deletes are confirmed first and cascade (a channel takes its messages, a project takes its tasks). `#general` is protected.

#### 📎 Files & sharing
- **Project files** — every project has a **Files** tab (briefs, mockups, reference docs; 3 MB per file, stored in your browser). Task dialogs have the same attachment field.
- **Share to chat** — hover a project file → **Share** → pick a channel or a person, add an optional note, and it lands in that conversation as a downloadable attachment (images preview inline) with a "from 🎨 Project" link back. Shared files are *references*, not copies: nothing is stored twice, and if the file is later removed from the project the message says so.
- **Attach in the composer** — the 📎 button in any channel or DM attaches files directly to a message (no text required). Viewer-only members can download but not post.

## 🔒 Per-resource access control
Beyond role-wide permissions, any channel or project can be **restricted to specific people at a specific level** — a finer grain than "Member vs Guest":

- **Manage access** — from a channel's ⋯ menu or a project's ⋯ menu / sidebar row, flip "Restrict access" on and invite exactly who should see it, each as **Editor** (full access) or **Viewer** (read-only).
- **Viewers can see, not touch**: in a restricted channel their composer is disabled ("view-only access"); in a restricted project their board/list turn read-only (no drag, no New task, no editing) and any task dialog opens in view-only mode — enforced in the store, not just the UI.
- **Non-invited people don't even see it exists**: the channel/project disappears from the sidebar, ⌘K, and direct links land on a clear "this is restricted" page — mirroring the existing private-channel pattern.
- **The owner can't lock themselves out**: whoever created the resource is always kept as an Editor, non-removable, when access is restricted.
- **Admins always bypass** restrictions (same `members.manage` escape hatch used everywhere else in RBAC), so the workspace never becomes unmanageable.

Default matrix (11 permissions across Chat, Tasks & projects, Administration):

| Capability | Admin 🔒 | Member | Guest |
|---|:-:|:-:|:-:|
| Post in channels, create channels | ✓ | ✓ | post only |
| Create / edit / move tasks | ✓ | ✓ | view-only |
| Delete tasks, manage projects | ✓ | — | — |
| Moderate (delete channels / any message) | ✓ | — | — |
| Manage members, roles & permissions | ✓ | — | — |

Direct messages are always available to everyone. Use the sidebar user card (or ⌘K → "View as") to experience the app as any role.

### ⚡ The pro feel
- **⌘K / Ctrl+K command palette** (cmdk): jump anywhere, create anything, switch theme or identity
- **Dark mode** (system-aware)
- Gorgeous toasts (sonner), subtle motion (framer-motion), keyboard-friendly throughout
- Home dashboard: personal stats, "My tasks" with one-click complete, team activity feed

## Tech stack

- **Next.js 15** (App Router) + **TypeScript** (strict)
- **Tailwind CSS v4** + **shadcn/ui** (Dialog, Sheet, Tabs, DropdownMenu, Avatar, Badge, Command, …)
- **lucide-react** icons
- **@dnd-kit** core/sortable/utilities for accessible drag & drop
- **date-fns**, **sonner**, **cmdk**, **framer-motion**
- Persistence: React state + **localStorage** (survives refresh; no backend in v1 — designed to migrate to Supabase later)

## Getting started

```bash
npm install lucide-react date-fns sonner cmdk @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities framer-motion
```

Then:

```bash
npm install
npm run dev
```

Open [http://localhost:3000/lumina](http://localhost:3000/lumina) (the app is served under the `/lumina` base path, matching the hosted site). The app boots with a realistic seeded workspace (6 people, 5 channels, 2 projects, 21 tasks). Everything you do persists to localStorage — use the sidebar user menu → **Reset demo data** to start fresh.

## Deploying

The app is a fully static export (`output: "export"`, `basePath: "/lumina"`) hosted on **GitHub Pages**. Every push to `main` runs `.github/workflows/deploy.yml`, which builds `out/` and publishes it to https://tomit1980.github.io/lumina/.

Preview the exact production build locally:

```bash
npm run build && npm start   # serves out/ at http://localhost:3000/lumina/
```

Because there is no server, resources are addressed as static pages plus a query (`/chat?id=…`, `/dm?id=…`, `/projects?id=…`) — build links with the helpers in `lib/routes.ts`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette |
| `Enter` | Send message / save |
| `Shift+Enter` | New line in composer |
| `Esc` | Cancel editing / close dialogs |

## Architecture notes

- `lib/store.tsx` — single source of truth: a React context store hydrated from localStorage, persisted on every change. All mutations (messages, tasks, roles, …) are pure functional updates, so migrating to Supabase later means swapping this one file's internals.
- `lib/permissions.ts` — permission vocabulary + seeded system roles. Roles live in state (`state.roles`) as editable entities; checks go through `can()` from `useStore()`, and every store mutation re-checks permissions server-style before applying.
- `lib/seed.ts` — deterministic, believable demo data with relative timestamps.
- `components/ui-context.tsx` — global UI state (command palette, task/channel/project dialogs) so anything can be created from anywhere.

## Roadmap (v2)

- Supabase backend: auth, Postgres, realtime channels
- Threads, file attachments, link unfurls
- Task comments & mentions → notifications
- Multi-workspace support
