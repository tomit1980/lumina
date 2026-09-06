"use client";

import { Badge } from "@/components/ui/badge";
import type { RoleDef } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Role pill tinted with the role's own color — works for custom roles too. */
export function RoleBadge({
  role,
  className,
}: {
  role: RoleDef;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] font-medium", className)}
      style={{
        backgroundColor: `${role.color}1a`,
        color: role.color,
        borderColor: `${role.color}4d`,
      }}
    >
      {role.name}
    </Badge>
  );
}
