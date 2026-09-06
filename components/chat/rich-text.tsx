"use client";

import * as React from "react";
import type { User } from "@/lib/types";

const TOKEN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|@[a-z0-9_.-]+)/gi;

/** Minimal chat formatting: `code`, **bold**, *italic*, and @mentions. */
export function RichText({
  content,
  users,
  currentUserId,
}: {
  content: string;
  users: User[];
  currentUserId: string;
}) {
  const nodes = React.useMemo(() => {
    const parts = content.split(TOKEN);
    return parts.map((part, i) => {
      if (!part) return null;
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return (
          <code
            key={i}
            className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-rose-600 dark:text-rose-400"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        return (
          <strong key={i} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
        return <em key={i}>{part.slice(1, -1)}</em>;
      }
      if (part.startsWith("@")) {
        const handle = part.slice(1).toLowerCase();
        const user = users.find((u) => u.handle === handle);
        if (user) {
          const isMe = user.id === currentUserId;
          return (
            <span
              key={i}
              className={
                isMe
                  ? "rounded bg-amber-400/25 px-1 py-0.5 font-medium text-amber-700 dark:text-amber-300"
                  : "rounded bg-primary/10 px-1 py-0.5 font-medium text-primary"
              }
            >
              @{user.handle}
            </span>
          );
        }
      }
      return <React.Fragment key={i}>{part}</React.Fragment>;
    });
  }, [content, users, currentUserId]);

  return <span className="whitespace-pre-wrap break-words">{nodes}</span>;
}
