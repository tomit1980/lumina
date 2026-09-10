import { DEFAULT_ROLES } from "./permissions";
import { DEFAULT_STATUSES } from "./statuses";
import type { AppState, DM, Message, Task } from "./types";

// 14: statuses became rows (`AppState.statuses`) instead of a hardcoded
// union, and the Owner role joined the seeded three.
export const SEED_VERSION = 14;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function midnightPlus(days: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + days * DAY;
}

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}_seed_${seq}`;
}

export function createSeed(): AppState {
  seq = 0;
  const now = Date.now();

  const users = [
    // The Owner. Seeded so the top role can be signed into and seen on the
    // demo path with no setup at all — on Supabase there is no equivalent,
    // and the runbook covers promoting a real account instead.
    {
      id: "u_owner",
      name: "Dana Levi",
      handle: "owner",
      title: "Founder",
      roleId: "owner",
      color: "#f43f5e",
      presence: "online" as const,
    },
    {
      id: "u_vlad",
      name: "Moshe Cohen",
      handle: "moshe",
      title: "Engineering Lead",
      roleId: "admin",
      color: "#6366f1",
      presence: "online" as const,
    },
    {
      id: "u_maya",
      name: "Maya Chen",
      handle: "maya",
      title: "Product Designer",
      roleId: "member",
      color: "#ec4899",
      presence: "online" as const,
    },
    {
      id: "u_jonas",
      name: "Jonas Weber",
      handle: "jonas",
      title: "Frontend Engineer",
      roleId: "member",
      color: "#f59e0b",
      presence: "away" as const,
    },
    {
      id: "u_priya",
      name: "Priya Sharma",
      handle: "priya",
      title: "Backend Engineer",
      roleId: "member",
      color: "#10b981",
      presence: "online" as const,
    },
    {
      id: "u_sam",
      name: "Sam Okafor",
      handle: "sam",
      title: "Product Manager",
      roleId: "member",
      color: "#0ea5e9",
      presence: "offline" as const,
    },
    {
      id: "u_elena",
      name: "Elena Rossi",
      handle: "elena",
      title: "Brand Consultant",
      roleId: "guest",
      color: "#8b5cf6",
      presence: "away" as const,
    },
  ];

  const channels = [
    {
      id: "c_general",
      name: "general",
      description: "Everyone at Northlight Studio — announcements and team chatter",
      isPrivate: false,
      isTeam: true,
      members: [],
      createdBy: "u_vlad",
      createdAt: now - 30 * DAY,
    },
    {
      id: "c_engineering",
      name: "engineering",
      description: "Ship it. Break it. Fix it. Ship it again.",
      isPrivate: false,
      members: [],
      createdBy: "u_vlad",
      createdAt: now - 30 * DAY,
    },
    {
      id: "c_design",
      name: "design",
      description: "Pixels, prototypes, and hot takes on border radii",
      isPrivate: false,
      members: [],
      createdBy: "u_maya",
      createdAt: now - 28 * DAY,
    },
    {
      id: "c_random",
      name: "random",
      description: "Everything that doesn't belong anywhere else",
      isPrivate: false,
      members: [],
      createdBy: "u_jonas",
      createdAt: now - 27 * DAY,
    },
    {
      id: "c_leadership",
      name: "leadership",
      description: "Planning, hiring, and the big picture",
      isPrivate: true,
      members: [
        { userId: "u_vlad", level: "editor" as const },
        { userId: "u_sam", level: "editor" as const },
      ],
      createdBy: "u_vlad",
      createdAt: now - 25 * DAY,
    },
  ];

  const msg = (
    channelId: string,
    authorId: string,
    content: string,
    agoHours: number,
    reactions: Message["reactions"] = []
  ): Message => ({
    id: id("m"),
    channelId,
    authorId,
    content,
    createdAt: now - agoHours * HOUR,
    reactions,
    attachments: [],
  });

  const messages: Message[] = [
    // #general — two days ago
    msg("c_general", "u_sam", "Morning team! Quick reminder that the **Q3 planning doc** is due Friday. Drop your section drafts in the thread when ready.", 52),
    msg("c_general", "u_maya", "On it — design section is about 80% there.", 51.8),
    msg("c_general", "u_vlad", "Engineering section is drafted. @sam want to sync for 15 min after standup?", 51.5, [
      { emoji: "👍", userIds: ["u_sam"] },
    ]),
    // #general — yesterday
    msg("c_general", "u_priya", "Heads up: staging will be down for ~10 minutes at noon while I rotate the database credentials.", 28),
    msg("c_general", "u_jonas", "Thanks for the warning 🙏", 27.9),
    msg("c_general", "u_sam", "Welcome @elena to the team! Elena is helping us with the brand refresh over the next few weeks. 🎉", 26, [
      { emoji: "🎉", userIds: ["u_vlad", "u_maya", "u_jonas", "u_priya"] },
      { emoji: "👋", userIds: ["u_maya"] },
    ]),
    msg("c_general", "u_elena", "Thrilled to be here! Already digging into the moodboards. If anyone has strong feelings about the current logo, my DMs are open 😄", 25.5, [
      { emoji: "❤️", userIds: ["u_sam", "u_maya"] },
    ]),
    // #general — today
    msg("c_general", "u_vlad", "Lumina v1 board is live under **Website Redesign** — everything for the launch is triaged there. Let's keep status updates on the cards.", 3, [
      { emoji: "🚀", userIds: ["u_maya", "u_priya", "u_sam"] },
    ]),
    msg("c_general", "u_maya", "Love it. The board columns map perfectly to our workflow now.", 2.5),

    // #engineering
    msg("c_engineering", "u_priya", "The new `/api/workspaces` endpoint is deployed to staging. Rate limiting is on, docs are in the README.", 30),
    msg("c_engineering", "u_jonas", "Nice! Integrating it into the sidebar fetch this afternoon.", 29.5, [
      { emoji: "🚀", userIds: ["u_priya"] },
    ]),
    msg("c_engineering", "u_jonas", "Found the layout shift bug — it was the font swap on the marketing page. Fix is in review: `fix/font-swap-cls`.", 6, [
      { emoji: "🎉", userIds: ["u_vlad"] },
    ]),
    msg("c_engineering", "u_vlad", "Reviewing now. If CI is green we can ship it with today's release train.", 5.5),
    msg("c_engineering", "u_priya", "Reminder: we're freezing deploys Friday 4pm for the migration. Anything not merged by then waits until Monday.", 1.5),

    // #design
    msg("c_design", "u_maya", "New empty-state illustrations are in Figma — page \"v2 / Empty states\". Went for something warmer this time.", 26),
    msg("c_design", "u_elena", "These are gorgeous. The onboarding one especially 👌", 25, [
      { emoji: "❤️", userIds: ["u_maya"] },
    ]),
    msg("c_design", "u_maya", "Proposal: we bump the base radius from 6px to 10px across the app. Softer, friendlier, very 2026.", 4, [
      { emoji: "👍", userIds: ["u_jonas", "u_elena"] },
      { emoji: "👀", userIds: ["u_vlad"] },
    ]),
    msg("c_design", "u_jonas", "As the person who has to change every component: *cautiously* in favor 😅", 3.5, [
      { emoji: "😂", userIds: ["u_maya", "u_elena"] },
    ]),

    // #random
    msg("c_random", "u_jonas", "Important poll: is a hot dog a sandwich? This decides nothing but I need to know who I'm working with.", 24, [
      { emoji: "😂", userIds: ["u_maya", "u_priya", "u_sam"] },
    ]),
    msg("c_random", "u_priya", "It's a taco. Fight me.", 23.8, [
      { emoji: "😂", userIds: ["u_jonas"] },
      { emoji: "👀", userIds: ["u_vlad"] },
    ]),
    msg("c_random", "u_sam", "Friday team lunch is booked — that new ramen place on 5th at 12:30. Calendar invites going out.", 2, [
      { emoji: "🎉", userIds: ["u_jonas", "u_maya", "u_priya", "u_vlad"] },
    ]),

    // #leadership (private)
    msg("c_leadership", "u_sam", "Offer went out to the senior backend candidate this morning. Fingers crossed 🤞", 22),
    msg("c_leadership", "u_vlad", "Great. If they accept we should revisit the Q3 capacity plan — we'd have room to pull the mobile milestone forward.", 21.5, [
      { emoji: "👍", userIds: ["u_sam"] },
    ]),

    // DM: Moshe ↔ Maya
    msg("d_vlad_maya", "u_maya", "Hey! Got 10 minutes today to look at the hero explorations? I want your eye on direction B before I share it wider.", 7),
    msg("d_vlad_maya", "u_vlad", "Sure — right after lunch? Direction B was my favorite from the thumbnails.", 6.8, [
      { emoji: "👍", userIds: ["u_maya"] },
    ]),
    msg("d_vlad_maya", "u_maya", "It works! I'll grab a room. Also sneaking in a *tiny* radius bump to the cards, don't tell Jonas 😄", 0.5),

    // DM: Moshe ↔ Priya
    msg("d_vlad_priya", "u_priya", "Migration runbook is ready for review whenever you have a sec. I'd like a second pair of eyes on the rollback steps.", 26),
    msg("d_vlad_priya", "u_vlad", "On it this afternoon. Nice work getting it done before the freeze 🚀", 25.5, [
      { emoji: "❤️", userIds: ["u_priya"] },
    ]),
  ];

  const dms: DM[] = [
    { id: "d_vlad_maya", memberIds: ["u_vlad", "u_maya"], createdAt: now - 8 * DAY },
    { id: "d_vlad_priya", memberIds: ["u_vlad", "u_priya"], createdAt: now - 5 * DAY },
  ];

  const projects = [
    {
      id: "p_website",
      name: "Website Redesign",
      description: "Marketing site refresh for the summer launch",
      emoji: "🎨",
      color: "#8b5cf6",
      priority: "high" as const,
      restricted: false,
      members: [],
      attachments: [],
      createdBy: "u_vlad",
      createdAt: now - 20 * DAY,
    },
    {
      id: "p_mobile",
      name: "Mobile App v2",
      description: "Native companion app — offline-first, push, widgets",
      emoji: "📱",
      color: "#0ea5e9",
      priority: "medium" as const,
      restricted: false,
      members: [],
      attachments: [],
      createdBy: "u_sam",
      createdAt: now - 12 * DAY,
    },
  ];

  let orderCounters: Record<string, number> = {};
  const task = (
    projectId: string,
    title: string,
    status: Task["status"],
    priority: Task["priority"],
    opts: Partial<
      Pick<
        Task,
        | "description"
        | "assigneeId"
        | "dueDate"
        | "labels"
        | "startTime"
        | "durationMinutes"
        | "reminderMinutes"
        | "collaboratorIds"
      >
    > = {}
  ): Task => {
    const key = `${projectId}:${status}`;
    const order = orderCounters[key] ?? 0;
    orderCounters[key] = order + 1;
    return {
      id: id("t"),
      projectId,
      title,
      description: opts.description ?? "",
      status,
      priority,
      assigneeId: opts.assigneeId ?? null,
      dueDate: opts.dueDate ?? null,
      startTime: opts.startTime ?? null,
      durationMinutes: opts.durationMinutes ?? null,
      reminderMinutes: opts.reminderMinutes ?? null,
      labels: opts.labels ?? [],
      attachments: [],
      order,
      createdAt: now - 10 * DAY,
      createdBy: "u_vlad",
      collaboratorIds: opts.collaboratorIds ?? [],
    };
  };

  orderCounters = {};
  const tasks: Task[] = [
    // Website Redesign
    task("p_website", "Audit current site analytics & drop-off points", "done", "medium", {
      assigneeId: "u_sam", labels: ["research"],
    }),
    task("p_website", "Define new information architecture", "done", "high", {
      assigneeId: "u_maya", labels: ["design", "research"],
    }),
    task("p_website", "Design system tokens: color, type, spacing", "done", "high", {
      assigneeId: "u_maya", labels: ["design"],
    }),
    task("p_website", "Homepage hero — copy & layout exploration", "in-review", "high", {
      assigneeId: "u_maya",
      dueDate: midnightPlus(1),
      labels: ["design", "copy"],
      description: "Three directions explored in Figma. Needs sign-off from Sam before build starts.",
      collaboratorIds: ["u_sam", "u_elena"],
    }),
    task("p_website", "Fix font-swap layout shift on marketing pages", "in-review", "high", {
      assigneeId: "u_jonas", dueDate: midnightPlus(0), labels: ["bug", "frontend"],
      description: "CLS spikes to 0.31 on slow 3G. Branch: fix/font-swap-cls",
    }),
    task("p_website", "Build responsive nav + mobile menu", "in-progress", "high", {
      assigneeId: "u_jonas", dueDate: midnightPlus(2), labels: ["frontend"],
      collaboratorIds: ["u_priya"],
    }),
    task("p_website", "Pricing page — interactive plan comparison", "in-progress", "medium", {
      assigneeId: "u_jonas", dueDate: midnightPlus(5), labels: ["frontend", "design"],
    }),
    task("p_website", "CMS migration plan for blog content", "todo", "medium", {
      assigneeId: "u_priya", dueDate: midnightPlus(7), labels: ["backend", "content"],
    }),
    task("p_website", "Customer logos & testimonial curation", "todo", "low", {
      assigneeId: "u_elena", labels: ["brand", "content"],
    }),
    task("p_website", "SEO pass: meta, sitemap, structured data", "todo", "high", {
      assigneeId: "u_vlad", dueDate: midnightPlus(9), labels: ["marketing"],
      startTime: "10:00", durationMinutes: 30, reminderMinutes: 30,
    }),
    task("p_website", "Set up preview deployments & CI for the new site", "in-progress", "high", {
      assigneeId: "u_vlad", dueDate: midnightPlus(3), labels: ["frontend", "api"],
      startTime: "15:30", durationMinutes: 60, reminderMinutes: 15,
    }),
    task("p_website", "Launch-day social & email assets", "backlog", "medium", {
      assigneeId: "u_elena", labels: ["brand", "marketing"],
    }),
    task("p_website", "A/B test plan for new homepage", "backlog", "low", {
      assigneeId: "u_sam", labels: ["research", "marketing"],
    }),
    task("p_website", "Dark mode for marketing site", "backlog", "low", {
      labels: ["design", "frontend"],
    }),

    // Mobile App v2
    task("p_mobile", "Technical spike: offline sync strategy", "done", "high", {
      assigneeId: "u_priya", labels: ["research", "backend"],
      description: "Compared CRDT vs. server-authoritative diff sync. Decision memo in Notion.",
    }),
    task("p_mobile", "API: push notification service", "in-progress", "high", {
      assigneeId: "u_priya", dueDate: midnightPlus(4), labels: ["backend", "api"],
      collaboratorIds: ["u_vlad", "u_jonas"],
    }),
    task("p_mobile", "On-device cache layer & conflict resolution", "in-progress", "high", {
      assigneeId: "u_priya", dueDate: midnightPlus(6), labels: ["backend"],
    }),
    task("p_mobile", "Design: home screen widgets (iOS & Android)", "todo", "medium", {
      assigneeId: "u_maya", dueDate: midnightPlus(8), labels: ["design"],
    }),
    task("p_mobile", "Deep linking & universal links", "todo", "medium", {
      assigneeId: "u_jonas", labels: ["frontend", "api"],
    }),
    task("p_mobile", "Review offline sync architecture proposal", "todo", "high", {
      assigneeId: "u_vlad", dueDate: midnightPlus(2), labels: ["research", "backend"],
      startTime: "14:00", durationMinutes: 45, reminderMinutes: 10,
    }),
    task("p_mobile", "Beta program: recruit 50 external testers", "todo", "high", {
      assigneeId: "u_sam", dueDate: midnightPlus(10), labels: ["research"],
    }),
    task("p_mobile", "App Store listing: screenshots & copy", "backlog", "low", {
      assigneeId: "u_elena", labels: ["brand", "marketing"],
    }),
    task("p_mobile", "Accessibility audit (VoiceOver / TalkBack)", "backlog", "medium", {
      labels: ["frontend"],
    }),
  ];

  // Every seeded row carries its scope explicitly (SEED_VERSION 12): the two
  // task lines name p_website, the two message lines name the channel they
  // happened in, and the member line names nothing because a membership change
  // is workspace-wide. None of them name c_leadership, the one private channel
  // in the seed — a seeded activity naming it would be the very leak
  // 20260909000900_activity_scope.sql closes.
  const activities = [
    {
      id: id("a"), ts: now - 26 * HOUR, actorId: "u_sam",
      text: "added Elena Rossi as a guest", kind: "member" as const,
      projectId: null, conversationId: null,
    },
    {
      id: id("a"), ts: now - 6 * HOUR, actorId: "u_jonas",
      text: "moved “Fix font-swap layout shift” to In Review", kind: "task" as const,
      projectId: "p_website", conversationId: null,
    },
    {
      id: id("a"), ts: now - 4 * HOUR, actorId: "u_maya",
      text: "completed “Design system tokens: color, type, spacing”", kind: "task" as const,
      projectId: "p_website", conversationId: null,
    },
    {
      id: id("a"), ts: now - 3 * HOUR, actorId: "u_vlad",
      text: "posted an update in #general", kind: "message" as const,
      projectId: null, conversationId: "c_general",
    },
    {
      id: id("a"), ts: now - 1.5 * HOUR, actorId: "u_priya",
      text: "announced the Friday deploy freeze in #engineering", kind: "message" as const,
      projectId: null, conversationId: "c_engineering",
    },
  ];

  // Everything except the latest few messages starts read for everyone.
  const lastRead: Record<string, number> = {};
  for (const u of users) {
    for (const conv of [...channels, ...dms]) {
      lastRead[`${u.id}:${conv.id}`] = u.id === "u_vlad" ? now - 4 * HOUR : now;
    }
  }
  // Moshe has caught up on general but not the others — and Maya's latest DM is new.
  lastRead["u_vlad:c_general"] = now;
  lastRead["u_vlad:d_vlad_maya"] = now - 1 * HOUR;
  lastRead["u_vlad:d_vlad_priya"] = now;

  return {
    version: SEED_VERSION,
    currentUserId: "u_vlad",
    users,
    channels,
    dms,
    messages,
    projects,
    tasks,
    activities,
    roles: DEFAULT_ROLES.map((r) => ({ ...r, permissions: [...r.permissions] })),
    statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
    lastRead,
  };
}
