"use client";

import * as React from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatusesSection } from "@/components/settings/statuses-section";
import { WorkspacePeople } from "@/components/settings/workspace-people";
import { useCurrentRoute } from "@/lib/routes";
import { settingsHref, type SettingsTab } from "@/lib/routes";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * One place to manage the workspace.
 *
 * Before this there was nowhere: role and permission editing lived on the
 * People page, and everything else was in an account dropdown. People is now
 * the Members section here — a change of address, not of behaviour — and
 * `/people` redirects.
 *
 * The tab lives in a query param rather than a path segment because Lumina is
 * a static export: `lib/routes.ts` addresses every resource that way, and a
 * dynamic segment would need a server. It also means a tab is linkable, which
 * a dialog would not have been.
 */
const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "members", label: "Members" },
  { id: "roles", label: "Roles & permissions" },
  { id: "statuses", label: "Board columns" },
];

export default function SettingsPage() {
  const { state, can } = useStore();
  const { tab } = useCurrentRoute();
  const active: SettingsTab =
    tab === "roles" || tab === "statuses" ? tab : "members";

  const manageRoles = can("members.manage");
  const mayEditStatuses = can("workspace.statuses");

  // The Board columns tab is Owner-only, so it is not offered to anybody
  // else. The section refuses on its own too — this is the cosmetic half of
  // a rule the database actually keeps.
  const visible = TABS.filter((t) => t.id !== "statuses" || mayEditStatuses);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
            <p className="text-[13px] text-muted-foreground">
              {state.users.length} teammates across {state.roles.length} roles
            </p>
          </div>
          {manageRoles && (
            <Badge variant="outline" className="ml-auto gap-1 text-[11px]">
              <ShieldCheck className="size-3 text-violet-500" />
              You can manage roles &amp; permissions
            </Badge>
          )}
        </div>

        <div className="mt-5 flex gap-1 border-b">
          {visible.map((t) => (
            <Link
              key={t.id}
              href={settingsHref(t.id)}
              aria-current={active === t.id ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
                active === t.id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>

        <div className="mt-6">
          {active === "statuses" ? (
            <StatusesSection />
          ) : (
            <WorkspacePeople section={active} />
          )}
        </div>
      </div>
    </div>
  );
}
